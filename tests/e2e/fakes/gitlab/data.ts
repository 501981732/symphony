/**
 * In-memory backing store for the fake GitLab REST API surface used in E2E
 * tests. Everything here is plain data — no HTTP — so tests can seed and
 * inspect state directly without going through the server.
 */

export interface RawIssueRow {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string;
  state: "opened" | "closed";
  labels: string[];
  web_url: string;
  author: { username: string; name: string };
  assignees: Array<{ username: string; name: string }>;
  updated_at: string;
  created_at: string;
}

export interface RawIssueNoteRow {
  id: number;
  body: string;
  system: boolean;
  author: { username: string; name: string };
  created_at: string;
  updated_at: string;
}

export interface RawMergeRequestRow {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string;
  source_branch: string;
  target_branch: string;
  state: "opened" | "merged" | "closed";
  web_url: string;
  created_at: string;
  updated_at: string;
}

export interface RawPipelineRow {
  id: number;
  project_id: number;
  ref: string;
  sha: string;
  status:
    | "running"
    | "success"
    | "failed"
    | "pending"
    | "canceled"
    | "created"
    | "manual"
    | "scheduled"
    | "preparing"
    | "waiting_for_resource"
    | "skipped";
  updated_at: string;
  created_at: string;
}

export interface GitLabFakeStateOptions {
  projectId: string;
  /** Project numeric id used in GitLab payloads. Defaults to 1. */
  projectNumericId?: number;
  /** Origin used for web_url generation. Defaults to https://gitlab.example.com. */
  origin?: string;
}

export interface GitLabFakeState {
  projectId: string;
  projectNumericId: number;
  origin: string;
  issues: Map<number, RawIssueRow>;
  notes: Map<number, RawIssueNoteRow[]>;
  mergeRequests: Map<string, RawMergeRequestRow>;
  mergeRequestNotes: Map<number, RawIssueNoteRow[]>;
  pipelines: RawPipelineRow[];
  /** Monotonically increasing id allocator shared by all rows. */
  nextId: () => number;
}

const DEFAULT_ORIGIN = "https://gitlab.example.com";

export function createGitLabState(
  opts: GitLabFakeStateOptions,
): GitLabFakeState {
  let counter = 1000;
  return {
    projectId: opts.projectId,
    projectNumericId: opts.projectNumericId ?? 1,
    origin: opts.origin ?? DEFAULT_ORIGIN,
    issues: new Map(),
    notes: new Map(),
    mergeRequests: new Map(),
    mergeRequestNotes: new Map(),
    pipelines: [],
    nextId() {
      counter += 1;
      return counter;
    },
  };
}

export interface SeedIssueInput {
  iid: number;
  title: string;
  description?: string;
  labels?: string[];
  state?: "opened" | "closed";
  author?: { username?: string; name?: string };
  assignees?: Array<{ username?: string; name?: string }>;
}

export interface SeedGitLabInput {
  issues?: SeedIssueInput[];
}

export function seedGitLabState(
  state: GitLabFakeState,
  seed: SeedGitLabInput,
): void {
  for (const input of seed.issues ?? []) {
    if (state.issues.has(input.iid)) {
      throw new Error(`duplicate iid: ${input.iid}`);
    }
    const now = new Date().toISOString();
    const row: RawIssueRow = {
      id: state.nextId(),
      iid: input.iid,
      project_id: state.projectNumericId,
      title: input.title,
      description: input.description ?? "",
      state: input.state ?? "opened",
      labels: [...(input.labels ?? [])],
      web_url: `${state.origin}/${state.projectId}/-/issues/${input.iid}`,
      author: {
        username: input.author?.username ?? "seeder",
        name: input.author?.name ?? "Seeder",
      },
      assignees: (input.assignees ?? []).map((a) => ({
        username: a.username ?? "assignee",
        name: a.name ?? "Assignee",
      })),
      created_at: now,
      updated_at: now,
    };
    state.issues.set(input.iid, row);
    state.notes.set(input.iid, []);
  }
}

export function bumpIssueUpdatedAt(state: GitLabFakeState, iid: number): void {
  const row = state.issues.get(iid);
  if (row) {
    row.updated_at = new Date().toISOString();
  }
}
