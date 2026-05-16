import type {
  MergeReadinessReason,
  MergeReadinessResult,
  RunReportArtifact,
} from "@issuepilot/shared-contracts";

export interface MergeReadinessOptions {
  evaluatedAt: string;
  requireApproval?: boolean;
  requireCiSuccess?: boolean;
  blockOnHighRisk?: boolean;
  blockOnUnresolvedReview?: boolean;
}

export function evaluateMergeReadiness(
  report: RunReportArtifact,
  opts: MergeReadinessOptions,
): MergeReadinessResult {
  const reasons: MergeReadinessReason[] = [];

  if (report.run.status === "failed" || report.run.status === "blocked") {
    reasons.push({
      code: "run_not_successful",
      severity: "blocking",
      message: "Run is failed or blocked.",
    });
  }

  if (!report.issue.labels.includes("human-review")) {
    reasons.push({
      code: "issue_not_in_human_review",
      severity: "blocking",
      message: "Issue is not in human-review.",
    });
  }

  if (!report.mergeRequest) {
    reasons.push({
      code: "mr_missing",
      severity: "blocking",
      message: "Merge request is missing.",
    });
  } else if (report.mergeRequest.state !== "opened") {
    reasons.push({
      code: "mr_not_open",
      severity: "blocking",
      message: `Merge request state is ${report.mergeRequest.state}.`,
    });
  }

  if ((opts.requireCiSuccess ?? true) && !report.ci) {
    reasons.push({
      code: "ci_unknown",
      severity: "warning",
      message: "CI status is unavailable.",
    });
  } else if (
    (opts.requireCiSuccess ?? true) &&
    report.ci?.status !== "success"
  ) {
    reasons.push({
      code: "ci_not_success",
      severity: "blocking",
      message: `CI status is ${report.ci?.status ?? "unknown"}.`,
    });
  }

  const approvals = report.mergeRequest?.approvals;
  if ((opts.requireApproval ?? true) && approvals && !approvals.satisfied) {
    reasons.push({
      code: "approval_missing",
      severity: "blocking",
      message: "Required approval is missing.",
    });
  }

  if (
    (opts.blockOnUnresolvedReview ?? true) &&
    (report.reviewFeedback?.unresolvedCount ?? 0) > 0
  ) {
    reasons.push({
      code: "review_unresolved",
      severity: "blocking",
      message: "Unresolved review feedback is present.",
    });
  }

  if (
    (opts.blockOnHighRisk ?? true) &&
    report.handoff.risks.some((risk) => risk.level === "high")
  ) {
    reasons.push({
      code: "high_risk",
      severity: "blocking",
      message: "High-risk handoff item is present.",
    });
  }

  const blocking = reasons.some((reason) => reason.severity === "blocking");
  const warningOnly =
    reasons.length > 0 && reasons.every((reason) => reason.severity === "warning");

  return {
    mode: "dry-run",
    status: blocking ? "blocked" : warningOnly ? "unknown" : "ready",
    reasons:
      reasons.length === 0
        ? [
            {
              code: "all_checks_satisfied",
              severity: "info",
              message:
                "CI, approval, review feedback and risk checks passed.",
            },
          ]
        : reasons,
    evaluatedAt: opts.evaluatedAt,
  };
}
