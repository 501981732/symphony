import { describe, it, expect, expectTypeOf } from "vitest";

import {
  RUN_STATUS_VALUES,
  isRunStatus,
  type RunRecord,
  type RunStatus,
} from "../run.js";

describe("@issuepilot/shared-contracts/run", () => {
  it("RUN_STATUS_VALUES enumerates the seven dashboard-visible statuses", () => {
    expect(new Set(RUN_STATUS_VALUES)).toEqual(
      new Set([
        "claimed",
        "running",
        "retrying",
        "stopping",
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

  it("allows runs to carry team project metadata", () => {
    const run: RunRecord = {
      runId: "run-1",
      status: "running",
      attempt: 1,
      issue: {
        id: "1",
        iid: 1,
        title: "Fix checkout",
        url: "https://gitlab.example.com/group/platform-web/-/issues/1",
        projectId: "group/platform-web",
        labels: ["ai-running"],
      },
      branch: "ai/1-fix",
      workspacePath: "/tmp/issuepilot/platform-web/1",
      projectId: "platform-web",
      projectName: "Platform Web",
      startedAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:01.000Z",
    };

    expect(run.projectId).toBe("platform-web");
    expect(run.projectName).toBe("Platform Web");
  });

  it("accepts stopping run status", () => {
    expect(isRunStatus("stopping")).toBe(true);
  });

  it("allows RunRecord to carry archivedAt", () => {
    const run: RunRecord = {
      runId: "run-1",
      issue: {
        id: "1",
        iid: 1,
        title: "Fix checkout",
        url: "https://gitlab.example.com/group/web/-/issues/1",
        projectId: "group/web",
        labels: ["ai-failed"],
      },
      status: "failed",
      attempt: 1,
      branch: "ai/1-fix",
      workspacePath: "/tmp/run-1",
      startedAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:01.000Z",
      archivedAt: "2026-05-15T00:01:00.000Z",
    };

    expect(run.archivedAt).toBe("2026-05-15T00:01:00.000Z");
  });

  it("RunRecord.mergeRequestUrl / endedAt / lastError / dashboard metadata are optional", () => {
    expectTypeOf<RunRecord>()
      .toHaveProperty("mergeRequestUrl")
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<RunRecord>()
      .toHaveProperty("endedAt")
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<RunRecord>()
      .toHaveProperty("lastError")
      .toEqualTypeOf<{ code: string; message: string } | undefined>();
    expectTypeOf<RunRecord>()
      .toHaveProperty("turnCount")
      .toEqualTypeOf<number | undefined>();
    expectTypeOf<RunRecord>().toHaveProperty("lastEvent").toEqualTypeOf<
      | {
          type: string;
          message: string;
          createdAt?: string;
        }
      | undefined
    >();
  });
});
