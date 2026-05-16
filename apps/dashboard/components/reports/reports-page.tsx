import type { RunReportSummary } from "@issuepilot/shared-contracts";

import { Badge, type BadgeTone } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

interface ReportsPageProps {
  reports: RunReportSummary[];
}

function readinessTone(status: string): BadgeTone {
  if (status === "ready") return "success";
  if (status === "blocked") return "danger";
  if (status === "not-ready") return "warning";
  return "neutral";
}

function formatDuration(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function ReportsPage({ reports }: ReportsPageProps) {
  const total = reports.length;
  const ready = reports.filter(
    (r) => r.mergeReadinessStatus === "ready",
  ).length;
  const blocked = reports.filter(
    (r) => r.mergeReadinessStatus === "blocked",
  ).length;
  const failed = reports.filter(
    (r) => r.status === "failed" || r.status === "blocked",
  ).length;

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Reports
        </h1>
        <p className="text-sm text-slate-500">
          Quality and timing metrics derived from local report artifacts.
          Merge readiness here is a dry run; the orchestrator never merges
          MRs automatically.
        </p>
      </header>

      <section
        className="grid grid-cols-1 gap-3 md:grid-cols-4"
        aria-label="Report counters"
      >
        <Counter label="Total" value={total} />
        <Counter label="Ready to merge" value={ready} tone="success" />
        <Counter label="Blocked" value={blocked} tone="danger" />
        <Counter label="Failed runs" value={failed} tone="warning" />
      </section>

      <section className="flex flex-col gap-3" aria-label="Report table">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Per-run summary
        </h2>
        <Card>
          <CardContent className="p-0">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2">Run</th>
                  <th className="px-4 py-2">Issue</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Merge readiness</th>
                  <th className="px-4 py-2">CI</th>
                  <th className="px-4 py-2">Duration</th>
                </tr>
              </thead>
              <tbody>
                {reports.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-6 text-center text-slate-500"
                    >
                      No reports yet. Run the orchestrator to populate this
                      view.
                    </td>
                  </tr>
                ) : (
                  reports.map((report) => (
                    <tr
                      key={report.runId}
                      className="border-b border-slate-100"
                    >
                      <td className="px-4 py-2 font-mono text-xs text-slate-700">
                        {report.runId}
                      </td>
                      <td className="px-4 py-2 text-slate-800">
                        <span className="font-mono text-xs text-slate-500 mr-2">
                          #{report.issueIid}
                        </span>
                        {report.issueTitle}
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone="neutral">{report.status}</Badge>
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={readinessTone(report.mergeReadinessStatus)}>
                          {report.mergeReadinessStatus}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-700">
                        {report.ciStatus ?? "—"}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-700">
                        {formatDuration(report.totalMs)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}

function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: BadgeTone;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center justify-between">
        <span className="text-2xl font-semibold text-slate-900">{value}</span>
        {tone ? <Badge tone={tone}>{label}</Badge> : null}
      </CardContent>
    </Card>
  );
}
