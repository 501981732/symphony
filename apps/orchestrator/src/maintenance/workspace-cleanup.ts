import { randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";

import { redact, type EventBus } from "@issuepilot/observability";
import type {
  IssuePilotInternalEvent,
  RetentionConfig,
} from "@issuepilot/shared-contracts";
import {
  enumerateWorkspaceEntries as defaultEnumerator,
  planWorkspaceCleanup,
  type CleanupDelete,
  type CleanupPlan,
  type EnumerateWorkspaceEntriesResult,
  type WorkspaceEntryStatus,
} from "@issuepilot/workspace";

import type { RuntimeState } from "../runtime/state.js";

export interface RunWorkspaceCleanupInput {
  workspaceRoot: string;
  state: RuntimeState;
  retention: RetentionConfig;
  eventBus: EventBus<IssuePilotInternalEvent>;
  /** Injectable clock so tests can pin the planner's notion of "now". */
  now?: () => Date;
  /**
   * Filesystem stub used by tests to inject errors on specific paths.
   * Production callers should leave this unset.
   */
  fs?: Pick<typeof fsPromises, "rm">;
  /**
   * Injectable enumerator for tests that already have a synthetic plan
   * or want to bypass disk IO. Defaults to the workspace package's
   * `enumerateWorkspaceEntries`.
   */
  enumerator?: typeof defaultEnumerator;
}

/**
 * Single sweep of the workspace root. Always returns the plan it
 * executed (or attempted to execute); rm failures on individual
 * workspaces become `workspace_cleanup_failed` events so they survive
 * a process restart but do not abort the rest of the sweep. The
 * orchestrator main loop is expected to call this once per
 * `RetentionConfig.cleanupIntervalMs` window.
 *
 * Event payloads are routed through {@link redact} before publication
 * so user-supplied issue titles / project names never leak credentials.
 */
export async function runWorkspaceCleanupOnce(
  input: RunWorkspaceCleanupInput,
): Promise<CleanupPlan> {
  const now = input.now ?? (() => new Date());
  const enumerator = input.enumerator ?? defaultEnumerator;
  const fsImpl = input.fs ?? { rm: fsPromises.rm };

  const lookup = buildRunLookup(input.state);
  let enumeration: EnumerateWorkspaceEntriesResult;
  try {
    enumeration = await enumerator({
      workspaceRoot: input.workspaceRoot,
      lookupRun: lookup,
    });
  } catch (err) {
    emit(input, "workspace_cleanup_failed", "cleanup:enumerate-failed", {
      reason: "enumerate_failed",
      workspaceRoot: input.workspaceRoot,
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      retainBytes: input.retention.maxWorkspaceGb * 1024 ** 3,
      totalBytes: 0,
      delete: [],
      keepFailureMarkers: [],
      errors: [
        {
          workspacePath: input.workspaceRoot,
          reason: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }

  const plan = planWorkspaceCleanup({
    entries: enumeration.entries,
    retention: input.retention,
    now: now(),
    errors: enumeration.errors,
  });

  emit(input, "workspace_cleanup_planned", "cleanup:planned", {
    workspaceRoot: input.workspaceRoot,
    totalBytes: plan.totalBytes,
    retainBytes: plan.retainBytes,
    deleteCount: plan.delete.length,
    keepFailureMarkersCount: plan.keepFailureMarkers.length,
    overCapacity: plan.totalBytes > plan.retainBytes,
    errors: plan.errors,
  });

  // Surface any enumeration-time errors before the per-delete attempts
  // so the audit log shows them in order: stat failures first, then
  // rm failures (if any). Each enumeration error becomes its own
  // `workspace_cleanup_failed` event so the runbook can grep by
  // `data.reason` to triage permission vs missing-dir vs corrupt-dir.
  for (const err of enumeration.errors) {
    emit(input, "workspace_cleanup_failed", "cleanup:stat-failed", {
      reason: "stat_failed",
      workspacePath: err.workspacePath,
      message: err.reason,
    });
  }

  for (const target of plan.delete) {
    await deleteOne(input, fsImpl, target);
  }

  return plan;
}

async function deleteOne(
  input: RunWorkspaceCleanupInput,
  fsImpl: Pick<typeof fsPromises, "rm">,
  target: CleanupDelete,
): Promise<void> {
  try {
    await fsImpl.rm(target.workspacePath, { recursive: true, force: true });
  } catch (err) {
    emit(input, "workspace_cleanup_failed", "cleanup:rm-failed", {
      reason: "rm_failed",
      workspacePath: target.workspacePath,
      planReason: target.reason,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  emit(input, "workspace_cleanup_completed", "cleanup:deleted", {
    workspacePath: target.workspacePath,
    reason: target.reason,
  });
}

const ACTIVE_RUN_STATUSES = new Set<string>([
  "claimed",
  "running",
  "retrying",
  "stopping",
]);

function runStatusToWorkspaceStatus(status: string): WorkspaceEntryStatus {
  if (ACTIVE_RUN_STATUSES.has(status)) return "active";
  switch (status) {
    case "completed":
      return "successful";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    default:
      return "unknown";
  }
}

function buildRunLookup(
  state: RuntimeState,
): (
  projectId: string,
  runId: string,
) =>
  | { status: WorkspaceEntryStatus; endedAt?: string | undefined }
  | undefined {
  const byKey = new Map<
    string,
    { status: WorkspaceEntryStatus; endedAt?: string | undefined }
  >();
  for (const record of state.allRuns()) {
    const runId = typeof record["runId"] === "string" ? record["runId"] : "";
    if (!runId) continue;
    const projectId =
      typeof record["projectId"] === "string" ? record["projectId"] : "";
    if (!projectId) continue;
    const status = runStatusToWorkspaceStatus(record["status"] as string);
    const endedAt =
      typeof record["endedAt"] === "string"
        ? (record["endedAt"] as string)
        : undefined;
    const value: { status: WorkspaceEntryStatus; endedAt?: string } = {
      status,
    };
    if (endedAt !== undefined) {
      value.endedAt = endedAt;
    }
    byKey.set(`${projectId}/${runId}`, value);
  }
  return (projectId, runId) => byKey.get(`${projectId}/${runId}`);
}

function emit(
  input: RunWorkspaceCleanupInput,
  type:
    | "workspace_cleanup_planned"
    | "workspace_cleanup_completed"
    | "workspace_cleanup_failed",
  message: string,
  data: Record<string, unknown>,
): void {
  const ts = (input.now?.() ?? new Date()).toISOString();
  const safe = (() => {
    const r = redact(data);
    return r && typeof r === "object" && !Array.isArray(r)
      ? (r as Record<string, unknown>)
      : data;
  })();
  // Cleanup sweeps are not tied to a single run, so we use a stable
  // namespace as `runId`. Downstream consumers (SSE / event store)
  // already key off `type` + `data.workspacePath`.
  input.eventBus.publish({
    id: randomUUID(),
    runId: "workspace-cleanup",
    type,
    message,
    data: safe,
    createdAt: ts,
    ts,
  });
}
