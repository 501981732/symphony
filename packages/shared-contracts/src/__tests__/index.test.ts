import { describe, it, expect } from "vitest";

import * as mod from "../index.js";

describe("@issuepilot/shared-contracts", () => {
  it("exports VERSION and PACKAGE_NAME", () => {
    expect(typeof mod.VERSION).toBe("string");
    expect(mod.PACKAGE_NAME).toBe("@issuepilot/shared-contracts");
  });

  it("re-exports the value-level helpers from every submodule", () => {
    expect(Array.isArray(mod.RUN_STATUS_VALUES)).toBe(true);
    expect(Array.isArray(mod.EVENT_TYPE_VALUES)).toBe(true);
    expect(Array.isArray(mod.SERVICE_STATUS_VALUES)).toBe(true);
    expect(typeof mod.isRunStatus).toBe("function");
    expect(typeof mod.isEventType).toBe("function");
    expect(typeof mod.isServiceStatus).toBe("function");
  });
});
