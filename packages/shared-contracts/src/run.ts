import { type IssueRef } from "./issue.js";

/**
 * Lifecycle states reported by the orchestrator for an in-flight or finished
 * run. The state machine lives in `apps/orchestrator`; this is purely the
 * vocabulary shared with consumers (dashboard, tests).
 */
export const RUN_STATUS_VALUES = [
  "claimed",
  "running",
  "retrying",
  "completed",
  "failed",
  "blocked",
] as const;

export type RunStatus = (typeof RUN_STATUS_VALUES)[number];

export const isRunStatus = (value: unknown): value is RunStatus =>
  typeof value === "string" &&
  (RUN_STATUS_VALUES as readonly string[]).includes(value);

/**
 * Recorded shape of a single orchestrator attempt on an issue.
 *
 * `attempt` starts at 1; retries increment it. `lastError.code` is a stable
 * machine-readable identifier (see Phase 6 classifier) — UIs should display
 * `message` and route on `code`.
 */
export interface RunRecord {
  runId: string;
  issue: IssueRef;
  status: RunStatus;
  attempt: number;
  branch: string;
  workspacePath: string;
  /** Set after Phase 6 reconciliation creates or links the MR. */
  mergeRequestUrl?: string;
  /** ISO-8601 timestamp captured the moment the orchestrator claimed it. */
  startedAt: string;
  /** ISO-8601 timestamp refreshed on every status transition. */
  updatedAt: string;
  /** ISO-8601 timestamp set when the run leaves the active state machine. */
  endedAt?: string;
  /** Count of Codex turn events known to the dashboard snapshot. */
  turnCount?: number;
  /** Most recent event summary known to the dashboard snapshot. */
  lastEvent?: {
    type: string;
    message: string;
    createdAt?: string;
  };
  lastError?: {
    code: string;
    message: string;
  };
  /** V2 team mode: stable project id from `issuepilot.team.yaml`. */
  projectId?: string;
  /** V2 team mode: human-readable project name shown on the dashboard. */
  projectName?: string;
}
