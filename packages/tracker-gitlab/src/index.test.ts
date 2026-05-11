import { describe, expect, it } from "vitest";

import * as mod from "./index.js";

describe("@issuepilot/tracker-gitlab", () => {
  it("exports VERSION and PACKAGE_NAME", () => {
    expect(typeof mod.VERSION).toBe("string");
    expect(mod.PACKAGE_NAME).toBe("@issuepilot/tracker-gitlab");
  });
});
