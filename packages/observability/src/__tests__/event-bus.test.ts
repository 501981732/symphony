import { describe, it, expect, vi } from "vitest";
import { createEventBus } from "../event-bus.js";

describe("EventBus", () => {
  it("delivers events to subscribers", () => {
    const bus = createEventBus<{ type: string; data: string }>();
    const handler = vi.fn();
    bus.subscribe(handler);
    bus.publish({ type: "test", data: "hello" });
    expect(handler).toHaveBeenCalledWith({ type: "test", data: "hello" });
  });

  it("supports multiple subscribers", () => {
    const bus = createEventBus<{ type: string }>();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.subscribe(h1);
    bus.subscribe(h2);
    bus.publish({ type: "event" });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops delivery", () => {
    const bus = createEventBus<{ type: string }>();
    const handler = vi.fn();
    const unsub = bus.subscribe(handler);
    bus.publish({ type: "a" });
    unsub();
    bus.publish({ type: "b" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("supports filter function", () => {
    const bus = createEventBus<{ type: string; runId: string }>();
    const handler = vi.fn();
    bus.subscribe(handler, (e) => e.runId === "r1");
    bus.publish({ type: "a", runId: "r1" });
    bus.publish({ type: "b", runId: "r2" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ type: "a", runId: "r1" });
  });

  it("subscriber errors do not affect other subscribers", () => {
    const bus = createEventBus<{ type: string }>();
    const bad = vi.fn(() => {
      throw new Error("oops");
    });
    const good = vi.fn();
    bus.subscribe(bad);
    bus.subscribe(good);
    bus.publish({ type: "event" });
    expect(good).toHaveBeenCalledTimes(1);
  });
});
