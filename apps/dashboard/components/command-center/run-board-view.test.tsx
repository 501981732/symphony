// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RunWithReport } from "../../lib/api";
import { renderWithIntl as render } from "../../test/intl";

import { RunBoardView } from "./run-board-view";

const sampleRun: RunWithReport = {
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
  updatedAt: "2026-05-16T00:05:00.000Z",
};

describe("RunBoardView", () => {
  it("groups runs by workflow label", () => {
    render(
      <RunBoardView
        runs={[sampleRun]}
        selectedRunId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "human-review" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Fix checkout")).toBeInTheDocument();
  });

  it("ignores runs without a workflow label", () => {
    render(
      <RunBoardView
        runs={[{ ...sampleRun, issue: { ...sampleRun.issue, labels: [] } }]}
        selectedRunId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByText("Fix checkout")).not.toBeInTheDocument();
  });

  it("calls onSelect when a card is clicked", () => {
    const onSelect = vi.fn();
    render(
      <RunBoardView
        runs={[sampleRun]}
        selectedRunId={null}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Fix checkout/ }));
    expect(onSelect).toHaveBeenCalledWith("run-1");
  });
});
