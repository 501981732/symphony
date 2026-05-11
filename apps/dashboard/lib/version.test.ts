import { describe, it, expect } from "vitest";
import { VERSION, PACKAGE_NAME } from "./version.js";

describe("@issuepilot/dashboard", () => {
  it("exports VERSION and PACKAGE_NAME", () => {
    expect(typeof VERSION).toBe("string");
    expect(PACKAGE_NAME).toBe("@issuepilot/dashboard");
  });
});
