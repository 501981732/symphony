import { describe, expect, it } from "vitest";

import {
  createInitialReport,
  markReportFailed,
  updateReportHandoff,
} from "../lifecycle.js";

describe("report lifecycle", () => {
  it("creates an initial unknown-readiness report at claim time", () => {
    const report = createInitialReport({
      runId: "run-1",
      issue: {
        id: "issue-42",
        iid: 42,
        title: "Fix checkout",
        url: "https://gitlab.example.com/issues/42",
        projectId: "group/project",
        labels: ["ai-running"],
      },
      status: "running",
      attempt: 1,
      branch: "ai/42-fix-checkout",
      workspacePath: "/tmp/ws",
      startedAt: "2026-05-16T00:00:00.000Z",
    });

    expect(report.mergeReadiness).toEqual({
      mode: "dry-run",
      status: "unknown",
      reasons: [
        {
          code: "run_not_in_review",
          severity: "warning",
          message: "Run has not reached human-review yet.",
        },
      ],
      evaluatedAt: "2026-05-16T00:00:00.000Z",
    });
    expect(report.handoff.summary).toBe("not reported");
    expect(report.diff.summary).toBe("not available");
  });

  it("updates handoff fields without losing existing run metadata", () => {
    const report = createInitialReport({
      runId: "run-1",
      issue: {
        id: "issue-42",
        iid: 42,
        title: "Fix checkout",
        url: "https://gitlab.example.com/issues/42",
        projectId: "group/project",
        labels: ["ai-running"],
      },
      status: "running",
      attempt: 1,
      branch: "ai/42-fix-checkout",
      workspacePath: "/tmp/ws",
      startedAt: "2026-05-16T00:00:00.000Z",
    });

    const next = updateReportHandoff(report, {
      summary: "Updated checkout copy.",
      validation: ["pnpm test passed"],
      risks: [{ level: "low", text: "Copy-only." }],
      followUps: [],
      nextAction: "Review and merge the MR.",
    });

    expect(next.run.branch).toBe("ai/42-fix-checkout");
    expect(next.handoff.summary).toBe("Updated checkout copy.");
    expect(next.handoff.validation).toEqual(["pnpm test passed"]);
  });

  it("records failure classification on the run", () => {
    const report = createInitialReport({
      runId: "run-1",
      issue: {
        id: "issue-42",
        iid: 42,
        title: "Fix checkout",
        url: "https://gitlab.example.com/issues/42",
        projectId: "group/project",
        labels: ["ai-running"],
      },
      status: "running",
      attempt: 1,
      branch: "ai/42-fix-checkout",
      workspacePath: "/tmp/ws",
      startedAt: "2026-05-16T00:00:00.000Z",
    });

    const failed = markReportFailed(report, {
      status: "blocked",
      endedAt: "2026-05-16T00:02:00.000Z",
      lastError: {
        code: "missing_secret",
        message: "GITLAB_TOKEN is missing.",
        classification: "blocked",
      },
    });

    expect(failed.run.status).toBe("blocked");
    expect(failed.run.lastError?.code).toBe("missing_secret");
    expect(failed.run.durations.totalMs).toBe(120000);
  });
});
