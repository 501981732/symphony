import { describe, it, expect } from "vitest";
import * as mod from "./index.js";

describe("@issuepilot/runner-codex-app-server", () => {
  it("exports VERSION and PACKAGE_NAME", () => {
    expect(typeof mod.VERSION).toBe("string");
    expect(mod.PACKAGE_NAME).toBe("@issuepilot/runner-codex-app-server");
  });
});
