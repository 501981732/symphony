import { describe, expect, it } from "vitest";

import { createInitialReport, updateReportHandoff } from "../lifecycle.js";
import {
  renderClosingNote,
  renderFailureNote,
  renderHandoffNote,
} from "../render.js";

function report() {
  return updateReportHandoff(
    {
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
        url: "https://gitlab.example.com/group/project/-/merge_requests/7",
        state: "opened",
      },
    },
    {
      summary: "Updated checkout copy.",
      validation: ["pnpm test passed"],
      risks: [{ level: "low", text: "Copy-only." }],
      followUps: [],
      nextAction: "Review and merge the MR.",
    },
  );
}

describe("report renderers", () => {
  it("renders the handoff note from report fields", () => {
    const body = renderHandoffNote(report(), { handoffLabel: "human-review" });
    expect(body).toContain("<!-- issuepilot:run:run-1 -->");
    expect(body).toContain("## IssuePilot handoff");
    expect(body).toContain("- Status: human-review");
    expect(body).toContain(
      "- MR: !7 https://gitlab.example.com/group/project/-/merge_requests/7",
    );
    expect(body).toContain("### What changed\nUpdated checkout copy.");
    expect(body).toContain("### Validation\n- pnpm test passed");
    expect(body).toContain("### Risks / follow-ups\n- low: Copy-only.");
  });

  it("renders failure notes with lastError", () => {
    const base = report();
    const failed = {
      ...base,
      run: {
        ...base.run,
        status: "blocked" as const,
        lastError: {
          code: "missing_secret",
          message: "GITLAB_TOKEN is missing.",
          classification: "blocked" as const,
        },
      },
    };
    const body = renderFailureNote(failed, {
      statusLabel: "ai-blocked",
      readyLabel: "ai-ready",
    });
    expect(body).toContain("## IssuePilot run blocked");
    expect(body).toContain("- Status: ai-blocked");
    expect(body).toContain("GITLAB_TOKEN is missing.");
    expect(body).toContain("move this Issue back to `ai-ready`");
  });

  it("renders closing notes from merged MR state", () => {
    const base = report();
    const closed = {
      ...base,
      mergeRequest: {
        iid: 7,
        url: "https://gitlab.example.com/group/project/-/merge_requests/7",
        state: "merged" as const,
      },
    };
    const body = renderClosingNote(closed, { handoffLabel: "human-review" });
    expect(body).toContain("## IssuePilot closed this issue");
    expect(body).toContain("- Status: closed");
    expect(body).toContain(
      "- MR: !7 https://gitlab.example.com/group/project/-/merge_requests/7",
    );
  });
});
