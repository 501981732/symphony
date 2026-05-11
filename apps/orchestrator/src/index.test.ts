import { describe, it, expect } from "vitest";
import * as mod from "./index.js";

describe("@issuepilot/orchestrator", () => {
  it("exports VERSION and PACKAGE_NAME", () => {
    expect(typeof mod.VERSION).toBe("string");
    expect(mod.PACKAGE_NAME).toBe("@issuepilot/orchestrator");
  });

  it("exports all orchestrator functions", () => {
    expect(typeof mod.createRuntimeState).toBe("function");
    expect(typeof mod.createConcurrencySlots).toBe("function");
    expect(typeof mod.claimCandidates).toBe("function");
    expect(typeof mod.classifyError).toBe("function");
    expect(typeof mod.shouldRetry).toBe("function");
    expect(typeof mod.reconcile).toBe("function");
    expect(typeof mod.dispatch).toBe("function");
    expect(typeof mod.startLoop).toBe("function");
    expect(typeof mod.createServer).toBe("function");
    expect(typeof mod.buildCli).toBe("function");
  });
});
