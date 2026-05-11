import { describe, it, expectTypeOf } from "vitest";

import { type IssueRef } from "./issue.js";

describe("@issuepilot/shared-contracts/issue", () => {
  it("IssueRef carries the seven fields shared between tracker + runner", () => {
    expectTypeOf<IssueRef>().toHaveProperty("id").toEqualTypeOf<string>();
    expectTypeOf<IssueRef>().toHaveProperty("iid").toEqualTypeOf<number>();
    expectTypeOf<IssueRef>().toHaveProperty("title").toEqualTypeOf<string>();
    expectTypeOf<IssueRef>().toHaveProperty("url").toEqualTypeOf<string>();
    expectTypeOf<IssueRef>()
      .toHaveProperty("projectId")
      .toEqualTypeOf<string>();
    expectTypeOf<IssueRef>()
      .toHaveProperty("labels")
      .toEqualTypeOf<readonly string[]>();
  });
});
