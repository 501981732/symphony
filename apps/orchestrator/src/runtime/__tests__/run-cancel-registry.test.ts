import { describe, expect, it, vi } from "vitest";

import { createRunCancelRegistry } from "../run-cancel-registry.js";

describe("createRunCancelRegistry", () => {
  it("returns not_registered for unknown runId", async () => {
    const registry = createRunCancelRegistry();
    const result = await registry.cancel("unknown");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_registered");
  });

  it("invokes the registered cancel and reports ok", async () => {
    const registry = createRunCancelRegistry();
    const cancel = vi.fn(async () => {});
    registry.register("run-1", cancel);
    const result = await registry.cancel("run-1");
    expect(result.ok).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("classifies a thrown cancel as cancel_threw and surfaces the message", async () => {
    const registry = createRunCancelRegistry();
    registry.register("run-2", async () => {
      throw new Error("rpc disconnected");
    });
    const result = await registry.cancel("run-2");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cancel_threw");
    expect(result.message).toContain("rpc disconnected");
  });

  it("classifies a long-running cancel as cancel_timeout", async () => {
    vi.useFakeTimers();
    const registry = createRunCancelRegistry();
    registry.register("run-3", () => new Promise<void>(() => {}));
    const promise = registry.cancel("run-3", { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cancel_timeout");
    vi.useRealTimers();
  });

  it("does not mix up cancels across runIds", async () => {
    const registry = createRunCancelRegistry();
    const cancel1 = vi.fn(async () => {});
    const cancel2 = vi.fn(async () => {});
    registry.register("run-a", cancel1);
    registry.register("run-b", cancel2);
    await registry.cancel("run-a");
    expect(cancel1).toHaveBeenCalled();
    expect(cancel2).not.toHaveBeenCalled();
  });

  it("unregister removes the cancel", async () => {
    const registry = createRunCancelRegistry();
    registry.register("run-1", async () => {});
    registry.unregister("run-1");
    const result = await registry.cancel("run-1");
    expect(result.reason).toBe("not_registered");
  });

  it("has() reflects registration state", () => {
    const registry = createRunCancelRegistry();
    expect(registry.has("run-1")).toBe(false);
    registry.register("run-1", async () => {});
    expect(registry.has("run-1")).toBe(true);
    registry.unregister("run-1");
    expect(registry.has("run-1")).toBe(false);
  });

  it("activeCount() reports the number of registered runs", () => {
    const registry = createRunCancelRegistry();
    expect(registry.activeCount()).toBe(0);
    registry.register("run-1", async () => {});
    registry.register("run-2", async () => {});
    expect(registry.activeCount()).toBe(2);
    registry.unregister("run-1");
    expect(registry.activeCount()).toBe(1);
  });
});
