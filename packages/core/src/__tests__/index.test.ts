import { describe, it, expect } from "vitest";
import * as mod from "../index.js";

describe("@issuepilot/core", () => {
  it("exports a semver-shaped VERSION string", () => {
    expect(typeof mod.VERSION).toBe("string");
    expect(mod.VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("exports PACKAGE_NAME equal to @issuepilot/core", () => {
    expect(mod.PACKAGE_NAME).toBe("@issuepilot/core");
  });
});
