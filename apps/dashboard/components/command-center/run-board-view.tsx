"use client";

import { useTranslations } from "next-intl";

import type { RunWithReport } from "../../lib/api";
import { Badge } from "../ui/badge";
import type { BadgeTone } from "../ui/badge";
import { READINESS_TONES, RUN_STATUS_TONES, StatusDot } from "../ui/status";

const COLUMNS = [
  "ai-ready",
  "ai-running",
  "ai-rework",
  "human-review",
  "ai-failed",
  "ai-blocked",
] as const;

type ColumnLabel = (typeof COLUMNS)[number];

const COLUMN_TONES: Record<ColumnLabel, BadgeTone> = {
  "ai-ready": "info",
  "ai-running": "info",
  "ai-rework": "warning",
  "human-review": "success",
  "ai-failed": "danger",
  "ai-blocked": "violet",
};

interface RunBoardViewProps {
  runs: RunWithReport[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}

function pickColumn(run: RunWithReport): ColumnLabel | null {
  const labels = run.issue?.labels ?? [];
  for (const column of COLUMNS) {
    if (labels.includes(column)) return column;
  }
  return null;
}

export function RunBoardView({
  runs,
  selectedRunId,
  onSelect,
}: RunBoardViewProps) {
  const t = useTranslations("board");
  const grouped = new Map<ColumnLabel, RunWithReport[]>();
  for (const column of COLUMNS) grouped.set(column, []);
  for (const run of runs) {
    const column = pickColumn(run);
    if (column) grouped.get(column)!.push(run);
  }

  return (
    <div className="overflow-x-auto pb-2">
      <div
        className="grid min-w-[1080px] gap-3"
        style={{
          gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(180px, 1fr))`,
        }}
      >
        {COLUMNS.map((column) => {
          const items = grouped.get(column) ?? [];
          const tone = COLUMN_TONES[column];
          return (
            <section
              key={column}
              aria-label={t("columnAria", { column, count: items.length })}
              className="flex max-h-[640px] min-h-[280px] flex-col rounded-lg border border-border bg-surface-2/60 shadow-1"
            >
              <header
                className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2.5"
                style={{
                  borderTopColor: `hsl(var(--color-${tone}))`,
                  borderTopWidth: "2px",
                }}
              >
                <div className="flex items-center gap-2">
                  <StatusDot tone={tone} />
                  <h3 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-fg">
                    {column}
                  </h3>
                </div>
                <span
                  aria-label={t("countAria", { column })}
                  className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10px] tabular-nums text-fg-muted"
                >
                  {items.length}
                </span>
              </header>
              {items.length === 0 ? (
                <p className="px-3 py-6 text-center text-[11px] text-fg-subtle">
                  {t("empty")}
                </p>
              ) : (
                <ul role="list" className="flex flex-col gap-2 p-2">
                  {items.map((run) => {
                    const selected = run.runId === selectedRunId;
                    const statusTone = RUN_STATUS_TONES[run.status];
                    const readinessTone = run.report?.mergeReadinessStatus
                      ? READINESS_TONES[run.report.mergeReadinessStatus]
                      : undefined;
                    const title =
                      run.issue?.title ?? `Issue ${run.issue?.iid ?? ""}`;
                    // Board cards are dense; keep title to two lines and
                    // hide the verbose `runId` behind the native tooltip
                    // (still keyboard-readable via the button's
                    // aria-label which now includes the run id too).
                    return (
                      <li key={run.runId}>
                        <button
                          type="button"
                          onClick={() => onSelect(run.runId)}
                          aria-pressed={selected}
                          aria-label={`${title} (${run.runId})`}
                          title={run.runId}
                          className={`group/card flex w-full flex-col gap-2 rounded-md border bg-surface px-3 py-2.5 text-left text-xs shadow-1 transition-[transform,box-shadow,border-color] duration-150 ease-swiss-out hover:-translate-y-0.5 hover:border-border-strong hover:shadow-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                            selected
                              ? "-translate-y-0.5 border-info shadow-2 ring-2 ring-info/40"
                              : "border-border"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="line-clamp-2 text-[13px] font-medium leading-snug text-fg">
                              {title}
                            </span>
                            {run.issue?.iid ? (
                              <span className="shrink-0 font-mono text-[10px] tabular-nums text-fg-subtle">
                                #{run.issue.iid}
                              </span>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge tone={statusTone} className="gap-1.5">
                              <StatusDot tone={statusTone} />
                              {run.status}
                            </Badge>
                            {readinessTone ? (
                              <Badge tone={readinessTone}>
                                {run.report?.mergeReadinessStatus}
                              </Badge>
                            ) : null}
                            {run.report?.ciStatus ? (
                              <Badge tone="info">
                                {t("ciTag", { value: run.report.ciStatus })}
                              </Badge>
                            ) : null}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
