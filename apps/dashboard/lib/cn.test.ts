import { describe, expect, it } from "vitest";

import { cn } from "./cn";

describe("cn", () => {
  it("joins truthy class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("drops falsy values", () => {
    expect(cn("a", false, undefined, null, "", "b")).toBe("a b");
  });

  it("dedups conflicting tailwind utilities, keeping the last", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-sm font-bold", "text-base")).toBe("font-bold text-base");
  });

  it("supports conditional object syntax via clsx", () => {
    expect(cn("base", { active: true, hidden: false })).toBe("base active");
  });
});
