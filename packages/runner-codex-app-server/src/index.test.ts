import { describe, it, expect } from "vitest";
import * as mod from "./index.js";

describe("@issuepilot/runner-codex-app-server", () => {
  it("exports VERSION and PACKAGE_NAME", () => {
    expect(typeof mod.VERSION).toBe("string");
    expect(mod.PACKAGE_NAME).toBe("@issuepilot/runner-codex-app-server");
  });

  it("exports all runner functions", () => {
    expect(typeof mod.spawnRpc).toBe("function");
    expect(typeof mod.driveLifecycle).toBe("function");
    expect(typeof mod.normalizeNotification).toBe("function");
    expect(typeof mod.handleApprovalRequest).toBe("function");
    expect(typeof mod.handleInputRequired).toBe("function");
    expect(typeof mod.createGitLabTools).toBe("function");
  });
});
