import { describe, it, expect, vi, afterEach } from "vitest";
import { startLoop } from "../loop.js";
import { createRuntimeState } from "../../runtime/state.js";
import { createConcurrencySlots } from "../../runtime/slots.js";

function createFakeLoopDeps(overrides: Record<string, unknown> = {}) {
  const state = createRuntimeState();
  const slots = createConcurrencySlots(2);
  let claimCallCount = 0;

  return {
    state,
    slots,
    pollIntervalMs: 100_000,
    loadConfig: vi.fn(() => ({})),
    claim: vi.fn(async () => {
      claimCallCount++;
      if (claimCallCount === 1) {
        const claimed = [{ runId: "r1" }, { runId: "r2" }].filter((run) =>
          slots.tryAcquire(run.runId),
        );
        return claimed;
      }
      return [];
    }),
    dispatch: vi.fn(async () => {}),
    reconcileRunning: vi.fn(async () => {}),
    logError: vi.fn(),
    ...overrides,
  };
}

describe("startLoop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tick claims and dispatches candidates", async () => {
    const deps = createFakeLoopDeps();
    const loop = startLoop(deps);

    await loop.tick();

    expect(deps.loadConfig).toHaveBeenCalled();
    expect(deps.reconcileRunning).toHaveBeenCalled();
    expect(deps.claim).toHaveBeenCalled();
    expect(deps.dispatch).toHaveBeenCalledTimes(2);
    expect(deps.state.lastPollAt).toBeTruthy();
    expect(deps.state.lastConfigReloadAt).toBeTruthy();

    await loop.stop();
  });

  it("logs config reload errors and continues the tick", async () => {
    const deps = createFakeLoopDeps({
      loadConfig: vi.fn(() => {
        throw new Error("bad workflow");
      }),
    });
    const loop = startLoop(deps);

    await loop.tick();

    expect(deps.logError).toHaveBeenCalled();
    expect(deps.reconcileRunning).toHaveBeenCalled();
    expect(deps.claim).toHaveBeenCalled();
    expect(deps.dispatch).toHaveBeenCalledTimes(2);
    expect(deps.state.lastConfigReloadAt).toBeNull();

    await loop.stop();
  });

  it("reloads a positive finite poll interval and reschedules the timer", async () => {
    vi.useFakeTimers();
    const deps = createFakeLoopDeps({
      pollIntervalMs: 100_000,
      loadConfig: vi.fn(() => ({ pollIntervalMs: 250 })),
      claim: vi.fn(async () => []),
    });
    const loop = startLoop(deps);

    await loop.tick();

    expect(deps.loadConfig).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(deps.loadConfig).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(deps.loadConfig).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it("reconciles running runs before due retries and claiming new candidates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T03:00:00.000Z"));
    const sequence: string[] = [];
    const deps = createFakeLoopDeps({
      reconcileRunning: vi.fn(async () => {
        sequence.push("reconcileRunning");
      }),
      claim: vi.fn(async () => {
        sequence.push("claim");
        const claimed = [{ runId: "r1" }, { runId: "r2" }].filter((run) =>
          deps.slots.tryAcquire(run.runId),
        );
        return claimed;
      }),
      dispatch: vi.fn(async (runId: string) => {
        sequence.push(`dispatch:${runId}`);
      }),
    });
    deps.state.setRun("retry-1", {
      runId: "retry-1",
      status: "retrying",
      attempt: 2,
      nextRetryAt: "2026-05-11T03:00:00.000Z",
    });
    const loop = startLoop(deps);

    await loop.tick();

    expect(deps.dispatch).toHaveBeenCalledWith("retry-1");
    expect(deps.dispatch).toHaveBeenCalledWith("r1");
    expect(deps.dispatch).toHaveBeenCalledTimes(2);
    expect(deps.claim).toHaveBeenCalled();
    expect(sequence).toEqual([
      "reconcileRunning",
      "dispatch:retry-1",
      "claim",
      "dispatch:r1",
    ]);

    await loop.stop();
  });

  it("does not dispatch retrying runs before nextRetryAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T03:00:00.000Z"));
    const deps = createFakeLoopDeps();
    deps.state.setRun("retry-1", {
      runId: "retry-1",
      status: "retrying",
      attempt: 2,
      nextRetryAt: "2026-05-11T03:00:01.000Z",
    });
    const loop = startLoop(deps);

    await loop.tick();

    expect(deps.dispatch).not.toHaveBeenCalledWith("retry-1");
    expect(deps.dispatch).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it("does not dispatch retrying runs with missing nextRetryAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T03:00:00.000Z"));
    const deps = createFakeLoopDeps();
    deps.state.setRun("retry-1", {
      runId: "retry-1",
      status: "retrying",
      attempt: 2,
    });
    const loop = startLoop(deps);

    await loop.tick();

    expect(deps.dispatch).not.toHaveBeenCalledWith("retry-1");
    expect(deps.dispatch).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it("does not dispatch retrying runs with invalid nextRetryAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T03:00:00.000Z"));
    const deps = createFakeLoopDeps();
    deps.state.setRun("retry-1", {
      runId: "retry-1",
      status: "retrying",
      attempt: 2,
      nextRetryAt: "not-a-date",
    });
    const loop = startLoop(deps);

    await loop.tick();

    expect(deps.dispatch).not.toHaveBeenCalledWith("retry-1");
    expect(deps.dispatch).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it("does not dispatch due retrying runs when no slot is available", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T03:00:00.000Z"));
    const deps = createFakeLoopDeps();
    deps.slots.tryAcquire("x1");
    deps.slots.tryAcquire("x2");
    deps.state.setRun("retry-1", {
      runId: "retry-1",
      status: "retrying",
      attempt: 2,
      nextRetryAt: "2026-05-11T03:00:00.000Z",
    });
    const loop = startLoop(deps);

    await loop.tick();

    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.claim).not.toHaveBeenCalled();

    await loop.stop();
  });

  it("second tick finds no candidates", async () => {
    const deps = createFakeLoopDeps();
    const loop = startLoop(deps);

    await loop.tick();
    await loop.tick();

    expect(deps.dispatch).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it("skips dispatch when no slots", async () => {
    const deps = createFakeLoopDeps();
    deps.slots.tryAcquire("x1");
    deps.slots.tryAcquire("x2");

    const loop = startLoop(deps);
    await loop.tick();

    expect(deps.claim).not.toHaveBeenCalled();

    await loop.stop();
  });

  it("logs claim errors without crashing", async () => {
    const deps = createFakeLoopDeps({
      claim: vi.fn(async () => {
        throw new Error("network");
      }),
    });
    const loop = startLoop(deps);
    await loop.tick();

    expect(deps.logError).toHaveBeenCalled();

    await loop.stop();
  });

  it("runs scanCiFeedback after reconcileRunning when injected", async () => {
    const sequence: string[] = [];
    const deps = createFakeLoopDeps({
      reconcileRunning: vi.fn(async () => {
        sequence.push("reconcileRunning");
      }),
      scanCiFeedback: vi.fn(async () => {
        sequence.push("scanCiFeedback");
      }),
      claim: vi.fn(async () => {
        sequence.push("claim");
        return [];
      }),
    });
    const loop = startLoop(deps);

    await loop.tick();

    expect(sequence).toEqual([
      "reconcileRunning",
      "scanCiFeedback",
      "claim",
    ]);

    await loop.stop();
  });

  it("does not invoke scanCiFeedback when omitted", async () => {
    const deps = createFakeLoopDeps();
    const loop = startLoop(deps);

    await loop.tick();

    expect(
      (deps as { scanCiFeedback?: unknown }).scanCiFeedback,
    ).toBeUndefined();
    await loop.stop();
  });

  it("logs scanCiFeedback errors and continues the tick", async () => {
    const deps = createFakeLoopDeps({
      scanCiFeedback: vi.fn(async () => {
        throw new Error("ci lookup down");
      }),
    });
    const loop = startLoop(deps);

    await loop.tick();

    expect(deps.logError).toHaveBeenCalled();
    expect(deps.claim).toHaveBeenCalled();
    expect(deps.dispatch).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it("runs sweepReviewFeedback after scanCiFeedback when both are injected (V2 Phase 4)", async () => {
    const sequence: string[] = [];
    const deps = createFakeLoopDeps({
      reconcileRunning: vi.fn(async () => {
        sequence.push("reconcileRunning");
      }),
      scanCiFeedback: vi.fn(async () => {
        sequence.push("scanCiFeedback");
      }),
      sweepReviewFeedback: vi.fn(async () => {
        sequence.push("sweepReviewFeedback");
      }),
      claim: vi.fn(async () => {
        sequence.push("claim");
        return [];
      }),
    });
    const loop = startLoop(deps);

    await loop.tick();

    expect(sequence).toEqual([
      "reconcileRunning",
      "scanCiFeedback",
      "sweepReviewFeedback",
      "claim",
    ]);

    await loop.stop();
  });

  it("does not invoke sweepReviewFeedback when omitted", async () => {
    const deps = createFakeLoopDeps();
    const loop = startLoop(deps);

    await loop.tick();

    expect(
      (deps as { sweepReviewFeedback?: unknown }).sweepReviewFeedback,
    ).toBeUndefined();
    await loop.stop();
  });

  it("logs sweepReviewFeedback errors and continues the tick", async () => {
    const deps = createFakeLoopDeps({
      sweepReviewFeedback: vi.fn(async () => {
        throw new Error("notes endpoint down");
      }),
    });
    const loop = startLoop(deps);

    await loop.tick();

    expect(deps.logError).toHaveBeenCalled();
    expect(deps.claim).toHaveBeenCalled();
    expect(deps.dispatch).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it("runs workspace cleanup after sweepReviewFeedback when the interval is due (V2 Phase 5)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T00:00:00.000Z"));
    const sequence: string[] = [];
    const runCleanup = vi.fn(async () => {
      sequence.push("cleanup");
    });
    const deps = createFakeLoopDeps({
      reconcileRunning: vi.fn(async () => {
        sequence.push("reconcileRunning");
      }),
      scanCiFeedback: vi.fn(async () => {
        sequence.push("scanCiFeedback");
      }),
      sweepReviewFeedback: vi.fn(async () => {
        sequence.push("sweepReviewFeedback");
      }),
      claim: vi.fn(async () => {
        sequence.push("claim");
        return [];
      }),
      cleanup: { runOnce: runCleanup, intervalMs: 60_000 },
    });
    const loop = startLoop(deps);

    await loop.tick();

    expect(runCleanup).toHaveBeenCalledTimes(1);
    expect(sequence).toEqual([
      "reconcileRunning",
      "scanCiFeedback",
      "sweepReviewFeedback",
      "cleanup",
      "claim",
    ]);

    // Second tick before the interval should not call cleanup again.
    await vi.advanceTimersByTimeAsync(30_000);
    await loop.tick();
    expect(runCleanup).toHaveBeenCalledTimes(1);

    // Once the interval has elapsed, cleanup runs again.
    await vi.advanceTimersByTimeAsync(31_000);
    await loop.tick();
    expect(runCleanup).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it("does not invoke cleanup when omitted (V2 Phase 5)", async () => {
    const deps = createFakeLoopDeps();
    const loop = startLoop(deps);

    await loop.tick();

    expect((deps as { cleanup?: unknown }).cleanup).toBeUndefined();
    await loop.stop();
  });

  it("logs cleanup errors and continues the tick (V2 Phase 5)", async () => {
    const runCleanup = vi.fn(async () => {
      throw new Error("rm: permission denied");
    });
    const deps = createFakeLoopDeps({
      cleanup: { runOnce: runCleanup, intervalMs: 1_000 },
    });
    const loop = startLoop(deps);
    await loop.tick();

    expect(deps.logError).toHaveBeenCalled();
    expect(deps.claim).toHaveBeenCalled();
    expect(deps.dispatch).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it("stop waits for inflight dispatches", async () => {
    let dispatchResolved = false;
    const deps = createFakeLoopDeps({
      dispatch: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 50));
        dispatchResolved = true;
      }),
    });

    const loop = startLoop(deps);
    await loop.tick();
    await loop.stop();

    expect(dispatchResolved).toBe(true);
  });
});
