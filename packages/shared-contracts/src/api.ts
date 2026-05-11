import { type IssuePilotEvent } from "./events.js";
import { type RunRecord, type RunStatus } from "./run.js";

/**
 * Wire types for the local orchestrator HTTP surface. Phase 6 (Fastify)
 * implements the routes; the dashboard consumes the same types via
 * `apps/dashboard/lib/api.ts`. Keep these JSON-serialisable — no Dates,
 * no Maps, no class instances.
 */
export interface ListRunsQuery {
  status?: RunStatus | readonly RunStatus[];
  limit?: number;
}

export interface RunsListResponse {
  runs: RunRecord[];
}

export interface RunDetailResponse {
  run: RunRecord;
  events: IssuePilotEvent[];
  /** Last N log lines (already redacted) for quick-look in the UI. */
  logsTail: string[];
}

export interface EventsQuery {
  runId?: string;
  /** Default 100, server caps at 500 to keep responses small. */
  limit?: number;
  /** Opaque cursor returned in the previous `nextCursor`. */
  cursor?: string;
}

export interface EventsListResponse {
  events: IssuePilotEvent[];
  /** Set when more events exist; undefined when at tail. */
  nextCursor?: string;
}
