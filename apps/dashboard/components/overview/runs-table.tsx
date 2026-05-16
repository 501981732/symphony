"use client";

import type {
  PipelineStatus,
  RunRecord,
  RunStatus,
} from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";
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

const CI_TONES: Record<PipelineStatus, BadgeTone> = {
  running: "info",
  success: "success",
  failed: "danger",
  pending: "info",
  canceled: "warning",
  unknown: "neutral",
};

function formatElapsed(startedAt: string, endedAt: string | undefined, dash: string): string {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return dash;
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  if (Number.isNaN(end)) return dash;
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
  const t = useTranslations("runsTable");
  const tActions = useTranslations("actions");
  const tCommon = useTranslations("common");
  const dash = tCommon("dash");
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
    <label className="flex items-center gap-2 self-end text-xs text-fg-muted">
      <input
        type="checkbox"
        className="h-3.5 w-3.5 accent-info"
        checked={showArchived}
        onChange={(e) => setShowArchived(e.target.checked)}
      />
      {t("showArchived")}
    </label>
  ) : null;

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {archivedToggle}
        <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-10 text-center text-sm text-fg-subtle">
          {t.rich("empty", {
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </div>
      </div>
    );
  }

  const sortableHead = (key: SortKey, label: string) => (
    <TableHead
      aria-sort={sortKey === key ? ARIA_SORT[direction] : "none"}
      onClick={() => toggleSort(key)}
      className="cursor-pointer select-none hover:text-fg"
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
          {sortableHead("iid", t("headIssue"))}
          <TableHead>{t("headTitle")}</TableHead>
          <TableHead>{t("headLabels")}</TableHead>
          {sortableHead("status", t("headStatus"))}
          <TableHead>{t("headTurns")}</TableHead>
          <TableHead>{t("headLastEvent")}</TableHead>
          <TableHead>{t("headElapsed")}</TableHead>
          <TableHead>{t("headBranch")}</TableHead>
          <TableHead>{t("headMr")}</TableHead>
          <TableHead>{t("headWorkspace")}</TableHead>
          <TableHead className="text-right">{t("headActions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((run) => (
          <TableRow key={run.runId}>
            <TableCell>
              <a
                className="font-mono text-info hover:underline"
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
              <div className="flex flex-wrap items-center gap-1">
                <Badge tone={STATUS_TONES[run.status]}>{run.status}</Badge>
                {run.latestCiStatus ? (
                  <Badge
                    tone={CI_TONES[run.latestCiStatus]}
                    aria-label={t("latestCiAria", { value: run.latestCiStatus })}
                    title={
                      run.latestCiCheckedAt
                        ? t("ciCheckedAtTitle", { value: run.latestCiCheckedAt })
                        : undefined
                    }
                  >
                    {t("ciTag", { value: run.latestCiStatus })}
                  </Badge>
                ) : null}
              </div>
            </TableCell>
            <TableCell className="tabular-nums">{run.turnCount ?? 0}</TableCell>
            <TableCell
              className="max-w-[22ch] truncate font-mono text-xs"
              title={run.lastEvent?.message}
            >
              {run.lastEvent?.type ?? dash}
            </TableCell>
            <TableCell className="tabular-nums">
              {formatElapsed(run.startedAt, run.endedAt, dash)}
            </TableCell>
            <TableCell className="max-w-[24ch] truncate font-mono text-xs">
              {run.branch}
            </TableCell>
            <TableCell>
              {run.mergeRequestUrl ? (
                <a
                  className="text-info hover:underline"
                  href={run.mergeRequestUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={t("mrAria")}
                >
                  {tCommon("open")}
                </a>
              ) : (
                <span className="text-fg-subtle">{dash}</span>
              )}
            </TableCell>
            <TableCell
              className="max-w-[24ch] truncate font-mono text-xs text-fg-subtle"
              title={run.workspacePath}
            >
              {run.workspacePath}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex flex-col items-end gap-1">
                <a
                  className="text-info hover:underline"
                  href={`/runs/${encodeURIComponent(run.runId)}`}
                  aria-label={tActions("detailAria", { runId: run.runId })}
                >
                  {tActions("detail")}
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
