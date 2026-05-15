// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IssuePilotEvent, RunRecord } from "@issuepilot/shared-contracts";

import { __setEventSourceFactory } from "../../lib/use-event-stream";
import { RunDetailPage } from "./run-detail-page";

class FakeES {
  static instances: FakeES[] = [];
  public url: string;
  public onmessage: ((ev: { data: string }) => void) | null = null;
  public onerror: ((ev: unknown) => void) | null = null;
  public onopen: ((ev: unknown) => void) | null = null;
  public closed = false;

  constructor(url: string) {
    this.url = url;
    FakeES.instances.push(this);
  }

  emit(event: IssuePilotEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  close() {
    this.closed = true;
  }
}

const run: RunRecord = {
  runId: "r1",
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
};

const initialEvent: IssuePilotEvent = {
  id: "e1",
  runId: "r1",
  issue: {
    id: run.issue.id,
    iid: run.issue.iid,
    title: run.issue.title,
    url: run.issue.url,
    projectId: run.issue.projectId,
  },
  type: "run_started",
  message: "started",
  createdAt: "2026-05-12T05:00:00.000Z",
};

beforeEach(() => {
  FakeES.instances = [];
  __setEventSourceFactory((url) => new FakeES(url) as never);
});

afterEach(() => {
  __setEventSourceFactory(null);
});

describe("RunDetailPage", () => {
  it("renders issue header, MR link, branch and seeded events", () => {
    render(
      <RunDetailPage
        run={run}
        initialEvents={[initialEvent]}
        logsTail={["log line 1"]}
      />,
    );

    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("fix flaky test")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "merge request" })).toHaveAttribute(
      "href",
      "https://gitlab.example.com/group/project/-/merge_requests/7",
    );
    expect(screen.getByText("started")).toBeInTheDocument();
    expect(screen.getByText(/log line 1/)).toBeInTheDocument();
  });

  it("subscribes to events scoped by runId and appends live events", () => {
    render(
      <RunDetailPage run={run} initialEvents={[initialEvent]} logsTail={[]} />,
    );
    expect(FakeES.instances).toHaveLength(1);
    expect(FakeES.instances[0]!.url).toContain("runId=r1");

    act(() => {
      FakeES.instances[0]!.emit({
        id: "e2",
        runId: "r1",
        issue: initialEvent.issue,
        type: "notification",
        message: "live event",
        createdAt: "2026-05-12T05:01:00.000Z",
      });
    });

    expect(screen.getByText("live event")).toBeInTheDocument();
  });

  it("ignores duplicate events with the same id", () => {
    render(
      <RunDetailPage run={run} initialEvents={[initialEvent]} logsTail={[]} />,
    );

    act(() => {
      FakeES.instances[0]!.emit(initialEvent);
    });

    expect(screen.getAllByText("started")).toHaveLength(1);
  });
});
