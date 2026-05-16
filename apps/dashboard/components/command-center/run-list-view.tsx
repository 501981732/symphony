"use client";

import type { RunWithReport } from "../../lib/api";
import { Badge } from "../ui/badge";

interface RunListViewProps {
  runs: RunWithReport[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}

function readinessTone(status: string | undefined) {
  if (status === "ready") return "success" as const;
  if (status === "blocked") return "danger" as const;
  if (status === "not-ready") return "warning" as const;
  return "neutral" as const;
}

export function RunListView({
  runs,
  selectedRunId,
  onSelect,
}: RunListViewProps) {
  if (runs.length === 0) {
    return (
      <p className="rounded-md border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
        No runs available yet.
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
      {runs.map((run) => {
        const issueTitle = run.issue?.title ?? `Issue ${run.issue?.iid ?? ""}`;
        const selected = run.runId === selectedRunId;
        const ariaLabel = `${issueTitle} (${run.runId})`;
        return (
          <li key={run.runId}>
            <button
              type="button"
              onClick={() => onSelect(run.runId)}
              aria-pressed={selected}
              aria-label={ariaLabel}
              className={`flex w-full flex-col items-start gap-2 px-4 py-3 text-left hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-900 ${
                selected ? "bg-slate-50" : ""
              }`}
            >
              <div className="flex w-full items-center justify-between gap-3">
                <span className="font-medium text-slate-900">{issueTitle}</span>
                <span className="text-xs font-mono text-slate-400">
                  {run.runId}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <Badge tone="neutral">{run.status}</Badge>
                {run.report?.mergeReadinessStatus && (
                  <Badge tone={readinessTone(run.report.mergeReadinessStatus)}>
                    {run.report.mergeReadinessStatus}
                  </Badge>
                )}
                {run.report?.ciStatus && (
                  <Badge
                    tone={run.report.ciStatus === "success" ? "success" : "warning"}
                  >
                    CI: {run.report.ciStatus}
                  </Badge>
                )}
                <span>attempt {run.attempt}</span>
                <span className="font-mono">{run.branch}</span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
