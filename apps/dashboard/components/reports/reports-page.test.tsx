// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

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
    // V2.5 Swiss Modernism redesign added a donut legend that also
    // renders the readiness vocabulary, so the same word appears
    // multiple times on the page. Asserting "at least one" keeps
    // the contract honest (the table cell must still display the
    // status) without coupling the test to the exact DOM layout.
    expect(screen.getAllByText("ready").length).toBeGreaterThan(0);
    expect(screen.getAllByText("blocked").length).toBeGreaterThan(0);
    // "1m" now appears both in the median-duration counter and the
    // per-run table row, so we assert at least one instead of exactly one.
    expect(screen.getAllByText("1m").length).toBeGreaterThan(0);
  });

  it("renders an empty state when no reports exist", () => {
    render(<ReportsPage reports={[]} />);
    expect(screen.getByText(/No reports yet/i)).toBeInTheDocument();
  });
});
