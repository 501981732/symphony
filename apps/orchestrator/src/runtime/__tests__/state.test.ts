import { describe, it, expect } from "vitest";
import { createRuntimeState } from "../state.js";

describe("RuntimeState", () => {
  it("stores and retrieves run records", () => {
    const state = createRuntimeState();
    state.setRun("r1", {
      runId: "r1",
      status: "claimed",
      attempt: 1,
      branch: "ai/1-fix",
    });
    expect(state.getRun("r1")).toMatchObject({
      runId: "r1",
      status: "claimed",
    });
  });

  it("lists runs by status", () => {
    const state = createRuntimeState();
    state.setRun("r1", { runId: "r1", status: "running", attempt: 1 });
    state.setRun("r2", { runId: "r2", status: "completed", attempt: 1 });
    state.setRun("r3", { runId: "r3", status: "running", attempt: 2 });

    const running = state.listRuns("running");
    expect(running).toHaveLength(2);
  });

  it("computes summary counts", () => {
    const state = createRuntimeState();
    state.setRun("r1", { runId: "r1", status: "running", attempt: 1 });
    state.setRun("r2", { runId: "r2", status: "failed", attempt: 1 });

    const summary = state.summary();
    expect(summary.running).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.completed).toBe(0);
  });

  it("updates lastPollAt and lastConfigReloadAt", () => {
    const state = createRuntimeState();
    expect(state.lastPollAt).toBeNull();
    state.lastPollAt = "2026-05-11T00:00:00Z";
    expect(state.lastPollAt).toBe("2026-05-11T00:00:00Z");
  });

  it("removes a run", () => {
    const state = createRuntimeState();
    state.setRun("r1", { runId: "r1", status: "running", attempt: 1 });
    state.removeRun("r1");
    expect(state.getRun("r1")).toBeUndefined();
  });
});
