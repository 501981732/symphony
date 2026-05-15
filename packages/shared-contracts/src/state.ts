export const DASHBOARD_SUMMARY_VALUES = [
  "running",
  "retrying",
  "human-review",
  "failed",
  "blocked",
] as const;

export type DashboardSummaryKey = (typeof DASHBOARD_SUMMARY_VALUES)[number];

export type DashboardSummary = Record<DashboardSummaryKey, number>;

/**
 * Daemon-level health flag exposed in `GET /api/state`.
 *  - starting:  process is initialising (loading workflow, opening clients)
 *  - ready:     polling loop is healthy
 *  - degraded:  partial failure; retry loop active but workflow stale or
 *               tracker errors elevated
 *  - stopping:  graceful shutdown in progress
 */
export const SERVICE_STATUS_VALUES = [
  "starting",
  "ready",
  "degraded",
  "stopping",
] as const;

export type ServiceStatus = (typeof SERVICE_STATUS_VALUES)[number];

export const isServiceStatus = (value: unknown): value is ServiceStatus =>
  typeof value === "string" &&
  (SERVICE_STATUS_VALUES as readonly string[]).includes(value);

export interface OrchestratorStateSnapshot {
  service: {
    status: ServiceStatus;
    /** Absolute path to the loaded `.agents/workflow.md`. */
    workflowPath: string;
    /** Project slug or numeric id, mirrored from workflow tracker config. */
    gitlabProject: string;
    pollIntervalMs: number;
    concurrency: number;
    /** ISO-8601 of the last successful hot-reload, or null. */
    lastConfigReloadAt: string | null;
    /** ISO-8601 of the most recent poll attempt, or null pre-start. */
    lastPollAt: string | null;
  };
  /** Spec §14 counters shown in the dashboard overview. */
  summary: DashboardSummary;
  /** V2 team runtime metadata; absent in single-workflow mode. */
  runtime?: TeamRuntimeSummary;
  /** V2 per-project rollups; absent in single-workflow mode. */
  projects?: ProjectSummary[];
}

/**
 * Why a project is currently inactive in the team registry. The two reasons
 * carry different operator semantics:
 *
 *  - `config`: project is intentionally disabled (`enabled: false` in
 *    `issuepilot.team.yaml`). No action required.
 *  - `load-error`: workflow file failed to load. Operator must fix the
 *    referenced WORKFLOW.md before the project can rejoin the schedule;
 *    `lastError` carries the failure detail.
 *
 * `disabledReason` is `undefined` when `enabled === true`.
 */
export type ProjectDisabledReason = "config" | "load-error";

/**
 * Per-project rollup used by the V2 team-operable dashboard.
 *
 * `enabled === false` means the project was declared in the team config but
 * could not be activated (disabled flag or workflow load failure); in that
 * case `lastError` carries the most recent load failure message.
 */
export interface ProjectSummary {
  id: string;
  name: string;
  workflowPath: string;
  gitlabProject: string;
  enabled: boolean;
  activeRuns: number;
  lastPollAt: string | null;
  lastError?: string;
  disabledReason?: ProjectDisabledReason;
}

/**
 * Aggregate counters for the V2 team runtime. `mode` reflects which daemon
 * entrypoint produced the snapshot (`single` for the V1 `--workflow` path,
 * `team` for the V2 `--config` path).
 */
export interface TeamRuntimeSummary {
  mode: "single" | "team";
  maxConcurrentRuns: number;
  activeLeases: number;
  projectCount: number;
}
