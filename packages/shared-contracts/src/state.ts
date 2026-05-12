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
}
