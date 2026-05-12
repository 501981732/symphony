// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  IssuePilotEvent,
  OrchestratorStateSnapshot,
  RunRecord,
} from "@issuepilot/shared-contracts";

import { __setEventSourceFactory } from "../../lib/use-event-stream";
import { OverviewPage } from "./overview-page";

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

const baseSnapshot: OrchestratorStateSnapshot = {
  service: {
    status: "ready",
    workflowPath: ".agents/workflow.md",
    gitlabProject: "group/project",
    pollIntervalMs: 10_000,
    concurrency: 1,
    lastConfigReloadAt: null,
    lastPollAt: null,
  },
  summary: {
    running: 0,
    retrying: 0,
    "human-review": 0,
    failed: 0,
    blocked: 0,
  },
};

beforeEach(() => {
  FakeES.instances = [];
  __setEventSourceFactory((url) => new FakeES(url) as never);
});

afterEach(() => {
  vi.useRealTimers();
  __setEventSourceFactory(null);
  vi.restoreAllMocks();
});

function renderPage(initialRuns: RunRecord[] = []) {
  const refetch = vi.fn(async () => ({
    snapshot: baseSnapshot,
    runs: initialRuns,
  }));
  const utils = render(
    <OverviewPage
      initialSnapshot={baseSnapshot}
      initialRuns={initialRuns}
      refetch={refetch}
    />,
  );
  return { ...utils, refetch };
}

describe("OverviewPage", () => {
  it("renders service header, summary cards and runs table", () => {
    renderPage();
    expect(screen.getByText("IssuePilot Dashboard")).toBeInTheDocument();
    expect(screen.getByText("ready", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText(/no active runs/i)).toBeInTheDocument();
  });

  it("re-fetches (throttled 1s) when a run lifecycle event arrives", async () => {
    vi.useFakeTimers();
    const { refetch } = renderPage();
    expect(FakeES.instances).toHaveLength(1);

    act(() => {
      FakeES.instances[0]!.emit({
        id: "e1",
        runId: "r1",
        issue: {
          id: "gid://gitlab/Issue/1",
          iid: 1,
          title: "t",
          url: "https://x",
          projectId: "p",
        },
        type: "run_completed",
        message: "done",
        createdAt: "2026-05-12T05:00:00Z",
      });
    });

    expect(refetch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
