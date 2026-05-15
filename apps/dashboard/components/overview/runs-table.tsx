"use client";

import type { RunRecord, RunStatus } from "@issuepilot/shared-contracts";
import { useMemo, useState } from "react";

import { Badge, type BadgeTone } from "../ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";

import { RunActions } from "./run-actions";

const STATUS_TONES: Record<RunStatus, BadgeTone> = {
  claimed: "info",
  running: "info",
  retrying: "warning",
  stopping: "warning",
  completed: "success",
  failed: "danger",
  blocked: "violet",
};

function formatElapsed(startedAt: string, endedAt?: string): string {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "—";
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  if (Number.isNaN(end)) return "—";
  const seconds = Math.max(0, Math.round((end - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rem}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

type SortKey = "iid" | "status" | "updatedAt";
type SortDirection = "asc" | "desc";
const ARIA_SORT: Record<SortDirection, "ascending" | "descending"> = {
  asc: "ascending",
  desc: "descending",
};

function compare(a: RunRecord, b: RunRecord, key: SortKey): number {
  switch (key) {
    case "iid":
      return a.issue.iid - b.issue.iid;
    case "status":
      return a.status.localeCompare(b.status);
    case "updatedAt":
      return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  }
}

interface RunsTableProps {
  runs: RunRecord[];
  /**
   * Optional callbacks fired when an operator clicks Retry / Stop / Archive
   * on a row. The parent owns the API call, refresh, and pending state so
   * `RunsTable` itself stays purely presentational.
   */
  onRetry?: (runId: string) => void;
  onStop?: (runId: string) => void;
  onArchive?: (runId: string) => void;
  /** When true, disables all action buttons in every row. */
  actionsPending?: boolean;
}

export function RunsTable({
  runs,
  onRetry,
  onStop,
  onArchive,
  actionsPending = false,
}: RunsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("updatedAt");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const [showArchived, setShowArchived] = useState(false);

  const visible = useMemo(
    () => (showArchived ? runs : runs.filter((r) => !r.archivedAt)),
    [runs, showArchived],
  );

  const sorted = useMemo(() => {
    const next = [...visible];
    next.sort((a, b) => {
      const result = compare(a, b, sortKey);
      return direction === "asc" ? result : -result;
    });
    return next;
  }, [visible, sortKey, direction]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setDirection(key === "updatedAt" ? "desc" : "asc");
    }
  };

  const archivedToggle = runs.some((r) => r.archivedAt) ? (
    <label className="flex items-center gap-2 self-end text-xs text-slate-600">
      <input
        type="checkbox"
        className="h-3.5 w-3.5"
        checked={showArchived}
        onChange={(e) => setShowArchived(e.target.checked)}
      />
      Show archived
    </label>
  ) : null;

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {archivedToggle}
        <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center text-sm text-slate-500">
          No active runs yet. Add the{" "}
          <code className="font-mono">ai-ready</code> label to a GitLab issue
          to kick one off.
        </div>
      </div>
    );
  }

  const sortableHead = (key: SortKey, label: string) => (
    <TableHead
      aria-sort={sortKey === key ? ARIA_SORT[direction] : "none"}
      onClick={() => toggleSort(key)}
      className="cursor-pointer select-none hover:text-slate-700"
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortKey === key ? (
          <span aria-hidden>{direction === "asc" ? "▲" : "▼"}</span>
        ) : null}
      </span>
    </TableHead>
  );

  return (
    <div className="flex flex-col gap-2">
      {archivedToggle}
      <Table>
      <TableHeader>
        <TableRow>
          {sortableHead("iid", "Issue")}
          <TableHead>Title</TableHead>
          <TableHead>Labels</TableHead>
          {sortableHead("status", "Status")}
          <TableHead>Turns</TableHead>
          <TableHead>Last event</TableHead>
          <TableHead>Elapsed</TableHead>
          <TableHead>Branch</TableHead>
          <TableHead>MR</TableHead>
          <TableHead>Workspace</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((run) => (
          <TableRow key={run.runId}>
            <TableCell>
              <a
                className="font-mono text-sky-700 hover:underline"
                href={run.issue.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                #{run.issue.iid}
              </a>
            </TableCell>
            <TableCell
              className="max-w-[24ch] truncate"
              title={run.issue.title}
            >
              {run.issue.title}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {run.issue.labels.map((label) => (
                  <Badge key={label} tone="neutral">
                    {label}
                  </Badge>
                ))}
              </div>
            </TableCell>
            <TableCell>
              <Badge tone={STATUS_TONES[run.status]}>{run.status}</Badge>
            </TableCell>
            <TableCell className="tabular-nums">{run.turnCount ?? 0}</TableCell>
            <TableCell
              className="max-w-[22ch] truncate font-mono text-xs"
              title={run.lastEvent?.message}
            >
              {run.lastEvent?.type ?? "—"}
            </TableCell>
            <TableCell className="tabular-nums">
              {formatElapsed(run.startedAt, run.endedAt)}
            </TableCell>
            <TableCell className="max-w-[24ch] truncate font-mono text-xs">
              {run.branch}
            </TableCell>
            <TableCell>
              {run.mergeRequestUrl ? (
                <a
                  className="text-sky-700 hover:underline"
                  href={run.mergeRequestUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label="merge request"
                >
                  open
                </a>
              ) : (
                <span className="text-slate-400">—</span>
              )}
            </TableCell>
            <TableCell
              className="max-w-[24ch] truncate font-mono text-xs text-slate-500"
              title={run.workspacePath}
            >
              {run.workspacePath}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex flex-col items-end gap-1">
                <a
                  className="text-sky-700 hover:underline"
                  href={`/runs/${encodeURIComponent(run.runId)}`}
                  aria-label={`detail of ${run.runId}`}
                >
                  detail
                </a>
                <RunActions
                  run={{
                    runId: run.runId,
                    status: run.status,
                    ...(run.archivedAt
                      ? { archivedAt: run.archivedAt }
                      : {}),
                  }}
                  {...(onRetry ? { onRetry } : {})}
                  {...(onStop ? { onStop } : {})}
                  {...(onArchive ? { onArchive } : {})}
                  pending={actionsPending}
                />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
    </div>
  );
}
