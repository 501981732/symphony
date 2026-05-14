/**
 * Minimal fake GitLab REST server used by E2E tests.
 *
 * Implements only the endpoints actually exercised by `@issuepilot/tracker-gitlab`:
 *   GET    /api/v4/projects/:id/issues
 *   GET    /api/v4/projects/:id/issues/:iid
 *   PUT    /api/v4/projects/:id/issues/:iid
 *   GET    /api/v4/projects/:id/issues/:iid/notes
 *   POST   /api/v4/projects/:id/issues/:iid/notes
 *   PUT    /api/v4/projects/:id/issues/:iid/notes/:note_id
 *   GET    /api/v4/projects/:id/merge_requests
 *   POST   /api/v4/projects/:id/merge_requests
 *   GET    /api/v4/projects/:id/merge_requests/:iid
 *   PUT    /api/v4/projects/:id/merge_requests/:iid
 *   GET    /api/v4/projects/:id/merge_requests/:iid/notes
 *   GET    /api/v4/projects/:id/pipelines
 *
 * The intention is to be just realistic enough that `@gitbeaker/rest` calls
 * succeed end-to-end; nothing here is meant to fully emulate GitLab.
 */

import Fastify, { type FastifyInstance } from "fastify";

import type { AddressInfo } from "node:net";

import {
  bumpIssueUpdatedAt,
  type GitLabFakeState,
  type RawIssueNoteRow,
  type RawIssueRow,
  type RawMergeRequestRow,
  type RawPipelineRow,
} from "./data.js";

export interface StartGitLabFakeServerInput {
  state: GitLabFakeState;
  /** Token clients must present in `Authorization: Bearer ...`. */
  token: string;
  /** Optional port override. Defaults to ephemeral. */
  port?: number;
  /** Force a 4xx/5xx status for the next request to this path prefix. */
  faults?: ServerFault[];
}

export interface ServerFault {
  /** Path prefix to match (e.g. "/api/v4/projects"). Exact prefix match. */
  pathPrefix: string;
  /** HTTP method, defaults to ALL. */
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** HTTP status code to return. */
  status: number;
  /** Optional body to include. */
  body?: unknown;
  /** Once `consume` requests have hit this fault it is removed. Default 1. */
  consume?: number;
}

export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export interface GitLabFakeServer {
  readonly baseUrl: string;
  readonly state: GitLabFakeState;
  readonly app: FastifyInstance;
  /**
   * Install a request fault that will return a non-2xx response for the next
   * `consume` requests matching the given prefix.
   */
  injectFault(fault: ServerFault): void;
  /** Resolve once `predicate(state)` returns true; reject after timeout. */
  waitFor(
    predicate: (state: GitLabFakeState) => boolean,
    opts?: WaitForOptions,
  ): Promise<true>;
  close(): Promise<void>;
}

interface Params {
  id?: string;
  iid?: string;
  note_id?: string;
}

interface IssueQuery {
  state?: string;
  labels?: string;
  per_page?: string;
  order_by?: string;
  sort?: string;
}

interface MergeRequestQuery {
  source_branch?: string;
  state?: string;
  per_page?: string;
}

interface PipelineQuery {
  ref?: string;
  per_page?: string;
  order_by?: string;
  sort?: string;
}

interface UpdateIssueBody {
  labels?: string | string[];
  remove_labels?: string | string[];
  removeLabels?: string | string[];
  state_event?: "close" | "reopen";
  stateEvent?: "close" | "reopen";
}

interface UpdateIssueQuery {
  labels?: string;
  remove_labels?: string;
  removeLabels?: string;
  state_event?: "close" | "reopen";
  stateEvent?: "close" | "reopen";
}

interface CreateNoteBody {
  body?: string;
}

interface CreateMergeRequestBody {
  source_branch?: string;
  target_branch?: string;
  title?: string;
  description?: string;
}

interface UpdateMergeRequestBody {
  title?: string;
  description?: string;
  target_branch?: string;
}

const FAKE_AUTHOR = { username: "ai-bot", name: "IssuePilot Bot" } as const;

function nowIso() {
  return new Date().toISOString();
}

function toLabelArray(labels: string | string[] | undefined): string[] {
  if (labels === undefined) return [];
  if (Array.isArray(labels)) return [...labels];
  return labels
    .split(",")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function dedupe<T>(arr: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of arr) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function nextMrIid(state: GitLabFakeState): number {
  let max = 0;
  for (const mr of state.mergeRequests.values()) {
    if (mr.iid > max) max = mr.iid;
  }
  return max + 1;
}

/**
 * Match a request URL against a fault's path prefix. We accept the prefix
 * itself, the prefix followed by a path separator (`/...`), and the prefix
 * followed by a query string (`?...`). This avoids the over-match that
 * naive `startsWith` causes — `/issues/12` would otherwise gobble up
 * `/issues/12/notes`, `/issues/12/notes/123`, and `/issues/120`.
 */
function pathMatchesFault(url: string, prefix: string): boolean {
  if (url === prefix) return true;
  if (url.startsWith(prefix + "/")) return true;
  if (url.startsWith(prefix + "?")) return true;
  return false;
}

export async function startGitLabFakeServer(
  input: StartGitLabFakeServerInput,
): Promise<GitLabFakeServer> {
  const { state, token } = input;
  const faults: ServerFault[] = [...(input.faults ?? [])];
  const app = Fastify({ logger: false });

  // Auth + fault preHandler.
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/_health")) return;
    const header = req.headers["authorization"];
    const presented =
      typeof header === "string" ? header.replace(/^Bearer\s+/i, "") : "";
    const privateToken = req.headers["private-token"];
    const candidate =
      presented || (typeof privateToken === "string" ? privateToken : "");
    if (candidate !== token) {
      reply.code(401).send({ message: "401 Unauthorized" });
      return reply;
    }
    for (let i = 0; i < faults.length; i += 1) {
      const fault = faults[i];
      if (!fault) continue;
      const methodMatches =
        !fault.method ||
        req.method.toUpperCase() === fault.method.toUpperCase();
      if (methodMatches && pathMatchesFault(req.url, fault.pathPrefix)) {
        const consume = fault.consume ?? 1;
        if (consume <= 1) faults.splice(i, 1);
        else fault.consume = consume - 1;
        reply
          .code(fault.status)
          .send(fault.body ?? { message: `fault@${fault.status}` });
        return reply;
      }
    }
  });

  app.get("/_health", async () => ({ ok: true }));

  // Fastify already decodes individual URL segments, so `req.params.id` for
  // `/projects/demo%2Frepo/...` arrives as the literal "demo/repo" we want to
  // compare with `state.projectId`. No additional decoding required.
  function projectMatches(raw: string): boolean {
    return raw === state.projectId;
  }

  // GET /api/v4/projects/:id/issues
  app.get<{ Params: Params; Querystring: IssueQuery }>(
    "/api/v4/projects/:id/issues",
    async (req, reply) => {
      if (!projectMatches(req.params.id ?? "")) return reply.code(404).send({});
      const labelsFilter = toLabelArray(req.query.labels);
      const stateFilter = req.query.state;
      const orderBy = req.query.order_by ?? "updated_at";
      const sort = req.query.sort ?? "desc";
      const perPage = Number.parseInt(req.query.per_page ?? "20", 10);
      let rows = [...state.issues.values()];
      if (stateFilter) {
        rows = rows.filter((r) => r.state === stateFilter);
      }
      if (labelsFilter.length > 0) {
        rows = rows.filter((r) =>
          labelsFilter.every((l) => r.labels.includes(l)),
        );
      }
      rows.sort((a, b) => {
        const ak = orderBy === "iid" ? a.iid : a.updated_at;
        const bk = orderBy === "iid" ? b.iid : b.updated_at;
        const cmp = ak < bk ? -1 : ak > bk ? 1 : 0;
        return sort === "asc" ? cmp : -cmp;
      });
      return reply.send(rows.slice(0, perPage));
    },
  );

  // GET /api/v4/projects/:id/issues/:iid
  app.get<{ Params: Params }>(
    "/api/v4/projects/:id/issues/:iid",
    async (req, reply) => {
      if (!projectMatches(req.params.id ?? "")) return reply.code(404).send({});
      const iid = Number.parseInt(req.params.iid ?? "0", 10);
      const row = state.issues.get(iid);
      if (!row) return reply.code(404).send({ message: "Not Found" });
      return reply.send(row);
    },
  );

  // PUT /api/v4/projects/:id/issues/:iid
  app.put<{
    Params: Params;
    Body: UpdateIssueBody;
    Querystring: UpdateIssueQuery;
  }>("/api/v4/projects/:id/issues/:iid", async (req, reply) => {
    if (!projectMatches(req.params.id ?? "")) return reply.code(404).send({});
    const iid = Number.parseInt(req.params.iid ?? "0", 10);
    const row = state.issues.get(iid);
    if (!row) return reply.code(404).send({ message: "Not Found" });
    const labels = req.body.labels ?? req.query.labels;
    if (labels !== undefined) {
      row.labels = dedupe(toLabelArray(labels));
    }
    const removeLabels =
      req.body.remove_labels ??
      req.body.removeLabels ??
      req.query.remove_labels ??
      req.query.removeLabels;
    const labelsToRemove = toLabelArray(removeLabels);
    if (labelsToRemove.length > 0) {
      const removeSet = new Set(labelsToRemove);
      row.labels = row.labels.filter((label) => !removeSet.has(label));
    }
    const stateEvent =
      req.body.state_event ??
      req.body.stateEvent ??
      req.query.state_event ??
      req.query.stateEvent;
    if (stateEvent === "close") {
      row.state = "closed";
    } else if (stateEvent === "reopen") {
      row.state = "opened";
    }
    bumpIssueUpdatedAt(state, iid);
    return reply.send(row);
  });

  // GET /api/v4/projects/:id/issues/:iid/notes
  app.get<{ Params: Params }>(
    "/api/v4/projects/:id/issues/:iid/notes",
    async (req, reply) => {
      if (!projectMatches(req.params.id ?? "")) return reply.code(404).send({});
      const iid = Number.parseInt(req.params.iid ?? "0", 10);
      const list = state.notes.get(iid);
      if (!list) return reply.code(404).send({ message: "Not Found" });
      return reply.send(list);
    },
  );

  // POST /api/v4/projects/:id/issues/:iid/notes
  app.post<{ Params: Params; Body: CreateNoteBody }>(
    "/api/v4/projects/:id/issues/:iid/notes",
    async (req, reply) => {
      if (!projectMatches(req.params.id ?? "")) return reply.code(404).send({});
      const iid = Number.parseInt(req.params.iid ?? "0", 10);
      const list = state.notes.get(iid);
      if (!list) return reply.code(404).send({ message: "Not Found" });
      const body = (req.body?.body ?? "").toString();
      if (!body.trim())
        return reply.code(400).send({ message: "body required" });
      const now = nowIso();
      const note: RawIssueNoteRow = {
        id: state.nextId(),
        body,
        system: false,
        author: { ...FAKE_AUTHOR },
        created_at: now,
        updated_at: now,
      };
      list.push(note);
      bumpIssueUpdatedAt(state, iid);
      return reply.code(201).send(note);
    },
  );

  // PUT /api/v4/projects/:id/issues/:iid/notes/:note_id
  app.put<{ Params: Params; Body: CreateNoteBody }>(
    "/api/v4/projects/:id/issues/:iid/notes/:note_id",
    async (req, reply) => {
      if (!projectMatches(req.params.id ?? "")) return reply.code(404).send({});
      const iid = Number.parseInt(req.params.iid ?? "0", 10);
      const noteId = Number.parseInt(req.params.note_id ?? "0", 10);
      const list = state.notes.get(iid);
      if (!list) return reply.code(404).send({ message: "Not Found" });
      const note = list.find((n) => n.id === noteId);
      if (!note) return reply.code(404).send({ message: "Note Not Found" });
      if (req.body?.body !== undefined) note.body = req.body.body;
      note.updated_at = nowIso();
      bumpIssueUpdatedAt(state, iid);
      return reply.send(note);
    },
  );

  // GET /api/v4/projects/:id/merge_requests
  app.get<{ Params: Params; Querystring: MergeRequestQuery }>(
    "/api/v4/projects/:id/merge_requests",
    async (req, reply) => {
      if (!projectMatches(req.params.id ?? "")) return reply.code(404).send({});
      let rows = [...state.mergeRequests.values()];
      if (req.query.source_branch) {
        rows = rows.filter((r) => r.source_branch === req.query.source_branch);
      }
      if (req.query.state) {
        rows = rows.filter((r) => r.state === req.query.state);
      }
      rows.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      const perPage = Number.parseInt(req.query.per_page ?? "20", 10);
      return reply.send(rows.slice(0, perPage));
    },
  );

  // POST /api/v4/projects/:id/merge_requests
  app.post<{ Params: Params; Body: CreateMergeRequestBody }>(
    "/api/v4/projects/:id/merge_requests",
    async (req, reply) => {
      if (!projectMatches(req.params.id ?? "")) return reply.code(404).send({});
      const source = req.body.source_branch;
      const target = req.body.target_branch ?? "main";
      const title = req.body.title ?? "";
      if (!source || !title) {
        return reply
          .code(400)
          .send({ message: "source_branch and title required" });
      }
      const existing = state.mergeRequests.get(source);
      if (existing && existing.state === "opened") {
        return reply.code(409).send({ message: "open MR already exists" });
      }
      const now = nowIso();
      const iid = nextMrIid(state);
      const mr: RawMergeRequestRow = {
        id: state.nextId(),
        iid,
        project_id: state.projectNumericId,
        title,
        description: req.body.description ?? "",
        source_branch: source,
        target_branch: target,
        state: "opened",
        web_url: `${state.origin}/${state.projectId}/-/merge_requests/${iid}`,
        created_at: now,
        updated_at: now,
      };
      state.mergeRequests.set(source, mr);
      state.mergeRequestNotes.set(mr.iid, []);
      return reply.code(201).send(mr);
    },
  );

  // GET /api/v4/projects/:id/merge_requests/:iid
  app.get<{ Params: Params }>(
    "/api/v4/projects/:id/merge_requests/:iid",
    async (req, reply) => {
      if (!projectMatches(req.params.id ?? "")) return reply.code(404).send({});
      const iid = Number.parseInt(req.params.iid ?? "0", 10);
      const mr = findMrByIid(state, iid);
      if (!mr) return reply.code(404).send({ message: "Not Found" });
      return reply.send(mr);
    },
  );

  // PUT /api/v4/projects/:id/merge_requests/:iid
  app.put<{ Params: Params; Body: UpdateMergeRequestBody }>(
    "/api/v4/projects/:id/merge_requests/:iid",
    async (req, reply) => {
      if (!projectMatches(req.params.id ?? "")) return reply.code(404).send({});
      const iid = Number.parseInt(req.params.iid ?? "0", 10);
      const mr = findMrByIid(state, iid);
      if (!mr) return reply.code(404).send({ message: "Not Found" });
      if (req.body.title !== undefined) mr.title = req.body.title;
      if (req.body.description !== undefined)
        mr.description = req.body.description;
      if (req.body.target_branch !== undefined)
        mr.target_branch = req.body.target_branch;
      mr.updated_at = nowIso();
      return reply.send(mr);
    },
  );

  // GET /api/v4/projects/:id/merge_requests/:iid/notes
  app.get<{ Params: Params }>(
    "/api/v4/projects/:id/merge_requests/:iid/notes",
    async (req, reply) => {
      if (!projectMatches(req.params.id ?? "")) return reply.code(404).send({});
      const iid = Number.parseInt(req.params.iid ?? "0", 10);
      const list = state.mergeRequestNotes.get(iid);
      return reply.send(list ?? []);
    },
  );

  // GET /api/v4/projects/:id/pipelines
  app.get<{ Params: Params; Querystring: PipelineQuery }>(
    "/api/v4/projects/:id/pipelines",
    async (req, reply) => {
      if (!projectMatches(req.params.id ?? "")) return reply.code(404).send({});
      let rows: RawPipelineRow[] = [...state.pipelines];
      if (req.query.ref) {
        rows = rows.filter((r) => r.ref === req.query.ref);
      }
      const orderBy = req.query.order_by ?? "updated_at";
      const sort = req.query.sort ?? "desc";
      rows.sort((a, b) => {
        const ak = orderBy === "id" ? String(a.id) : a.updated_at;
        const bk = orderBy === "id" ? String(b.id) : b.updated_at;
        const cmp = ak < bk ? -1 : ak > bk ? 1 : 0;
        return sort === "asc" ? cmp : -cmp;
      });
      const perPage = Number.parseInt(req.query.per_page ?? "20", 10);
      return reply.send(rows.slice(0, perPage));
    },
  );

  await app.listen({ host: "127.0.0.1", port: input.port ?? 0 });
  const address = app.server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("fake GitLab server failed to bind to a port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const server: GitLabFakeServer = {
    baseUrl,
    state,
    app,
    injectFault(fault) {
      faults.push(fault);
    },
    async waitFor(predicate, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 5_000;
      const intervalMs = opts.intervalMs ?? 25;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(state)) return true;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    },
    async close() {
      await app.close();
    },
  };
  return server;
}

function findMrByIid(
  state: GitLabFakeState,
  iid: number,
): RawMergeRequestRow | undefined {
  for (const mr of state.mergeRequests.values()) {
    if (mr.iid === iid) return mr;
  }
  return undefined;
}

export type {
  RawIssueRow,
  RawIssueNoteRow,
  RawMergeRequestRow,
  RawPipelineRow,
};
