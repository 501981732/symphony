import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { RetentionConfig } from "@issuepilot/shared-contracts";

const BYTES_PER_GB = 1024 ** 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Categorisation of a single workspace directory the planner considers
 * for cleanup. Concrete values map onto `RunRecord.status` (see
 * `@issuepilot/shared-contracts/run.ts`) but the planner is decoupled
 * from the full RunRecord shape — only the fields below influence the
 * cleanup decision.
 */
export type WorkspaceEntryStatus =
  | "active"
  | "running"
  | "stopping"
  | "successful"
  | "completed"
  | "closed"
  | "failed"
  | "blocked"
  | "unknown";

export interface WorkspaceEntry {
  /** Absolute path to the workspace directory on disk. */
  workspacePath: string;
  /** Run id of the dispatch that created the workspace. */
  runId: string;
  /** Project id from `issuepilot.team.yaml` (or the V1 single project). */
  projectId: string;
  /** Run lifecycle category — see {@link WorkspaceEntryStatus}. */
  status: WorkspaceEntryStatus;
  /**
   * ISO-8601 of when the run reached a terminal state, or `undefined`
   * for runs still active. Used to decide whether the entry has passed
   * its retention window.
   */
  endedAt?: string;
  /** Size in bytes; used for the over-capacity decision. */
  bytes: number;
}

export type CleanupDeleteReason =
  | "successful-expired"
  | "failed-expired"
  | "over-capacity";

export interface CleanupDelete {
  workspacePath: string;
  reason: CleanupDeleteReason;
}

export interface CleanupError {
  workspacePath: string;
  reason: string;
}

export interface CleanupPlan {
  /** Cap from `RetentionConfig.maxWorkspaceGb`, expressed in bytes. */
  retainBytes: number;
  /** Sum of {@link WorkspaceEntry.bytes} across the input. */
  totalBytes: number;
  delete: CleanupDelete[];
  /**
   * Workspaces holding failure forensics (failed / blocked, within the
   * retention window). The executor leaves them alone but reports them
   * so operators can choose to archive manually.
   */
  keepFailureMarkers: string[];
  /**
   * Entries that could not be classified (typically because the
   * enumerator failed to `stat` them). The executor surfaces them as
   * `workspace_cleanup_failed` events with `reason: "stat_failed"`.
   */
  errors: CleanupError[];
}

export interface PlanWorkspaceCleanupInput {
  entries: WorkspaceEntry[];
  retention: RetentionConfig;
  now: Date;
  errors?: CleanupError[];
}

/**
 * Pure planner — given the current workspace inventory and a
 * {@link RetentionConfig}, return the {@link CleanupPlan} the executor
 * should carry out. Inputs are never mutated, the function performs no
 * IO and returns deterministic output for identical inputs (sorting by
 * `endedAt` asc, fallback to `workspacePath` asc for entries without
 * `endedAt`).
 *
 * Decisions follow V2 spec §11:
 *  - `active` / `running` / `stopping` / `unknown` are never deleted.
 *  - `failed` / `blocked` entries within `failedRunDays` are kept and
 *    surfaced in `keepFailureMarkers` so operators see the forensics
 *    backlog.
 *  - `successful` / `closed` / `completed` entries past
 *    `successfulRunDays` are added to `delete` with reason
 *    `successful-expired`; same for `failed` / `blocked` past
 *    `failedRunDays` with `failed-expired`.
 *  - When `totalBytes > maxWorkspaceGb * 2^30`, the planner still only
 *    deletes already-expired terminal entries (the spec forbids
 *    deleting unexpired failure forensics or active runs to free
 *    space). The *oldest* expired entry retains its natural reason so
 *    the operator sees it would have been deleted regardless; younger
 *    expired entries that piled on capacity pressure are tagged
 *    `over-capacity` so the runbook can explain why the sweep deleted
 *    more aggressively than usual.
 */
export function planWorkspaceCleanup(
  input: PlanWorkspaceCleanupInput,
): CleanupPlan {
  const capBytes = input.retention.maxWorkspaceGb * BYTES_PER_GB;
  let totalBytes = 0;
  const keepFailureMarkers: string[] = [];
  const expired: Array<{
    entry: WorkspaceEntry;
    naturalReason: "successful-expired" | "failed-expired";
  }> = [];

  for (const entry of input.entries) {
    totalBytes += entry.bytes;

    switch (entry.status) {
      case "active":
      case "running":
      case "stopping":
      case "unknown":
        continue;
      case "failed":
      case "blocked": {
        const ageMs = ageInMs(entry.endedAt, input.now);
        const cutoffMs = input.retention.failedRunDays * MS_PER_DAY;
        if (ageMs !== undefined && ageMs > cutoffMs) {
          expired.push({ entry, naturalReason: "failed-expired" });
        } else {
          keepFailureMarkers.push(entry.workspacePath);
        }
        continue;
      }
      case "successful":
      case "completed":
      case "closed": {
        const ageMs = ageInMs(entry.endedAt, input.now);
        const cutoffMs = input.retention.successfulRunDays * MS_PER_DAY;
        if (ageMs !== undefined && ageMs > cutoffMs) {
          expired.push({ entry, naturalReason: "successful-expired" });
        }
        continue;
      }
      default: {
        const _exhaustive: never = entry.status;
        void _exhaustive;
        continue;
      }
    }
  }

  // Deterministic order: oldest endedAt first; entries missing endedAt
  // sort to the end and break ties by workspacePath so two runs that
  // finished at the same instant always plan in the same order.
  expired.sort((a, b) => {
    const ta = a.entry.endedAt ? Date.parse(a.entry.endedAt) : Infinity;
    const tb = b.entry.endedAt ? Date.parse(b.entry.endedAt) : Infinity;
    if (ta !== tb) return ta - tb;
    return a.entry.workspacePath.localeCompare(b.entry.workspacePath);
  });

  const overCapacity = totalBytes > capBytes;
  const deletes: CleanupDelete[] = expired.map((candidate, index) => ({
    workspacePath: candidate.entry.workspacePath,
    reason:
      overCapacity && index > 0 ? "over-capacity" : candidate.naturalReason,
  }));

  return {
    retainBytes: capBytes,
    totalBytes,
    delete: deletes,
    keepFailureMarkers,
    errors: [...(input.errors ?? [])],
  };
}

function ageInMs(endedAt: string | undefined, now: Date): number | undefined {
  if (!endedAt) return undefined;
  const ms = Date.parse(endedAt);
  if (Number.isNaN(ms)) return undefined;
  return now.getTime() - ms;
}

export interface EnumerateWorkspaceEntriesInput {
  workspaceRoot: string;
  /**
   * Lookup callback for runtime-side run metadata. The planner is
   * stateless so it cannot query `RuntimeState` directly; the executor
   * wraps `RuntimeState.findRunByWorkspace(projectId, runId)` and
   * surfaces the bits the planner needs (status + endedAt). Returning
   * `undefined` means "no record" — the entry is tagged `unknown` and
   * skipped by the planner.
   */
  lookupRun(
    projectId: string,
    runId: string,
  ): { status: WorkspaceEntryStatus; endedAt?: string | undefined } | undefined;
}

export interface EnumerateWorkspaceEntriesResult {
  entries: WorkspaceEntry[];
  errors: CleanupError[];
}

/**
 * Walk `workspaceRoot/<projectId>/<runId>/` and return one
 * {@link WorkspaceEntry} per run directory. `bytes` is computed by
 * recursively stat-ing the run directory (we do not call out to
 * `du(1)` so the executor stays portable across macOS / Linux). IO
 * failures are collected into `errors[]` and never thrown — the
 * planner is allowed to operate on a partial view.
 */
export async function enumerateWorkspaceEntries(
  input: EnumerateWorkspaceEntriesInput,
): Promise<EnumerateWorkspaceEntriesResult> {
  const entries: WorkspaceEntry[] = [];
  const errors: CleanupError[] = [];

  let projectDirs: string[];
  try {
    const dirents = await fs.readdir(input.workspaceRoot, {
      withFileTypes: true,
    });
    projectDirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    errors.push({
      workspacePath: input.workspaceRoot,
      reason: formatError(err),
    });
    return { entries, errors };
  }

  for (const projectId of projectDirs) {
    const projectPath = path.join(input.workspaceRoot, projectId);
    let runDirs: string[];
    try {
      const dirents = await fs.readdir(projectPath, { withFileTypes: true });
      runDirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (err) {
      errors.push({ workspacePath: projectPath, reason: formatError(err) });
      continue;
    }

    for (const runId of runDirs) {
      const workspacePath = path.join(projectPath, runId);
      let bytes = 0;
      try {
        bytes = await directorySize(workspacePath);
      } catch (err) {
        errors.push({ workspacePath, reason: formatError(err) });
        continue;
      }

      const lookup = input.lookupRun(projectId, runId);
      const status: WorkspaceEntryStatus = lookup?.status ?? "unknown";
      const entry: WorkspaceEntry = {
        workspacePath,
        runId,
        projectId,
        status,
        bytes,
      };
      if (lookup?.endedAt !== undefined) {
        entry.endedAt = lookup.endedAt;
      }
      entries.push(entry);
    }
  }

  return { entries, errors };
}

async function directorySize(target: string): Promise<number> {
  let total = 0;
  const stack: string[] = [target];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const dirents = await fs.readdir(current, { withFileTypes: true });
    for (const dirent of dirents) {
      const child = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(child);
        continue;
      }
      if (dirent.isFile() || dirent.isSymbolicLink()) {
        try {
          const stat = await fs.lstat(child);
          total += stat.size;
        } catch {
          // ignore per-file races (workspace can mutate during sweep)
        }
      }
    }
  }
  return total;
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}
