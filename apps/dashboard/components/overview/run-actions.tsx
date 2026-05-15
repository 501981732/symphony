"use client";

import type { RunStatus } from "@issuepilot/shared-contracts";

import { Button } from "../ui/button";

/**
 * Minimal projection of {@link RunRecord} needed by the button row. Only the
 * `status` + optional `archivedAt` drive visibility — other fields stay on
 * the parent so the button bar can be reused outside the runs-table (detail
 * page header).
 */
export interface RunActionsSnapshot {
  runId: string;
  status: RunStatus | string;
  archivedAt?: string;
}

export interface RunActionsProps {
  run: RunActionsSnapshot;
  onRetry?: (runId: string) => void;
  onStop?: (runId: string) => void;
  onArchive?: (runId: string) => void;
  /**
   * When true, all rendered buttons are disabled. Parent components own the
   * latency state because they also own the API call + refresh, which keeps
   * RunActions itself purely presentational.
   */
  pending?: boolean;
}

function canRetry(status: string): boolean {
  return status === "failed" || status === "blocked" || status === "retrying";
}

function canStop(status: string): boolean {
  return status === "running";
}

function canArchive(status: string): boolean {
  return (
    status === "failed" || status === "blocked" || status === "completed"
  );
}

export function RunActions({
  run,
  onRetry,
  onStop,
  onArchive,
  pending = false,
}: RunActionsProps) {
  if (run.archivedAt) return null;

  const showRetry = canRetry(run.status);
  const showStop = canStop(run.status);
  const showArchive = canArchive(run.status);
  if (!showRetry && !showStop && !showArchive) return null;

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {showRetry && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => onRetry?.(run.runId)}
        >
          Retry
        </Button>
      )}
      {showStop && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => onStop?.(run.runId)}
        >
          Stop
        </Button>
      )}
      {showArchive && (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => onArchive?.(run.runId)}
        >
          Archive
        </Button>
      )}
    </div>
  );
}
