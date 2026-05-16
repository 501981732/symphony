// @vitest-environment jsdom
import { fireEvent, screen, within } from "@testing-library/react";

import { renderWithIntl as render } from "../../test/intl";
import { describe, expect, it, vi } from "vitest";

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
    mergeRequestUrl:
      "https://gitlab.example.com/group/project/-/merge_requests/7",
    startedAt: "2026-05-12T05:00:00.000Z",
    updatedAt: "2026-05-12T05:01:00.000Z",
    turnCount: 3,
    lastEvent: {
      type: "turn_completed",
      message: "Codex turn completed",
      createdAt: "2026-05-12T05:01:00.000Z",
    },
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
    expect(
      screen.getByRole("columnheader", { name: "Turns" }),
    ).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("turn_completed")).toBeInTheDocument();
    expect(screen.getByText("ai/42-fix-flaky-test")).toBeInTheDocument();
    const mrLink = screen.getByRole("link", { name: "merge request" });
    expect(mrLink).toHaveAttribute(
      "href",
      "https://gitlab.example.com/group/project/-/merge_requests/7",
    );
  });

  it("falls back when run metadata has no turns or last event yet", () => {
    render(
      <RunsTable
        runs={[
          fixture({
            turnCount: undefined,
            lastEvent: undefined,
          }),
        ]}
      />,
    );

    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders empty-state when there are no runs", () => {
    render(<RunsTable runs={[]} />);
    expect(screen.getByText(/no active runs/i)).toBeInTheDocument();
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

  it("hides archived runs by default and toggles them via Show archived", () => {
    const archived = fixture({
      runId: "r-archived",
      status: "completed",
      archivedAt: "2026-05-15T00:00:00.000Z",
      issue: { ...fixture().issue, iid: 99, title: "archived run" },
    });
    const active = fixture({
      runId: "r-active",
      status: "completed",
      issue: { ...fixture().issue, iid: 1, title: "active run" },
    });
    render(<RunsTable runs={[active, archived]} />);

    expect(screen.getByText("active run")).toBeInTheDocument();
    expect(screen.queryByText("archived run")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /show archived/i }));
    expect(screen.getByText("archived run")).toBeInTheDocument();
  });

  it("renders RunActions Retry for a failed run", () => {
    render(<RunsTable runs={[fixture({ status: "failed" })]} />);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("invokes the supplied onRetry callback when Retry is clicked", () => {
    const onRetry = vi.fn();
    render(
      <RunsTable
        runs={[fixture({ runId: "r-1", status: "failed" })]}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledWith("r-1");
  });

  it("renders a CI badge for latestCiStatus and skips it when absent", () => {
    const { rerender } = render(
      <RunsTable
        runs={[
          fixture({
            runId: "r-ci-fail",
            latestCiStatus: "failed",
            latestCiCheckedAt: "2026-05-15T12:00:00.000Z",
          }),
        ]}
      />,
    );
    const failedBadge = screen.getByLabelText("latest ci failed");
    expect(failedBadge).toBeInTheDocument();
    expect(failedBadge).toHaveTextContent("CI failed");
    expect(failedBadge.className).toMatch(/rose/);
    expect(failedBadge).toHaveAttribute(
      "title",
      "Last checked 2026-05-15T12:00:00.000Z",
    );

    rerender(<RunsTable runs={[fixture({ runId: "r-no-ci" })]} />);
    expect(screen.queryByLabelText(/latest ci/)).not.toBeInTheDocument();
  });

  it("uses emerald tone for success and sky for running pipelines", () => {
    render(
      <RunsTable
        runs={[
          fixture({
            runId: "r-ci-success",
            latestCiStatus: "success",
            issue: { ...fixture().issue, iid: 1 },
          }),
          fixture({
            runId: "r-ci-running",
            latestCiStatus: "running",
            issue: { ...fixture().issue, iid: 2 },
          }),
        ]}
      />,
    );
    expect(screen.getByLabelText("latest ci success").className).toMatch(
      /emerald/,
    );
    expect(screen.getByLabelText("latest ci running").className).toMatch(/sky/);
  });
});
