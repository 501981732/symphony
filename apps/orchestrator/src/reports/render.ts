import type { RunReportArtifact } from "@issuepilot/shared-contracts";

function marker(report: RunReportArtifact): string {
  return `<!-- issuepilot:run:${report.runId} -->`;
}

function mrLine(report: RunReportArtifact): string {
  const mr = report.mergeRequest;
  if (!mr) return "not created";
  return `!${mr.iid} ${mr.url}`;
}

function bulletList(values: readonly string[]): string {
  return values.length === 0
    ? "not reported"
    : values.map((v) => `- ${v}`).join("\n");
}

function riskList(report: RunReportArtifact): string {
  return report.handoff.risks.length === 0
    ? "None reported."
    : report.handoff.risks
        .map((risk) => `- ${risk.level}: ${risk.text}`)
        .join("\n");
}

export function renderHandoffNote(
  report: RunReportArtifact,
  opts: { handoffLabel: string },
): string {
  return [
    marker(report),
    "## IssuePilot handoff",
    "",
    `- Status: ${opts.handoffLabel}`,
    `- Run: \`${report.runId}\``,
    `- Attempt: ${report.run.attempt}`,
    `- Branch: \`${report.run.branch}\``,
    `- MR: ${mrLine(report)}`,
    "",
    "### What changed",
    report.handoff.summary,
    "",
    "### Validation",
    bulletList(report.handoff.validation),
    "",
    "### Risks / follow-ups",
    riskList(report),
    "",
    "### Next action",
    report.handoff.nextAction,
  ].join("\n");
}

export function renderFailureNote(
  report: RunReportArtifact,
  opts: { statusLabel: string; readyLabel: string },
): string {
  const blocked = report.run.status === "blocked";
  const title = blocked
    ? "## IssuePilot run blocked"
    : "## IssuePilot run failed";
  const error = report.run.lastError;
  return [
    title,
    "",
    `- Status: ${opts.statusLabel}`,
    `- Run: \`${report.runId}\``,
    `- Attempt: ${report.run.attempt}`,
    `- Branch: \`${report.run.branch}\``,
    "",
    "### Reason",
    error ? `${error.code}: ${error.message}` : "unknown",
    "",
    "### Next action",
    `Provide the missing information, permission, or fix, then move this Issue back to \`${opts.readyLabel}\`.`,
  ].join("\n");
}

export function renderClosingNote(
  report: RunReportArtifact,
  opts: { handoffLabel: string },
): string {
  return [
    "## IssuePilot closed this issue",
    "",
    "- Status: closed",
    `- Run: \`${report.runId}\``,
    `- Branch: \`${report.run.branch}\``,
    `- MR: ${mrLine(report)}`,
    "",
    "### Result",
    `The linked MR was merged by a human reviewer, so IssuePilot removed \`${opts.handoffLabel}\` and closed this Issue.`,
  ].join("\n");
}
