import {
  redact,
  type EventBus,
  type EventRecord,
} from "@issuepilot/observability";
import type {
  ProjectSummary,
  TeamRuntimeSummary,
} from "@issuepilot/shared-contracts";
import Fastify, { type FastifyInstance } from "fastify";

import type { RuntimeState } from "../runtime/state.js";

export interface ServerDeps {
  state: RuntimeState;
  eventBus: EventBus<{
    id: string;
    runId: string;
    type: string;
    [key: string]: unknown;
  }>;
  readEvents: (
    runId: string,
    opts?: { limit?: number; offset?: number },
  ) => Promise<EventRecord[]>;
  readLogsTail?: (
    runId: string,
    opts?: { limit?: number },
  ) => Promise<string[]>;
  workflowPath: string;
  gitlabProject: string;
  handoffLabel?: string;
  pollIntervalMs: number;
  concurrency: number;
  /**
   * V2 team runtime rollups, included verbatim in `/api/state`. Accepts a
   * value or a getter; the getter form is evaluated on every request so the
   * snapshot reflects current lease/poll state instead of the initial value
   * captured at daemon start.
   */
  runtime?: TeamRuntimeSummary | (() => TeamRuntimeSummary);
  /** V2 team project rollups; same value-or-getter semantics as `runtime`. */
  projects?: ProjectSummary[] | (() => ProjectSummary[]);
}

function resolveSnapshotField<T>(
  value: T | (() => T) | undefined,
): T | undefined {
  if (value === undefined) return undefined;
  return typeof value === "function" ? (value as () => T)() : value;
}

function parseOptionalPositiveInt(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  return Number(value);
}

function parseOptionalNonNegativeInt(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value)) return undefined;
  return Number(value);
}

function eventCreatedAt(event: EventRecord): string | undefined {
  const value = event["createdAt"] ?? event["ts"];
  return typeof value === "string" ? value : undefined;
}

function compareEventTime(a: EventRecord, b: EventRecord): number {
  const aTime = Date.parse(eventCreatedAt(a) ?? "");
  const bTime = Date.parse(eventCreatedAt(b) ?? "");
  if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
  if (Number.isNaN(aTime)) return -1;
  if (Number.isNaN(bTime)) return 1;
  return aTime - bTime;
}

function summarizeLastEvent(
  events: EventRecord[],
): { type: string; message: string; createdAt?: string } | undefined {
  const last = [...events].sort(compareEventTime).at(-1);
  if (!last) return undefined;
  const createdAt = eventCreatedAt(last);
  return {
    type: last.type,
    message: last.message,
    ...(createdAt ? { createdAt } : {}),
  };
}

function countTurnEvents(events: EventRecord[]): number {
  return events.filter(
    (event) =>
      event.type.startsWith("turn_") || event.type.startsWith("codex_turn_"),
  ).length;
}

function enrichRunForDashboard<T extends Record<string, unknown>>(
  run: T,
  events: EventRecord[],
): T & {
  turnCount: number;
  lastEvent?: { type: string; message: string; createdAt?: string };
} {
  const lastEvent = summarizeLastEvent(events);
  return {
    ...run,
    turnCount: countTurnEvents(events),
    ...(lastEvent ? { lastEvent } : {}),
  };
}

function buildDashboardSummary(
  runs: Array<Record<string, unknown>>,
  handoffLabel: string,
): Record<string, number> {
  const summary = {
    running: 0,
    retrying: 0,
    "human-review": 0,
    failed: 0,
    blocked: 0,
  };

  for (const run of runs) {
    if (run["status"] === "running") summary.running += 1;
    if (run["status"] === "retrying") summary.retrying += 1;
    if (run["status"] === "failed") summary.failed += 1;
    if (run["status"] === "blocked") summary.blocked += 1;
    const issue = run["issue"];
    const labels =
      typeof issue === "object" && issue !== null && "labels" in issue
        ? (issue.labels as unknown)
        : undefined;
    if (Array.isArray(labels) && labels.includes(handoffLabel)) {
      summary["human-review"] += 1;
    }
  }

  return summary;
}

export async function createServer(
  deps: ServerDeps,
  opts: { host?: string; port?: number } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.addHook("onSend", async (_request, reply, payload) => {
    const contentType = String(reply.getHeader("content-type") ?? "");
    if (!contentType.includes("application/json")) return payload;

    const text = Buffer.isBuffer(payload) ? payload.toString("utf-8") : payload;
    if (typeof text !== "string" || text.length === 0) return payload;

    try {
      return JSON.stringify(redact(JSON.parse(text)));
    } catch {
      return payload;
    }
  });

  app.get("/api/state", async () => {
    const runtime = resolveSnapshotField(deps.runtime);
    const projects = resolveSnapshotField(deps.projects);
    return {
      service: {
        status: "ready",
        workflowPath: deps.workflowPath,
        gitlabProject: deps.gitlabProject,
        pollIntervalMs: deps.pollIntervalMs,
        concurrency: deps.concurrency,
        lastConfigReloadAt: deps.state.lastConfigReloadAt,
        lastPollAt: deps.state.lastPollAt,
      },
      summary: buildDashboardSummary(
        deps.state.allRuns(),
        deps.handoffLabel ?? "human-review",
      ),
      ...(runtime ? { runtime } : {}),
      ...(projects ? { projects } : {}),
    };
  });

  app.get<{ Querystring: { status?: string; limit?: string } }>(
    "/api/runs",
    async (request, reply) => {
      const status = request.query.status;
      const limit = parseOptionalPositiveInt(request.query.limit);
      if (request.query.limit !== undefined && limit === undefined) {
        return reply
          .code(400)
          .send({ error: "limit must be a positive integer" });
      }
      let runs = status ? deps.state.listRuns(status) : deps.state.allRuns();
      runs = runs.slice(0, limit ?? 50);
      return Promise.all(
        runs.map(async (run) =>
          enrichRunForDashboard(run, await deps.readEvents(run.runId)),
        ),
      );
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/api/runs/:runId",
    async (request, reply) => {
      const { runId } = request.params;
      const run = deps.state.getRun(runId);
      if (!run) {
        return reply.code(404).send({ error: "Run not found" });
      }
      const [events, logsTail] = await Promise.all([
        deps.readEvents(runId, { limit: 200 }),
        deps.readLogsTail?.(runId, { limit: 200 }) ?? Promise.resolve([]),
      ]);
      return { run: enrichRunForDashboard(run, events), events, logsTail };
    },
  );

  app.get<{
    Querystring: { runId?: string; limit?: string; offset?: string };
  }>("/api/events", async (request, reply) => {
    const runId = request.query.runId;
    if (!runId) {
      return reply.code(400).send({ error: "runId is required" });
    }

    const limit = parseOptionalPositiveInt(request.query.limit);
    if (request.query.limit !== undefined && limit === undefined) {
      return reply
        .code(400)
        .send({ error: "limit must be a positive integer" });
    }

    const offset = parseOptionalNonNegativeInt(request.query.offset);
    if (request.query.offset !== undefined && offset === undefined) {
      return reply
        .code(400)
        .send({ error: "offset must be a non-negative integer" });
    }

    const opts =
      offset === undefined
        ? { limit: limit ?? 100 }
        : {
            limit: limit ?? 100,
            offset,
          };

    return deps.readEvents(runId, opts);
  });

  app.get("/api/events/stream", (request, reply) => {
    const runIdFilter = (request.query as { runId?: string }).runId;

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const keepalive = setInterval(() => {
      reply.raw.write(": keepalive\n\n");
    }, 15_000);

    const unsub = deps.eventBus.subscribe(
      (event) => {
        reply.raw.write(`data: ${JSON.stringify(redact(event))}\n\n`);
      },
      runIdFilter ? (e) => e.runId === runIdFilter : undefined,
    );

    request.raw.on("close", () => {
      clearInterval(keepalive);
      unsub();
    });
    reply.raw.write(": connected\n\n");
  });

  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4738;
  await app.listen({ host, port });

  return app;
}
