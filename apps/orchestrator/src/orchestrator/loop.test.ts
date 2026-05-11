import { describe, it, expect, vi, afterEach } from "vitest";
import { startLoop } from "./loop.js";
import { createRuntimeState } from "../runtime/state.js";
import { createConcurrencySlots } from "../runtime/slots.js";

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
        return [{ runId: "r1" }, { runId: "r2" }];
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

  it("dispatches due retrying runs before claiming new candidates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T03:00:00.000Z"));
    const deps = createFakeLoopDeps();
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
