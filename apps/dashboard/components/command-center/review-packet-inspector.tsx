"use client";

import type { RunWithReport } from "../../lib/api";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

interface ReviewPacketInspectorProps {
  run: RunWithReport | null;
}

function readinessTone(status: string | undefined) {
  if (status === "ready") return "success" as const;
  if (status === "blocked") return "danger" as const;
  if (status === "not-ready") return "warning" as const;
  return "neutral" as const;
}

export function ReviewPacketInspector({ run }: ReviewPacketInspectorProps) {
  if (!run) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Review Packet</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-slate-500">
          Select a run from the list or board to load its review packet.
        </CardContent>
      </Card>
    );
  }

  const report = run.report;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Review Packet</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-slate-400">{run.runId}</span>
          <Badge tone="neutral">{run.status}</Badge>
          {report?.mergeReadinessStatus && (
            <Badge tone={readinessTone(report.mergeReadinessStatus)}>
              {report.mergeReadinessStatus}
            </Badge>
          )}
          {report?.ciStatus && <Badge tone="info">CI:{report.ciStatus}</Badge>}
        </div>
        <p className="text-slate-700">{run.issue?.title ?? "(no title)"}</p>
        {report ? (
          <dl className="grid grid-cols-2 gap-3 text-xs text-slate-600">
            <div>
              <dt className="font-semibold uppercase text-slate-400">Branch</dt>
              <dd className="font-mono text-slate-800">{report.branch}</dd>
            </div>
            <div>
              <dt className="font-semibold uppercase text-slate-400">
                Attempt
              </dt>
              <dd>{report.attempt}</dd>
            </div>
            {report.highestRisk && (
              <div>
                <dt className="font-semibold uppercase text-slate-400">
                  Highest risk
                </dt>
                <dd>{report.highestRisk}</dd>
              </div>
            )}
            {report.mergeRequestUrl && (
              <div>
                <dt className="font-semibold uppercase text-slate-400">MR</dt>
                <dd>
                  <a
                    className="text-sky-700 underline"
                    href={report.mergeRequestUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    open
                  </a>
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            This run does not have a report yet; the daemon has not produced
            one or this is a legacy record.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
