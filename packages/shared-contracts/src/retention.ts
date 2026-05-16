/**
 * Canonical workspace retention policy (V2 spec §11). The orchestrator
 * derives this from either `issuepilot.team.yaml > retention` (team mode)
 * or the `--workflow` front matter `retention` block (V1 fallback) and
 * passes it verbatim to the planner / executor in
 * `@issuepilot/workspace`. The shape lives in shared-contracts so the
 * planner does not have to take a dependency on either config loader.
 */
export interface RetentionConfig {
  /** Days a successful (closed / merged) run's workspace is kept. */
  successfulRunDays: number;
  /** Days a failed or blocked run's workspace is kept. */
  failedRunDays: number;
  /**
   * Hard cap on total workspace disk usage in gibibytes. When exceeded
   * the planner trims the oldest *already-expired* terminal runs, but
   * never deletes active runs or unexpired failure forensics — see V2
   * spec §11.
   */
  maxWorkspaceGb: number;
  /**
   * Minimum gap between two cleanup sweeps in milliseconds. The
   * orchestrator main loop checks this before invoking the executor so
   * cleanup never competes with the poll loop for IO.
   */
  cleanupIntervalMs: number;
}

/**
 * V2 spec §11 baseline retention. Kept here as a single source of truth
 * so both config parsers and the doctor CLI surface the same defaults
 * even when a user hands us an empty `retention:` block.
 */
export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  successfulRunDays: 7,
  failedRunDays: 30,
  maxWorkspaceGb: 50,
  cleanupIntervalMs: 3_600_000,
};
