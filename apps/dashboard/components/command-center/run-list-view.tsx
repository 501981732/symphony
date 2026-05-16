"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import type { RunWithReport } from "../../lib/api";
import { Badge } from "../ui/badge";
import { Card } from "../ui/card";
import { StatusDot, READINESS_TONES, RUN_STATUS_TONES } from "../ui/status";

interface RunListViewProps {
  runs: RunWithReport[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}

function formatDuration(startedAt: string, updatedAt: string, dash: string): string {
  const start = new Date(startedAt).getTime();
  const end = new Date(updatedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return dash;
  }
  const ms = end - start;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
}

export function RunListView({
  runs,
  selectedRunId,
  onSelect,
}: RunListViewProps) {
  const t = useTranslations("list");
  const tCommon = useTranslations("common");
  const dash = tCommon("dash");
  if (runs.length === 0) {
    return (
      <Card className="px-6 py-10 text-center">
        <p className="text-sm font-medium text-fg">{t("emptyTitle")}</p>
        <p className="mt-1 text-xs text-fg-subtle">
          {t.rich("emptyBody", {
            code: (chunks) => (
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">
                {chunks}
              </code>
            ),
          })}
        </p>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div
        className="hidden grid-cols-[1.5fr_3.5fr_2fr_1.4fr_1fr_0.8fr] items-center gap-3 border-b border-border bg-surface-2/60 px-5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-subtle lg:grid"
        aria-hidden="true"
      >
        <span>{t("headStatus")}</span>
        <span>{t("headIssue")}</span>
        <span>{t("headBranch")}</span>
        <span>{t("headReadiness")}</span>
        <span>{t("headCi")}</span>
        <span className="text-right">{t("headAttempt")}</span>
      </div>
      <ul role="list" className="divide-y divide-border/70">
        {runs.map((run) => {
          const tone = RUN_STATUS_TONES[run.status];
          const readinessTone = run.report?.mergeReadinessStatus
            ? READINESS_TONES[run.report.mergeReadinessStatus]
            : undefined;
          const issueTitle = run.issue?.title ?? `Issue ${run.issue?.iid ?? ""}`;
          const selected = run.runId === selectedRunId;

          return (
            <li
              key={run.runId}
              style={
                {
                  "--row-accent": `var(--color-${tone})`,
                } as React.CSSProperties
              }
            >
              <button
                type="button"
                onClick={() => onSelect(run.runId)}
                aria-pressed={selected}
                aria-label={`${issueTitle} (${run.runId})`}
                className="surface-row grid w-full grid-cols-[auto_1fr] items-start gap-x-3 gap-y-2 px-5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring lg:grid-cols-[1.5fr_3.5fr_2fr_1.4fr_1fr_0.8fr] lg:items-center"
              >
                <div className="flex items-center gap-2 lg:contents">
                  <span className="lg:order-1 lg:flex lg:items-center lg:gap-2">
                    <Badge tone={tone} className="gap-1.5">
                      <StatusDot tone={tone} />
                      {run.status}
                    </Badge>
                  </span>
                  <div className="flex flex-col lg:order-2 lg:gap-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium text-fg">
                        {issueTitle}
                      </span>
                      {run.issue?.iid ? (
                        <span className="font-mono text-[11px] text-fg-subtle">
                          #{run.issue.iid}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-subtle">
                      <span className="font-mono">{run.runId}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">
                        {formatDuration(run.startedAt, run.updatedAt, dash)}
                      </span>
                      <Link
                        href={`/runs/${encodeURIComponent(run.runId)}`}
                        className="ml-auto text-info hover:underline lg:ml-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {tCommon("openArrow")}
                      </Link>
                    </div>
                  </div>
                  <span className="hidden truncate font-mono text-[12px] text-fg-muted lg:order-3 lg:inline">
                    {run.branch}
                  </span>
                  <span className="hidden lg:order-4 lg:inline">
                    {readinessTone ? (
                      <Badge tone={readinessTone} className="gap-1.5">
                        <StatusDot tone={readinessTone} />
                        {run.report?.mergeReadinessStatus}
                      </Badge>
                    ) : (
                      <span className="font-mono text-[11px] text-fg-subtle">
                        {dash}
                      </span>
                    )}
                  </span>
                  <span className="hidden font-mono text-[11px] lg:order-5 lg:inline">
                    {run.report?.ciStatus ?? dash}
                  </span>
                  <span className="hidden text-right font-mono tabular-nums text-[12px] text-fg-muted lg:order-6 lg:inline">
                    {run.attempt}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 lg:hidden">
                  {readinessTone ? (
                    <Badge tone={readinessTone} className="gap-1.5">
                      <StatusDot tone={readinessTone} />
                      {run.report?.mergeReadinessStatus}
                    </Badge>
                  ) : null}
                  {run.report?.ciStatus ? (
                    <Badge tone="info">{t("ciTag", { value: run.report.ciStatus })}</Badge>
                  ) : null}
                  <span className="font-mono text-[11px] text-fg-muted">
                    {t("attempt", { value: run.attempt })}
                  </span>
                  <span className="font-mono text-[11px] text-fg-muted">
                    {run.branch}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
