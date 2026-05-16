// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReviewPacket } from "./review-packet";

describe("ReviewPacket", () => {
  it("renders handoff, checks and merge readiness from report", () => {
    render(
      <ReviewPacket
        report={{
          version: 1,
          runId: "run-1",
          issue: {
            projectId: "group/project",
            iid: 42,
            title: "Fix checkout",
            url: "https://gitlab.example.com/issues/42",
            labels: ["human-review"],
          },
          run: {
            status: "completed",
            attempt: 1,
            branch: "ai/42-fix-checkout",
            workspacePath: "/tmp/ws",
            startedAt: "2026-05-16T00:00:00.000Z",
            durations: {},
          },
          handoff: {
            summary: "Updated checkout copy.",
            validation: ["pnpm test passed"],
            risks: [{ level: "low", text: "Copy-only." }],
            followUps: [],
            nextAction: "Review and merge the MR.",
          },
          diff: {
            summary: "1 file changed",
            filesChanged: 1,
            notableFiles: ["apps/dashboard/app/page.tsx"],
          },
          checks: [{ name: "dashboard tests", status: "passed" }],
          mergeReadiness: {
            mode: "dry-run",
            status: "ready",
            reasons: [
              {
                code: "all_checks_satisfied",
                severity: "info",
                message: "CI, approval, review feedback and risk checks passed.",
              },
            ],
            evaluatedAt: "2026-05-16T00:05:00.000Z",
          },
          notes: {},
        }}
      />,
    );

    expect(screen.getByText("Updated checkout copy.")).toBeInTheDocument();
    expect(screen.getByText("pnpm test passed")).toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.getByText("dashboard tests")).toBeInTheDocument();
  });
});
