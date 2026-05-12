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

const STATUS_TONES: Record<RunStatus, BadgeTone> = {
  claimed: "info",
  running: "info",
  retrying: "warning",
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
}

export function RunsTable({ runs }: RunsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("updatedAt");
  const [direction, setDirection] = useState<SortDirection>("desc");

  const sorted = useMemo(() => {
    const next = [...runs];
    next.sort((a, b) => {
      const result = compare(a, b, sortKey);
      return direction === "asc" ? result : -result;
    });
    return next;
  }, [runs, sortKey, direction]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setDirection(key === "updatedAt" ? "desc" : "asc");
    }
  };

  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center text-sm text-slate-500">
        No active runs yet. Add the <code className="font-mono">ai-ready</code>{" "}
        label to a GitLab issue to kick one off.
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
    <Table>
      <TableHeader>
        <TableRow>
          {sortableHead("iid", "Issue")}
          <TableHead>Title</TableHead>
          <TableHead>Labels</TableHead>
          {sortableHead("status", "Status")}
          <TableHead>Attempt</TableHead>
          <TableHead>Elapsed</TableHead>
          {sortableHead("updatedAt", "Updated")}
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
            <TableCell className="max-w-[24ch] truncate" title={run.issue.title}>
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
            <TableCell className="tabular-nums">{run.attempt}</TableCell>
            <TableCell className="tabular-nums">
              {formatElapsed(run.startedAt, run.endedAt)}
            </TableCell>
            <TableCell
              className="tabular-nums text-xs text-slate-500"
              title={run.updatedAt}
            >
              {formatElapsed(run.updatedAt)} ago
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
              <a
                className="text-sky-700 hover:underline"
                href={`/runs/${encodeURIComponent(run.runId)}`}
                aria-label={`detail of ${run.runId}`}
              >
                detail
              </a>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
