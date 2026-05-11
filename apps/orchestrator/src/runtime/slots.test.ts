import { describe, it, expect } from "vitest";
import { createConcurrencySlots } from "./slots.js";

describe("ConcurrencySlots", () => {
  it("acquires and releases slots", () => {
    const slots = createConcurrencySlots(2);
    expect(slots.available()).toBe(2);
    expect(slots.tryAcquire("r1")).toBe(true);
    expect(slots.available()).toBe(1);
    slots.release("r1");
    expect(slots.available()).toBe(2);
  });

  it("rejects when all slots are taken", () => {
    const slots = createConcurrencySlots(1);
    slots.tryAcquire("r1");
    expect(slots.tryAcquire("r2")).toBe(false);
    expect(slots.available()).toBe(0);
  });

  it("tracks active run ids", () => {
    const slots = createConcurrencySlots(3);
    slots.tryAcquire("r1");
    slots.tryAcquire("r2");
    expect(slots.active()).toEqual(new Set(["r1", "r2"]));
  });

  it("release is idempotent for unknown ids", () => {
    const slots = createConcurrencySlots(1);
    slots.release("nonexistent");
    expect(slots.available()).toBe(1);
  });

  it("does not double-acquire same id", () => {
    const slots = createConcurrencySlots(2);
    slots.tryAcquire("r1");
    expect(slots.tryAcquire("r1")).toBe(true);
    expect(slots.available()).toBe(1);
  });
});
