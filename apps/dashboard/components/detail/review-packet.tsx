"use client";

import type { RunReportArtifact } from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";

import { Badge, type BadgeTone } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { READINESS_TONES, StatusDot, StatusPill } from "../ui/status";

function riskTone(level: "low" | "medium" | "high"): BadgeTone {
  if (level === "high") return "danger";
  if (level === "medium") return "warning";
  return "info";
}

function checkTone(status: string): BadgeTone {
  if (status === "passed" || status === "succeeded" || status === "success") {
    return "success";
  }
  if (status === "failed" || status === "blocked") return "danger";
  if (status === "running" || status === "pending") return "info";
  if (status === "warning") return "warning";
  return "neutral";
}

export function ReviewPacket({ report }: { report: RunReportArtifact }) {
  const t = useTranslations("reviewPacket");
  const readinessTone = READINESS_TONES[report.mergeReadiness.status];
  return (
    <section
      aria-label={t("sectionLabel")}
      className="grid grid-cols-1 gap-4 lg:grid-cols-3"
    >
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>{t("handoff")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <p className="text-[15px] leading-relaxed text-fg">
            {report.handoff.summary}
          </p>
          <Block label={t("validation")}>
            {report.handoff.validation.length === 0 ? (
              <p className="text-sm text-fg-subtle">{t("validationEmpty")}</p>
            ) : (
              <ul role="list" className="flex flex-col gap-1.5">
                {report.handoff.validation.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-2 text-sm text-fg"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-success"
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            )}
          </Block>
          {report.handoff.risks.length > 0 ? (
            <Block label={t("risks")}>
              <ul role="list" className="flex flex-col gap-1.5">
                {report.handoff.risks.map((risk, index) => {
                  const tone = riskTone(risk.level);
                  return (
                    <li
                      key={`${risk.level}-${index}`}
                      className="flex items-start gap-2 text-sm text-fg"
                    >
                      <Badge tone={tone} className="mt-0.5 gap-1.5 shrink-0">
                        <StatusDot tone={tone} />
                        {risk.level}
                      </Badge>
                      <span>{risk.text}</span>
                    </li>
                  );
                })}
              </ul>
            </Block>
          ) : null}
          {report.handoff.followUps.length > 0 ? (
            <Block label={t("followUps")}>
              <ul role="list" className="flex flex-col gap-1.5">
                {report.handoff.followUps.map((f, index) => (
                  <li
                    key={`${f}-${index}`}
                    className="flex items-start gap-2 text-sm text-fg"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-warning"
                    />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}
          {report.handoff.nextAction ? (
            <Block label={t("nextAction")}>
              <p className="text-sm text-fg">{report.handoff.nextAction}</p>
            </Block>
          ) : null}
        </CardContent>
      </Card>
      <Card className="flex flex-col gap-0">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>{t("mergeReadiness")}</CardTitle>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
            {report.mergeReadiness.mode}
          </span>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <div
            className="rounded-md border px-3 py-3"
            style={{
              backgroundColor: `hsl(var(--color-${readinessTone}-soft))`,
              borderColor: `hsl(var(--color-${readinessTone}) / 0.4)`,
            }}
          >
            <StatusPill tone={readinessTone}>
              {report.mergeReadiness.status}
            </StatusPill>
            {report.mergeReadiness.evaluatedAt ? (
              <p className="mt-2 font-mono text-[11px] text-fg-subtle">
                {t("evaluated")}{" "}
                <time dateTime={report.mergeReadiness.evaluatedAt}>
                  {report.mergeReadiness.evaluatedAt}
                </time>
              </p>
            ) : null}
          </div>
          {report.mergeReadiness.reasons.length > 0 ? (
            <Block label={t("reasons")}>
              <ul role="list" className="flex flex-col gap-1.5">
                {report.mergeReadiness.reasons.map((reason) => (
                  <li
                    key={reason.code}
                    className="flex items-start gap-2 text-sm text-fg"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-border-strong"
                    />
                    <span>{reason.message}</span>
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}
          {report.checks.length > 0 ? (
            <Block label={t("checks")}>
              <ul role="list" className="flex flex-col gap-1.5">
                {report.checks.map((check) => {
                  const tone = checkTone(check.status);
                  return (
                    <li
                      key={check.name}
                      className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-2/40 px-2.5 py-1.5 text-sm"
                    >
                      <span className="font-mono text-xs text-fg">
                        {check.name}
                      </span>
                      <Badge tone={tone} className="gap-1.5 shrink-0">
                        <StatusDot tone={tone} />
                        {check.status}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            </Block>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

function Block({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-subtle">
        {label}
      </h3>
      {children}
    </div>
  );
}
