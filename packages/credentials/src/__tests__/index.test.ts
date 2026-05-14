import { describe, expect, it } from "vitest";

import * as credentials from "../index.js";

describe("@issuepilot/credentials", () => {
  it("exports a VERSION string", () => {
    expect(typeof credentials.VERSION).toBe("string");
  });

  it("identifies itself by package name", () => {
    expect(credentials.PACKAGE_NAME).toBe("@issuepilot/credentials");
  });
});
