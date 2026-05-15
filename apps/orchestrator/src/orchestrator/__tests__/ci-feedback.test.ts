import { describe, expect, it, vi } from "vitest";

import type {
  IssuePilotInternalEvent,
  PipelineStatus,
} from "@issuepilot/shared-contracts";
import { createEventBus } from "@issuepilot/observability";

import { scanCiFeedbackOnce } from "../ci-feedback.js";
import { createRuntimeState, type RunEntry } from "../../runtime/state.js";

function makeIssue(iid: number, labels: string[]): RunEntry["issue"] {
  return {
    id: String(iid),
    iid,
    title: `Issue ${iid}`,
    url: `https://gitlab.example.com/g/p/-/issues/${iid}`,
    projectId: "g/p",
    labels,
  } as RunEntry["issue"];
}

function seedReviewRun(
  state: ReturnType<typeof createRuntimeState>,
  overrides: {
    runId?: string;
    branch?: string;
    iid?: number;
    labels?: string[];
    status?: string;
    archivedAt?: string;
  } = {},
): string {
  const runId = overrides.runId ?? "run-1";
  state.setRun(runId, {
    runId,
    status: overrides.status ?? "completed",
    attempt: 1,
    branch: overrides.branch ?? "ai/1-fix",
    workspacePath: "/tmp/run",
    startedAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:01.000Z",
    issue: makeIssue(
      overrides.iid ?? 1,
      overrides.labels ?? ["human-review"],
    ),
    ...(overrides.archivedAt ? { archivedAt: overrides.archivedAt } : {}),
  });
  return runId;
}

function createDeps(opts: {
  status?: PipelineStatus;
  throwLookup?: Error;
  mr?:
    | {
        iid: number;
        webUrl: string;
        state: string;
        sourceBranch: string;
        title: string;
        description: string;
      }
    | null;
  pipelineWebUrl?: string;
  ci?: {
    enabled?: boolean;
    onFailure?: "ai-rework" | "human-review";
    waitForPipeline?: boolean;
  };
}) {
  const events: IssuePilotInternalEvent[] = [];
  const eventBus = createEventBus<IssuePilotInternalEvent>();
  eventBus.subscribe((e) => events.push(e));
  const state = createRuntimeState();

  const gitlab = {
    findMergeRequestBySourceBranch: vi.fn(
      async (_: string) =>
        opts.mr === undefined
          ? {
              iid: 17,
              webUrl: "https://gitlab.example.com/g/p/-/merge_requests/17",
              state: "opened",
              sourceBranch: "ai/1-fix",
              title: "Fix",
              description: "",
            }
          : opts.mr,
    ),
    getPipelineStatus: vi.fn(async (_: string) => {
      if (opts.throwLookup) throw opts.throwLookup;
      return opts.status ?? "success";
    }),
    transitionLabels: vi.fn(async () => {}),
    createIssueNote: vi.fn(async () => ({ id: 1 })),
  };

  const workflow = {
    tracker: {
      handoffLabel: "human-review",
      reworkLabel: "ai-rework",
    },
    ci: {
      enabled: opts.ci?.enabled ?? true,
      onFailure: opts.ci?.onFailure ?? "ai-rework",
      waitForPipeline: opts.ci?.waitForPipeline ?? true,
    },
  };

  return {
    events,
    state,
    eventBus,
    gitlab,
    deps: {
      state,
      gitlab,
      workflow,
      eventBus,
      now: () => new Date("2026-05-15T12:00:00.000Z"),
    },
  };
}

describe("scanCiFeedbackOnce", () => {
  it("emits ci_status_observed (no_mr) when the run has no associated MR", async () => {
    const ctx = createDeps({ mr: null });
    const runId = seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.findMergeRequestBySourceBranch).toHaveBeenCalledWith(
      "ai/1-fix",
    );
    expect(ctx.gitlab.getPipelineStatus).not.toHaveBeenCalled();
    expect(ctx.gitlab.transitionLabels).not.toHaveBeenCalled();
    expect(ctx.events.map((e) => e.type)).toEqual(["ci_status_observed"]);
    expect(ctx.events[0]).toMatchObject({
      runId,
      type: "ci_status_observed",
      data: { reason: "no_mr" },
    });
  });

  it("emits ci_status_observed (success) and keeps labels unchanged", async () => {
    const ctx = createDeps({ status: "success" });
    const runId = seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.transitionLabels).not.toHaveBeenCalled();
    const types = ctx.events.map((e) => e.type);
    expect(types).toEqual(["ci_status_observed"]);
    expect(ctx.events[0]).toMatchObject({
      runId,
      data: { status: "success", action: "noop" },
    });
    const run = ctx.state.getRun(runId);
    expect(run?.["latestCiStatus"]).toBe("success");
    expect(run?.["latestCiCheckedAt"]).toBe("2026-05-15T12:00:00.000Z");
  });

  it("emits ci_status_rework_triggered, transitions labels, and writes a marker note on failure", async () => {
    const ctx = createDeps({ status: "failed" });
    const runId = seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.transitionLabels).toHaveBeenCalledWith(1, {
      add: ["ai-rework"],
      remove: ["human-review"],
    });
    expect(ctx.gitlab.createIssueNote).toHaveBeenCalledWith(
      1,
      expect.stringContaining(`<!-- issuepilot:ci-feedback:${runId} -->`),
    );
    const types = ctx.events.map((e) => e.type);
    expect(types).toEqual(["ci_status_rework_triggered"]);
    expect(ctx.events[0]).toMatchObject({
      runId,
      data: { status: "failed", action: "rework" },
    });
    const run = ctx.state.getRun(runId);
    expect(run?.["latestCiStatus"]).toBe("failed");
  });

  it("emits ci_status_observed (failed/no_action) when on_failure is human-review", async () => {
    const ctx = createDeps({
      status: "failed",
      ci: { onFailure: "human-review" },
    });
    const runId = seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.transitionLabels).not.toHaveBeenCalled();
    expect(ctx.gitlab.createIssueNote).not.toHaveBeenCalled();
    expect(ctx.events.map((e) => e.type)).toEqual(["ci_status_observed"]);
    expect(ctx.events[0]).toMatchObject({
      runId,
      data: { status: "failed", action: "noop" },
    });
  });

  it("does nothing besides ci_status_observed when pipeline is running/pending", async () => {
    for (const status of ["running", "pending"] as const) {
      const ctx = createDeps({ status });
      const runId = seedReviewRun(ctx.state);

      await scanCiFeedbackOnce(ctx.deps);

      expect(ctx.gitlab.transitionLabels).not.toHaveBeenCalled();
      expect(ctx.gitlab.createIssueNote).not.toHaveBeenCalled();
      expect(ctx.events.map((e) => e.type)).toEqual(["ci_status_observed"]);
      expect(ctx.events[0]).toMatchObject({
        runId,
        data: { status, action: "wait" },
      });
    }
  });

  it("emits ci_status_observed (canceled) and prompts manual review without changing labels", async () => {
    const ctx = createDeps({ status: "canceled" });
    const runId = seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.transitionLabels).not.toHaveBeenCalled();
    expect(ctx.gitlab.createIssueNote).toHaveBeenCalledWith(
      1,
      expect.stringContaining(`<!-- issuepilot:ci-feedback:${runId} -->`),
    );
    expect(ctx.events[0]).toMatchObject({
      runId,
      data: { status: "canceled", action: "manual" },
    });
  });

  it("emits ci_status_lookup_failed when getPipelineStatus throws", async () => {
    const ctx = createDeps({ throwLookup: new Error("kaboom") });
    const runId = seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.transitionLabels).not.toHaveBeenCalled();
    expect(ctx.events.map((e) => e.type)).toEqual(["ci_status_lookup_failed"]);
    expect(ctx.events[0]).toMatchObject({
      runId,
      data: { reason: "lookup_failed", message: "kaboom" },
    });
    const run = ctx.state.getRun(runId);
    expect(run?.["latestCiStatus"]).toBeUndefined();
  });

  it("skips disabled (ci.enabled=false) without touching GitLab", async () => {
    const ctx = createDeps({ ci: { enabled: false } });
    seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.findMergeRequestBySourceBranch).not.toHaveBeenCalled();
    expect(ctx.events).toEqual([]);
  });

  it("ignores runs without the handoff label", async () => {
    const ctx = createDeps({});
    seedReviewRun(ctx.state, { labels: ["ai-running"] });

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.findMergeRequestBySourceBranch).not.toHaveBeenCalled();
    expect(ctx.events).toEqual([]);
  });

  it("ignores archived runs", async () => {
    const ctx = createDeps({});
    seedReviewRun(ctx.state, {
      archivedAt: "2026-05-14T00:00:00.000Z",
    });

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.findMergeRequestBySourceBranch).not.toHaveBeenCalled();
    expect(ctx.events).toEqual([]);
  });

  it("writes the marker note exactly once and keeps the same labels across reruns", async () => {
    const ctx = createDeps({ status: "failed" });
    seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);
    // simulate that GitLab moved labels for us
    seedReviewRun(ctx.state, { labels: ["ai-rework"] });
    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.createIssueNote).toHaveBeenCalledTimes(1);
  });
});
