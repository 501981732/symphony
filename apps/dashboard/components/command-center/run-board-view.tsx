"use client";

import type { RunWithReport } from "../../lib/api";
import { Badge } from "../ui/badge";

const COLUMNS = [
  "ai-ready",
  "ai-running",
  "ai-rework",
  "human-review",
  "ai-failed",
  "ai-blocked",
] as const;

type ColumnLabel = (typeof COLUMNS)[number];

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
  const grouped = new Map<ColumnLabel, RunWithReport[]>();
  for (const column of COLUMNS) grouped.set(column, []);
  for (const run of runs) {
    const column = pickColumn(run);
    if (column) grouped.get(column)!.push(run);
  }

  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(0, 1fr))` }}
    >
      {COLUMNS.map((column) => {
        const items = grouped.get(column) ?? [];
        return (
          <section
            key={column}
            className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3"
          >
            <header className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
              <h3>{column}</h3>
              <span aria-label={`${column} count`}>{items.length}</span>
            </header>
            <ul className="flex flex-col gap-2">
              {items.map((run) => {
                const selected = run.runId === selectedRunId;
                const title = run.issue?.title ?? `Issue ${run.issue?.iid ?? ""}`;
                return (
                  <li key={run.runId}>
                    <button
                      type="button"
                      onClick={() => onSelect(run.runId)}
                      aria-pressed={selected}
                      className={`flex w-full flex-col gap-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-left text-xs shadow-sm hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-900 ${
                        selected ? "ring-2 ring-slate-900" : ""
                      }`}
                    >
                      <span className="font-medium text-slate-900">{title}</span>
                      <span className="font-mono text-[10px] text-slate-400">
                        {run.runId}
                      </span>
                      <div className="flex flex-wrap items-center gap-1">
                        {run.report?.mergeReadinessStatus && (
                          <Badge tone="neutral">
                            {run.report.mergeReadinessStatus}
                          </Badge>
                        )}
                        {run.report?.ciStatus && (
                          <Badge tone="neutral">CI:{run.report.ciStatus}</Badge>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
