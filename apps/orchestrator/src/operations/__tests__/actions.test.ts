import { createEventBus } from "@issuepilot/observability";
import type { IssuePilotInternalEvent } from "@issuepilot/shared-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntimeState, type RunEntry } from "../../runtime/state.js";
import { createRunCancelRegistry } from "../../runtime/run-cancel-registry.js";
import { archiveRun, retryRun, stopRun } from "../actions.js";

function seedRun(
  state: ReturnType<typeof createRuntimeState>,
  overrides: Partial<{
    runId: string;
    status: string;
    attempt: number;
    archivedAt: string;
  }> = {},
): string {
  const runId = overrides.runId ?? "run-1";
  const record: RunEntry = {
    runId,
    issue: {
      id: "1",
      iid: 1,
      title: "Fix",
      url: "https://gitlab.example.com/g/p/-/issues/1",
      projectId: "g/p",
      labels: ["ai-running"],
    },
    status: overrides.status ?? "running",
    attempt: overrides.attempt ?? 1,
    branch: "ai/1-fix",
    workspacePath: "/tmp/run",
    startedAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:01.000Z",
    ...(overrides.archivedAt ? { archivedAt: overrides.archivedAt } : {}),
  };
  state.setRun(runId, record);
  return runId;
}

function createDeps() {
  const events: IssuePilotInternalEvent[] = [];
  const eventBus = createEventBus<IssuePilotInternalEvent>();
  eventBus.subscribe((e) => events.push(e));
  const state = createRuntimeState();
  const runCancelRegistry = createRunCancelRegistry();
  const gitlab = {
    transitionLabels: vi.fn(async () => {}),
  };
  const workflow = {
    tracker: {
      runningLabel: "ai-running",
      reworkLabel: "ai-rework",
      failedLabel: "ai-failed",
      blockedLabel: "ai-blocked",
    },
  };
  return {
    deps: {
      state,
      eventBus,
      runCancelRegistry,
      gitlab,
      workflow,
      now: () => new Date("2026-05-15T12:00:00.000Z"),
    },
    events,
    runCancelRegistry,
    gitlab,
  };
}

describe("retryRun", () => {
  it("transitions a failed run to claimed with attempt+1 and labels ai-rework", async () => {
    const { deps, events, gitlab } = createDeps();
    const runId = seedRun(deps.state, { status: "failed", attempt: 2 });

    const result = await retryRun({ runId, operator: "system" }, deps);

    expect(result.ok).toBe(true);
    expect(gitlab.transitionLabels).toHaveBeenCalledWith(1, {
      add: ["ai-rework"],
      remove: ["ai-running", "ai-failed", "ai-blocked"],
    });
    const run = deps.state.getRun(runId);
    expect(run?.status).toBe("claimed");
    expect(run?.attempt).toBe(3);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "operator_action_requested",
      "operator_action_succeeded",
    ]);
  });

  it("accepts retry from blocked status", async () => {
    const { deps } = createDeps();
    const runId = seedRun(deps.state, { status: "blocked", attempt: 1 });
    const result = await retryRun({ runId, operator: "system" }, deps);
    expect(result.ok).toBe(true);
  });

  it("returns invalid_status for a running run", async () => {
    const { deps, events, gitlab } = createDeps();
    const runId = seedRun(deps.state, { status: "running" });

    const result = await retryRun({ runId, operator: "system" }, deps);

    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("invalid_status");
    expect(gitlab.transitionLabels).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe("operator_action_failed");
  });

  it("returns not_found when run does not exist", async () => {
    const { deps } = createDeps();
    const result = await retryRun(
      { runId: "ghost", operator: "system" },
      deps,
    );
    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("not_found");
  });

  it("rolls back state when transitionLabels throws", async () => {
    const { deps, events, gitlab } = createDeps();
    const runId = seedRun(deps.state, { status: "failed", attempt: 1 });
    (gitlab.transitionLabels as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("network down"),
    );

    const result = await retryRun({ runId, operator: "system" }, deps);

    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("gitlab_failed");
    const run = deps.state.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.attempt).toBe(1);
    expect(events.at(-1)?.type).toBe("operator_action_failed");
  });
});

describe("stopRun", () => {
  it("returns invalid_status for a non-running run", async () => {
    const { deps, events, runCancelRegistry } = createDeps();
    const cancel = vi.fn(async () => {});
    runCancelRegistry.register("run-1", cancel);
    const runId = seedRun(deps.state, { status: "failed" });

    const result = await stopRun({ runId, operator: "system" }, deps);

    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("invalid_status");
    expect(cancel).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe("operator_action_failed");
  });

  it("invokes cancel and emits succeeded when registry returns ok", async () => {
    const { deps, events, runCancelRegistry } = createDeps();
    const cancel = vi.fn(async () => {});
    runCancelRegistry.register("run-1", cancel);
    const runId = seedRun(deps.state, { status: "running" });

    const result = await stopRun({ runId, operator: "system" }, deps);

    expect(result.ok).toBe(true);
    expect(cancel).toHaveBeenCalled();
    expect(deps.state.getRun(runId)?.status).toBe("running");
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "operator_action_requested",
      "operator_action_succeeded",
    ]);
  });

  it("marks run as stopping when cancel times out", async () => {
    const { deps, events, runCancelRegistry } = createDeps();
    vi.useFakeTimers();
    runCancelRegistry.register("run-1", () => new Promise<void>(() => {}));
    const runId = seedRun(deps.state, { status: "running" });

    const promise = stopRun(
      { runId, operator: "system", cancelTimeoutMs: 50 },
      deps,
    );
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("cancel_failed");
    expect((result as { reason?: string }).reason).toBe("cancel_timeout");
    expect(deps.state.getRun(runId)?.status).toBe("stopping");
    expect(events.at(-1)?.type).toBe("operator_action_failed");
  });

  it("marks run as stopping when cancel throws", async () => {
    const { deps, events, runCancelRegistry } = createDeps();
    runCancelRegistry.register("run-1", async () => {
      throw new Error("rpc closed");
    });
    const runId = seedRun(deps.state, { status: "running" });

    const result = await stopRun({ runId, operator: "system" }, deps);

    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("cancel_threw");
    expect(deps.state.getRun(runId)?.status).toBe("stopping");
    expect(events.at(-1)?.type).toBe("operator_action_failed");
  });

  it("marks run as stopping when no cancel is registered", async () => {
    const { deps, events } = createDeps();
    const runId = seedRun(deps.state, { status: "running" });

    const result = await stopRun({ runId, operator: "system" }, deps);

    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("not_registered");
    expect(deps.state.getRun(runId)?.status).toBe("stopping");
    expect(events.at(-1)?.type).toBe("operator_action_failed");
  });

  it("returns not_found when run does not exist", async () => {
    const { deps } = createDeps();
    const result = await stopRun({ runId: "ghost", operator: "system" }, deps);
    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("not_found");
  });
});

describe("archiveRun", () => {
  it("sets archivedAt on a terminal run", async () => {
    const { deps, events } = createDeps();
    const runId = seedRun(deps.state, { status: "failed" });

    const result = await archiveRun({ runId, operator: "system" }, deps);

    expect(result.ok).toBe(true);
    expect(deps.state.getRun(runId)?.archivedAt).toBe(
      "2026-05-15T12:00:00.000Z",
    );
    expect(events.map((e) => e.type)).toEqual([
      "operator_action_requested",
      "operator_action_succeeded",
    ]);
  });

  it("accepts archive from blocked and completed states", async () => {
    const { deps } = createDeps();
    const r1 = seedRun(deps.state, { runId: "r-blocked", status: "blocked" });
    const r2 = seedRun(deps.state, {
      runId: "r-completed",
      status: "completed",
    });
    expect(
      (await archiveRun({ runId: r1, operator: "system" }, deps)).ok,
    ).toBe(true);
    expect(
      (await archiveRun({ runId: r2, operator: "system" }, deps)).ok,
    ).toBe(true);
  });

  it("rejects archive on an active run", async () => {
    const { deps, events } = createDeps();
    const runId = seedRun(deps.state, { status: "running" });

    const result = await archiveRun({ runId, operator: "system" }, deps);

    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("invalid_status");
    expect(deps.state.getRun(runId)?.archivedAt).toBeUndefined();
    expect(events.at(-1)?.type).toBe("operator_action_failed");
  });

  it("returns not_found when run does not exist", async () => {
    const { deps } = createDeps();
    const result = await archiveRun(
      { runId: "ghost", operator: "system" },
      deps,
    );
    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("not_found");
  });
});
