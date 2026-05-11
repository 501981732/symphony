import { describe, it, expect, expectTypeOf } from "vitest";

import {
  RUN_STATUS_VALUES,
  isRunStatus,
  type RunRecord,
  type RunStatus,
} from "./run.js";

describe("@issuepilot/shared-contracts/run", () => {
  it("RUN_STATUS_VALUES enumerates exactly the six P0 statuses", () => {
    expect(new Set(RUN_STATUS_VALUES)).toEqual(
      new Set([
        "claimed",
        "running",
        "retrying",
        "completed",
        "failed",
        "blocked",
      ]),
    );
  });

  it("isRunStatus narrows known strings and rejects unknown ones", () => {
    expect(isRunStatus("running")).toBe(true);
    expect(isRunStatus("nope")).toBe(false);
    expect(isRunStatus(42)).toBe(false);
    expect(isRunStatus(undefined)).toBe(false);
  });

  it("RunStatus is exactly the union of RUN_STATUS_VALUES", () => {
    expectTypeOf<RunStatus>().toEqualTypeOf<
      (typeof RUN_STATUS_VALUES)[number]
    >();
  });

  it("RunRecord requires runId / issue / status / attempt / branch / workspacePath / startedAt / updatedAt", () => {
    expectTypeOf<RunRecord>().toHaveProperty("runId").toEqualTypeOf<string>();
    expectTypeOf<RunRecord>()
      .toHaveProperty("status")
      .toEqualTypeOf<RunStatus>();
    expectTypeOf<RunRecord>().toHaveProperty("attempt").toEqualTypeOf<number>();
    expectTypeOf<RunRecord>().toHaveProperty("branch").toEqualTypeOf<string>();
    expectTypeOf<RunRecord>()
      .toHaveProperty("workspacePath")
      .toEqualTypeOf<string>();
    expectTypeOf<RunRecord>()
      .toHaveProperty("startedAt")
      .toEqualTypeOf<string>();
    expectTypeOf<RunRecord>()
      .toHaveProperty("updatedAt")
      .toEqualTypeOf<string>();
  });

  it("RunRecord.mergeRequestUrl / endedAt / lastError are optional", () => {
    expectTypeOf<RunRecord>()
      .toHaveProperty("mergeRequestUrl")
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<RunRecord>()
      .toHaveProperty("endedAt")
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<RunRecord>().toHaveProperty("lastError").toEqualTypeOf<
      | { code: string; message: string }
      | undefined
    >();
  });
});
