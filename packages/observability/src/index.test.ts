import { describe, it, expect } from "vitest";
import * as mod from "./index.js";

describe("@issuepilot/observability", () => {
  it("exports VERSION and PACKAGE_NAME", () => {
    expect(typeof mod.VERSION).toBe("string");
    expect(mod.PACKAGE_NAME).toBe("@issuepilot/observability");
  });

  it("exports all observability functions", () => {
    expect(typeof mod.redact).toBe("function");
    expect(typeof mod.createEventBus).toBe("function");
    expect(typeof mod.createEventStore).toBe("function");
    expect(typeof mod.createRunStore).toBe("function");
    expect(typeof mod.createLogger).toBe("function");
  });
});
