import { describe, it, expect } from "vitest";
import * as mod from "../index.js";

describe("@issuepilot/workspace", () => {
  it("exports VERSION and PACKAGE_NAME", () => {
    expect(typeof mod.VERSION).toBe("string");
    expect(mod.PACKAGE_NAME).toBe("@issuepilot/workspace");
  });

  it("exports all workspace manager functions", () => {
    expect(typeof mod.slugify).toBe("function");
    expect(typeof mod.assertWithinRoot).toBe("function");
    expect(typeof mod.branchName).toBe("function");
    expect(typeof mod.ensureMirror).toBe("function");
    expect(typeof mod.ensureWorktree).toBe("function");
    expect(typeof mod.runHook).toBe("function");
    expect(typeof mod.cleanupOnFailure).toBe("function");
    expect(typeof mod.pruneWorktree).toBe("function");
  });

  it("exports error classes", () => {
    expect(mod.WorkspacePathError).toBeDefined();
    expect(mod.WorkspaceDirtyError).toBeDefined();
    expect(mod.HookFailedError).toBeDefined();
  });
});
