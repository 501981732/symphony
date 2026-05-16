import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { RetentionConfig } from "@issuepilot/shared-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  enumerateWorkspaceEntries,
  planWorkspaceCleanup,
  type WorkspaceEntry,
} from "../retention.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const BASE_TIME = new Date("2026-05-16T12:00:00.000Z");
const ONE_GB = 1024 ** 3;

const baseRetention: RetentionConfig = {
  successfulRunDays: 7,
  failedRunDays: 30,
  maxWorkspaceGb: 50,
  cleanupIntervalMs: 3_600_000,
};

const entry = (over: Partial<WorkspaceEntry>): WorkspaceEntry => ({
  workspacePath: "/tmp/ws",
  runId: "run",
  projectId: "platform-web",
  status: "successful",
  bytes: 100,
  ...over,
});

const daysAgo = (n: number): string =>
  new Date(BASE_TIME.getTime() - n * ONE_DAY_MS).toISOString();

describe("planWorkspaceCleanup", () => {
  it("never deletes active runs even when their workspace is years old", () => {
    const plan = planWorkspaceCleanup({
      entries: [
        entry({
          workspacePath: "/tmp/ws/active",
          runId: "r1",
          status: "active",
          endedAt: undefined,
          bytes: ONE_GB,
        }),
      ],
      retention: baseRetention,
      now: BASE_TIME,
    });

    expect(plan.delete).toEqual([]);
    expect(plan.totalBytes).toBe(ONE_GB);
  });

  it("keeps successful runs inside the retention window", () => {
    const plan = planWorkspaceCleanup({
      entries: [
        entry({
          workspacePath: "/tmp/ws/fresh",
          runId: "r2",
          status: "successful",
          endedAt: daysAgo(6),
        }),
      ],
      retention: baseRetention,
      now: BASE_TIME,
    });

    expect(plan.delete).toEqual([]);
  });

  it("deletes successful runs past the retention window", () => {
    const plan = planWorkspaceCleanup({
      entries: [
        entry({
          workspacePath: "/tmp/ws/expired",
          runId: "r3",
          status: "successful",
          endedAt: daysAgo(8),
        }),
      ],
      retention: baseRetention,
      now: BASE_TIME,
    });

    expect(plan.delete).toEqual([
      { workspacePath: "/tmp/ws/expired", reason: "successful-expired" },
    ]);
  });

  it("keeps failed runs inside the failure retention window", () => {
    const plan = planWorkspaceCleanup({
      entries: [
        entry({
          workspacePath: "/tmp/ws/failed-fresh",
          runId: "r4",
          status: "failed",
          endedAt: daysAgo(25),
        }),
      ],
      retention: baseRetention,
      now: BASE_TIME,
    });

    expect(plan.delete).toEqual([]);
    expect(plan.keepFailureMarkers).toEqual(["/tmp/ws/failed-fresh"]);
  });

  it("deletes failed runs past the failure retention window", () => {
    const plan = planWorkspaceCleanup({
      entries: [
        entry({
          workspacePath: "/tmp/ws/failed-old",
          runId: "r5",
          status: "failed",
          endedAt: daysAgo(32),
        }),
      ],
      retention: baseRetention,
      now: BASE_TIME,
    });

    expect(plan.delete).toEqual([
      { workspacePath: "/tmp/ws/failed-old", reason: "failed-expired" },
    ]);
  });

  it("trims oldest already-expired terminal entries when total bytes exceed maxWorkspaceGb", () => {
    const retention: RetentionConfig = {
      ...baseRetention,
      maxWorkspaceGb: 2,
    };
    const plan = planWorkspaceCleanup({
      entries: [
        entry({
          workspacePath: "/tmp/ws/expired-newest",
          runId: "r-a",
          status: "successful",
          endedAt: daysAgo(8),
          bytes: 1 * ONE_GB,
        }),
        entry({
          workspacePath: "/tmp/ws/expired-middle",
          runId: "r-b",
          status: "successful",
          endedAt: daysAgo(10),
          bytes: 1 * ONE_GB,
        }),
        entry({
          workspacePath: "/tmp/ws/expired-oldest",
          runId: "r-c",
          status: "successful",
          endedAt: daysAgo(20),
          bytes: 1 * ONE_GB,
        }),
        entry({
          workspacePath: "/tmp/ws/active-large",
          runId: "r-d",
          status: "active",
          bytes: 3 * ONE_GB,
        }),
      ],
      retention,
      now: BASE_TIME,
    });

    expect(plan.delete.map((d) => d.workspacePath)).toEqual([
      "/tmp/ws/expired-oldest",
      "/tmp/ws/expired-middle",
      "/tmp/ws/expired-newest",
    ]);
    expect(plan.delete.every((d) => d.reason !== "over-capacity")).toBe(false);
    expect(plan.delete[0]).toEqual({
      workspacePath: "/tmp/ws/expired-oldest",
      reason: "successful-expired",
    });
  });

  it("never deletes unexpired failure forensics even when over capacity", () => {
    const retention: RetentionConfig = {
      ...baseRetention,
      maxWorkspaceGb: 1,
    };
    const plan = planWorkspaceCleanup({
      entries: [
        entry({
          workspacePath: "/tmp/ws/fail-recent-a",
          runId: "r-a",
          status: "failed",
          endedAt: daysAgo(1),
          bytes: 2 * ONE_GB,
        }),
        entry({
          workspacePath: "/tmp/ws/fail-recent-b",
          runId: "r-b",
          status: "blocked",
          endedAt: daysAgo(2),
          bytes: 2 * ONE_GB,
        }),
      ],
      retention,
      now: BASE_TIME,
    });

    expect(plan.delete).toEqual([]);
    expect(plan.totalBytes).toBe(4 * ONE_GB);
    expect(plan.keepFailureMarkers).toEqual([
      "/tmp/ws/fail-recent-a",
      "/tmp/ws/fail-recent-b",
    ]);
  });

  it("classifies blocked runs under the failure retention window", () => {
    const plan = planWorkspaceCleanup({
      entries: [
        entry({
          workspacePath: "/tmp/ws/blocked-old",
          runId: "r-b",
          status: "blocked",
          endedAt: daysAgo(40),
        }),
      ],
      retention: baseRetention,
      now: BASE_TIME,
    });

    expect(plan.delete).toEqual([
      { workspacePath: "/tmp/ws/blocked-old", reason: "failed-expired" },
    ]);
  });

  it("propagates entry-level errors without throwing", () => {
    const plan = planWorkspaceCleanup({
      entries: [
        entry({
          workspacePath: "/tmp/ws/broken",
          runId: "r-e",
          status: "unknown",
          bytes: 0,
        }),
      ],
      retention: baseRetention,
      now: BASE_TIME,
      errors: [{ workspacePath: "/tmp/ws/broken", reason: "EPERM" }],
    });

    expect(plan.errors).toEqual([
      { workspacePath: "/tmp/ws/broken", reason: "EPERM" },
    ]);
    expect(plan.delete).toEqual([]);
  });
});

describe("enumerateWorkspaceEntries", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "retention-enum-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits one entry per project/run with byte totals and the lookup-supplied status", async () => {
    const projectRoot = path.join(tmpDir, "platform-web");
    const wsA = path.join(projectRoot, "run-1");
    const wsB = path.join(projectRoot, "run-2");
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });
    fs.writeFileSync(path.join(wsA, "a.txt"), "x".repeat(2048));
    fs.writeFileSync(path.join(wsB, "b.txt"), "y".repeat(1024));

    const result = await enumerateWorkspaceEntries({
      workspaceRoot: tmpDir,
      lookupRun: (projectId, runId) => {
        if (projectId === "platform-web" && runId === "run-1") {
          return {
            status: "active",
          };
        }
        if (projectId === "platform-web" && runId === "run-2") {
          return {
            status: "successful",
            endedAt: "2026-05-01T00:00:00.000Z",
          };
        }
        return undefined;
      },
    });

    const sorted = result.entries
      .slice()
      .sort((a, b) => a.workspacePath.localeCompare(b.workspacePath));
    expect(sorted).toHaveLength(2);
    expect(sorted[0]?.runId).toBe("run-1");
    expect(sorted[0]?.status).toBe("active");
    expect(sorted[0]?.bytes).toBeGreaterThanOrEqual(2048);
    expect(sorted[1]?.runId).toBe("run-2");
    expect(sorted[1]?.status).toBe("successful");
    expect(sorted[1]?.endedAt).toBe("2026-05-01T00:00:00.000Z");
    expect(result.errors).toEqual([]);
  });

  it("returns 'unknown' status when the lookup has no record for a directory", async () => {
    const projectRoot = path.join(tmpDir, "infra-tools");
    const ws = path.join(projectRoot, "orphan");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "stale.txt"), "z");

    const result = await enumerateWorkspaceEntries({
      workspaceRoot: tmpDir,
      lookupRun: () => undefined,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.status).toBe("unknown");
    expect(result.entries[0]?.runId).toBe("orphan");
    expect(result.entries[0]?.projectId).toBe("infra-tools");
  });

  it("records readdir failures in errors[] instead of throwing", async () => {
    const result = await enumerateWorkspaceEntries({
      workspaceRoot: path.join(tmpDir, "does-not-exist"),
      lookupRun: () => undefined,
    });

    expect(result.entries).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.workspacePath).toBe(
      path.join(tmpDir, "does-not-exist"),
    );
  });
});
