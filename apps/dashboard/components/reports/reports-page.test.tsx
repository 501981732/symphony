// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReportsPage } from "./reports-page";

describe("ReportsPage", () => {
  it("renders counters and table rows", () => {
    render(
      <ReportsPage
        reports={[
          {
            runId: "run-1",
            issueIid: 42,
            issueTitle: "Fix checkout",
            projectId: "group/project",
            status: "completed",
            labels: ["human-review"],
            attempt: 1,
            branch: "ai/42",
            mergeReadinessStatus: "ready",
            updatedAt: "2026-05-16T00:00:00.000Z",
            totalMs: 60000,
          },
          {
            runId: "run-2",
            issueIid: 43,
            issueTitle: "Refactor login",
            projectId: "group/project",
            status: "failed",
            labels: ["ai-failed"],
            attempt: 2,
            branch: "ai/43",
            mergeReadinessStatus: "blocked",
            updatedAt: "2026-05-16T00:01:00.000Z",
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Reports" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Fix checkout")).toBeInTheDocument();
    expect(screen.getByText("Refactor login")).toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.getByText("blocked")).toBeInTheDocument();
    expect(screen.getByText("1m")).toBeInTheDocument();
  });

  it("renders an empty state when no reports exist", () => {
    render(<ReportsPage reports={[]} />);
    expect(screen.getByText(/No reports yet/i)).toBeInTheDocument();
  });
});
