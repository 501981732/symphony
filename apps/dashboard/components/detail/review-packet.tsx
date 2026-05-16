import type { RunReportArtifact } from "@issuepilot/shared-contracts";

import { Badge, type BadgeTone } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

function readinessTone(status: string): BadgeTone {
  if (status === "ready") return "success";
  if (status === "blocked") return "danger";
  if (status === "not-ready") return "warning";
  return "neutral";
}

export function ReviewPacket({ report }: { report: RunReportArtifact }) {
  return (
    <section
      className="grid grid-cols-1 gap-4 lg:grid-cols-2"
      aria-label="Review Packet"
    >
      <Card>
        <CardHeader>
          <CardTitle>Handoff</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-slate-800">{report.handoff.summary}</p>
          <div>
            <h3 className="text-xs font-semibold uppercase text-slate-500">
              Validation
            </h3>
            <ul className="mt-1 list-disc pl-5">
              {report.handoff.validation.length === 0 ? (
                <li className="text-slate-500">not reported</li>
              ) : (
                report.handoff.validation.map((item) => (
                  <li key={item} className="text-slate-700">
                    {item}
                  </li>
                ))
              )}
            </ul>
          </div>
          {report.handoff.risks.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase text-slate-500">
                Risks
              </h3>
              <ul className="mt-1 list-disc pl-5">
                {report.handoff.risks.map((risk, index) => (
                  <li key={`${risk.level}-${index}`} className="text-slate-700">
                    <Badge
                      tone={risk.level === "high" ? "danger" : "warning"}
                      className="mr-2"
                    >
                      {risk.level}
                    </Badge>
                    {risk.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Merge readiness</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Badge tone={readinessTone(report.mergeReadiness.status)}>
            {report.mergeReadiness.status}
          </Badge>
          <ul className="list-disc pl-5">
            {report.mergeReadiness.reasons.map((reason) => (
              <li key={reason.code} className="text-slate-700">
                {reason.message}
              </li>
            ))}
          </ul>
          {report.checks.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase text-slate-500">
                Checks
              </h3>
              <ul className="mt-1 list-disc pl-5">
                {report.checks.map((check) => (
                  <li key={check.name} className="text-slate-700">
                    {check.name}{" "}
                    <Badge
                      tone={check.status === "passed" ? "success" : "danger"}
                    >
                      {check.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
