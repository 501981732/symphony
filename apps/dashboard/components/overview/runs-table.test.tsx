// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RunRecord } from "@issuepilot/shared-contracts";

import { RunsTable } from "./runs-table";

function fixture(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "r-1",
    issue: {
      id: "gid://gitlab/Issue/1",
      iid: 42,
      title: "fix flaky test",
      url: "https://gitlab.example.com/group/project/-/issues/42",
      projectId: "group/project",
      labels: ["ai-running"],
    },
    status: "running",
    attempt: 1,
    branch: "ai/42-fix-flaky-test",
    workspacePath: "/home/foo/.issuepilot/workspaces/group-project/42",
    mergeRequestUrl: "https://gitlab.example.com/group/project/-/merge_requests/7",
    startedAt: "2026-05-12T05:00:00.000Z",
    updatedAt: "2026-05-12T05:01:00.000Z",
    ...overrides,
  };
}

describe("RunsTable", () => {
  it("renders one row per RunRecord with key fields", () => {
    render(<RunsTable runs={[fixture()]} />);

    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("fix flaky test")).toBeInTheDocument();
    expect(
      screen.getByText("running", { selector: "span" }),
    ).toBeInTheDocument();
    expect(screen.getByText("ai/42-fix-flaky-test")).toBeInTheDocument();
    const mrLink = screen.getByRole("link", { name: "merge request" });
    expect(mrLink).toHaveAttribute(
      "href",
      "https://gitlab.example.com/group/project/-/merge_requests/7",
    );
  });

  it("renders empty-state when there are no runs", () => {
    render(<RunsTable runs={[]} />);
    expect(
      screen.getByText(/no active runs/i),
    ).toBeInTheDocument();
  });

  it("links to /runs/:runId detail page", () => {
    render(<RunsTable runs={[fixture({ runId: "r-xyz" })]} />);
    const link = screen.getByRole("link", { name: "detail of r-xyz" });
    expect(link).toHaveAttribute("href", "/runs/r-xyz");
  });

  it("sorts by iid ascending when the Issue header is clicked", () => {
    render(
      <RunsTable
        runs={[
          fixture({
            runId: "r-2",
            issue: { ...fixture().issue, iid: 100 },
          }),
          fixture({
            runId: "r-1",
            issue: { ...fixture().issue, iid: 7 },
          }),
        ]}
      />,
    );

    const issueHeader = screen.getByRole("columnheader", { name: /^Issue/ });
    expect(issueHeader).toHaveAttribute("aria-sort", "none");

    fireEvent.click(issueHeader);
    expect(issueHeader).toHaveAttribute("aria-sort", "ascending");

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("#7")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("#100")).toBeInTheDocument();

    fireEvent.click(issueHeader);
    expect(issueHeader).toHaveAttribute("aria-sort", "descending");
  });
});
