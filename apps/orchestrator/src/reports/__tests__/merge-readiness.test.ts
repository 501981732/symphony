import { describe, expect, it } from "vitest";

import { createInitialReport } from "../lifecycle.js";
import { evaluateMergeReadiness } from "../merge-readiness.js";

function report() {
  return {
    ...createInitialReport({
      runId: "run-1",
      issue: {
        id: "issue-42",
        iid: 42,
        title: "Fix checkout",
        url: "https://gitlab.example.com/issues/42",
        projectId: "group/project",
        labels: ["human-review"],
      },
      status: "completed",
      attempt: 1,
      branch: "ai/42-fix-checkout",
      workspacePath: "/tmp/ws",
      startedAt: "2026-05-16T00:00:00.000Z",
    }),
    mergeRequest: {
      iid: 7,
      url: "https://gitlab.example.com/mr/7",
      state: "opened" as const,
      approvals: { required: 1, approvedBy: ["wangmeng5"], satisfied: true },
    },
    ci: {
      status: "success" as const,
      checkedAt: "2026-05-16T00:03:00.000Z",
    },
  };
}

describe("merge readiness dry run", () => {
  it("returns ready when all gates pass", () => {
    expect(
      evaluateMergeReadiness(report(), {
        evaluatedAt: "2026-05-16T00:04:00.000Z",
      }).status,
    ).toBe("ready");
  });

  it("blocks on missing approval", () => {
    const base = report();
    const result = evaluateMergeReadiness(
      {
        ...base,
        mergeRequest: {
          ...base.mergeRequest,
          approvals: { required: 1, approvedBy: [], satisfied: false },
        },
      },
      { evaluatedAt: "2026-05-16T00:04:00.000Z" },
    );

    expect(result.status).toBe("blocked");
    expect(result.reasons.map((r) => r.code)).toContain("approval_missing");
  });

  it("blocks on unresolved review feedback", () => {
    const result = evaluateMergeReadiness(
      {
        ...report(),
        reviewFeedback: { unresolvedCount: 2, comments: [] },
      },
      { evaluatedAt: "2026-05-16T00:04:00.000Z" },
    );

    expect(result.status).toBe("blocked");
    expect(result.reasons.map((r) => r.code)).toContain("review_unresolved");
  });

  it("returns unknown when CI is unavailable", () => {
    const { ci: _ci, ...withoutCi } = report();
    void _ci;
    const result = evaluateMergeReadiness(withoutCi, {
      evaluatedAt: "2026-05-16T00:04:00.000Z",
    });

    expect(result.status).toBe("unknown");
    expect(result.reasons.map((r) => r.code)).toContain("ci_unknown");
  });

  it("blocks on high-risk handoff items", () => {
    const base = report();
    const result = evaluateMergeReadiness(
      {
        ...base,
        handoff: {
          ...base.handoff,
          risks: [{ level: "high", text: "Touches payment flow" }],
        },
      },
      { evaluatedAt: "2026-05-16T00:04:00.000Z" },
    );

    expect(result.status).toBe("blocked");
    expect(result.reasons.map((r) => r.code)).toContain("high_risk");
  });
});
