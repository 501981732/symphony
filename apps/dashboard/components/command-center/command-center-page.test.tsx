// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunWithReport } from "../../lib/api";
import { __setEventSourceFactory } from "../../lib/use-event-stream";
import { renderWithIntl as render } from "../../test/intl";

import { CommandCenterPage } from "./command-center-page";

class FakeES {
  public closed = false;
  public onmessage: ((ev: { data: string }) => void) | null = null;
  public onerror: ((ev: unknown) => void) | null = null;
  public onopen: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {}
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  __setEventSourceFactory((url) => new FakeES(url) as never);
});

afterEach(() => {
  __setEventSourceFactory(null);
  vi.restoreAllMocks();
});

const runs: RunWithReport[] = [
  {
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
    report: {
      runId: "run-1",
      issueIid: 42,
      issueTitle: "Fix checkout",
      projectId: "group/project",
      status: "completed",
      labels: ["human-review"],
      attempt: 1,
      branch: "ai/42-fix-checkout",
      mergeRequestUrl: "https://gitlab.example.com/mr/7",
      ciStatus: "success",
      mergeReadinessStatus: "ready",
      highestRisk: "low",
      updatedAt: "2026-05-16T00:05:00.000Z",
      totalMs: 300000,
    },
  },
];

describe("CommandCenterPage", () => {
  it("renders list view and opens inspector from a run row", () => {
    render(
      <CommandCenterPage
        initialSnapshot={{
          service: {
            status: "ready",
            workflowPath: "/repo/WORKFLOW.md",
            gitlabProject: "group/project",
            pollIntervalMs: 10000,
            concurrency: 2,
            lastConfigReloadAt: null,
            lastPollAt: null,
          },
          summary: {
            running: 0,
            retrying: 0,
            "human-review": 1,
            failed: 0,
            blocked: 0,
          },
        }}
        initialRuns={runs}
        refetch={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Command Center" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Fix checkout/ }));
    expect(screen.getByText("Review Packet")).toBeInTheDocument();
    expect(screen.getAllByText("ready").length).toBeGreaterThan(0);
  });

  it("switches to board view when toggle is clicked", () => {
    render(
      <CommandCenterPage
        initialSnapshot={{
          service: {
            status: "ready",
            workflowPath: "/repo/WORKFLOW.md",
            gitlabProject: "group/project",
            pollIntervalMs: 10000,
            concurrency: 2,
            lastConfigReloadAt: null,
            lastPollAt: null,
          },
          summary: {
            running: 0,
            retrying: 0,
            "human-review": 1,
            failed: 0,
            blocked: 0,
          },
        }}
        initialRuns={runs}
        refetch={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(
      screen.getByRole("heading", { name: "human-review" }),
    ).toBeInTheDocument();
  });
});
