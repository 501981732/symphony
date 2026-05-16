/**
 * V2 Phase 5 — Workspace Retention end-to-end coverage.
 *
 * These tests intentionally bypass the daemon HTTP layer and exercise the
 * full retention slice end-to-end:
 *
 *   real fs → enumerateWorkspaceEntries → planWorkspaceCleanup →
 *   runWorkspaceCleanupOnce → real EventBus subscribers
 *
 * The unit tests in `apps/orchestrator/src/maintenance/__tests__/workspace-cleanup.test.ts`
 * already cover individual edges (rm failure, planned payload, active runs).
 * What we want here is plan-spec §11 contract coverage in one place so a
 * regression in any of the three integration seams (workspace package ↔
 * runtime state ↔ event bus) is caught by a single focused test.
 *
 * Scenarios mirror the plan’s Task 6 list:
 *   A — successful run mtime > successfulRunDays → directory deleted +
 *       workspace_cleanup_completed event surfaces with reason.
 *   B — active run regardless of mtime → directory kept + no completed event.
 *   C — five failed runs all within failedRunDays but total > maxWorkspaceGb
 *       → plan.delete is empty and workspace_cleanup_planned reports
 *       overCapacity = true (spec §11: never strip unexpired failure
 *       forensics).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEventBus } from "@issuepilot/observability";
import type {
  IssuePilotInternalEvent,
  RetentionConfig,
} from "@issuepilot/shared-contracts";

import {
  createRuntimeState,
  runWorkspaceCleanupOnce,
} from "@issuepilot/orchestrator";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const BASE_TIME = new Date("2026-06-01T00:00:00.000Z");
const NOW = () => BASE_TIME;

const RETENTION: RetentionConfig = {
  successfulRunDays: 7,
  failedRunDays: 30,
  maxWorkspaceGb: 50,
  cleanupIntervalMs: 3_600_000,
};

function seedWorkspace(args: {
  root: string;
  projectId: string;
  runId: string;
  bytes: number;
  mtimeAgoMs: number;
}): string {
  const wsPath = path.join(args.root, args.projectId, args.runId);
  fs.mkdirSync(wsPath, { recursive: true });
  const filePath = path.join(wsPath, "payload.bin");
  fs.writeFileSync(filePath, Buffer.alloc(args.bytes, 0xab));
  const targetMs = BASE_TIME.getTime() - args.mtimeAgoMs;
  const targetSec = targetMs / 1000;
  // Push both file and directory mtime back so enumerateWorkspaceEntries
  // sees the "older" timestamps. Use utimesSync (not utimes) so the test
  // stays synchronous on platforms where ext4 / APFS lazily flushes.
  fs.utimesSync(filePath, targetSec, targetSec);
  fs.utimesSync(wsPath, targetSec, targetSec);
  return wsPath;
}

interface CollectedEvents {
  all: IssuePilotInternalEvent[];
  ofType: (type: string) => IssuePilotInternalEvent[];
}

function collectEvents(bus: ReturnType<typeof createEventBus<IssuePilotInternalEvent>>): CollectedEvents {
  const all: IssuePilotInternalEvent[] = [];
  bus.subscribe((evt) => {
    all.push(evt);
  });
  return {
    all,
    ofType: (type) => all.filter((e) => e.type === type),
  };
}

describe("workspace retention E2E", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-cleanup-e2e-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("A: deletes expired successful workspace and emits a completed event", async () => {
    const wsPath = seedWorkspace({
      root: tmpRoot,
      projectId: "platform-web",
      runId: "run-old-success",
      bytes: 2048,
      mtimeAgoMs: 8 * ONE_DAY_MS,
    });

    const state = createRuntimeState();
    state.setRun("run-old-success", {
      runId: "run-old-success",
      status: "completed",
      attempt: 1,
      workspacePath: wsPath,
      projectId: "platform-web",
      endedAt: new Date(BASE_TIME.getTime() - 8 * ONE_DAY_MS).toISOString(),
      issue: {
        id: "12345",
        iid: 7,
        title: "expired-success",
        url: "https://gitlab.example/projects/platform-web/issues/7",
        projectId: "platform-web",
        labels: [],
      },
    });

    const bus = createEventBus<IssuePilotInternalEvent>();
    const events = collectEvents(bus);

    const plan = await runWorkspaceCleanupOnce({
      workspaceRoot: tmpRoot,
      state,
      retention: RETENTION,
      eventBus: bus,
      now: NOW,
    });

    expect(plan.delete.map((d) => d.workspacePath)).toEqual([wsPath]);
    expect(fs.existsSync(wsPath)).toBe(false);

    const completed = events.ofType("workspace_cleanup_completed");
    expect(completed).toHaveLength(1);
    expect(
      (completed[0]?.data as { workspacePath?: string; reason?: string })
        .workspacePath,
    ).toBe(wsPath);
    expect(
      (completed[0]?.data as { reason?: string }).reason,
    ).toBe("successful-expired");

    // Spec §12: planned + completed are mandatory; failed must not be
    // emitted on a clean sweep.
    expect(events.ofType("workspace_cleanup_planned")).toHaveLength(1);
    expect(events.ofType("workspace_cleanup_failed")).toHaveLength(0);
  });

  it("B: never deletes the workspace of an active run, no matter how old", async () => {
    const wsPath = seedWorkspace({
      root: tmpRoot,
      projectId: "platform-web",
      runId: "run-active-old",
      bytes: 1024,
      mtimeAgoMs: 60 * ONE_DAY_MS,
    });

    const state = createRuntimeState();
    state.setRun("run-active-old", {
      runId: "run-active-old",
      status: "running",
      attempt: 1,
      workspacePath: wsPath,
      projectId: "platform-web",
      issue: {
        id: "1",
        iid: 1,
        title: "active-but-old",
        url: "",
        projectId: "platform-web",
        labels: [],
      },
    });

    const bus = createEventBus<IssuePilotInternalEvent>();
    const events = collectEvents(bus);

    const plan = await runWorkspaceCleanupOnce({
      workspaceRoot: tmpRoot,
      state,
      retention: RETENTION,
      eventBus: bus,
      now: NOW,
    });

    expect(plan.delete).toHaveLength(0);
    expect(fs.existsSync(wsPath)).toBe(true);
    expect(events.ofType("workspace_cleanup_completed")).toHaveLength(0);
    expect(events.ofType("workspace_cleanup_failed")).toHaveLength(0);

    const planned = events.ofType("workspace_cleanup_planned");
    expect(planned).toHaveLength(1);
    expect(
      (planned[0]?.data as { deleteCount?: number }).deleteCount,
    ).toBe(0);
  });

  it("C: over-capacity sweep keeps unexpired failure forensics intact", async () => {
    // 5 failed runs, each 5 days old (within failedRunDays=30). We tighten
    // maxWorkspaceGb down to a sub-byte threshold so the planner will see
    // the entire root as "over budget" — yet spec §11 forbids deleting
    // failure forensics that are still inside the retention window.
    const failedRuns: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const wsPath = seedWorkspace({
        root: tmpRoot,
        projectId: "platform-web",
        runId: `run-failed-${i}`,
        bytes: 4096,
        mtimeAgoMs: 5 * ONE_DAY_MS,
      });
      failedRuns.push(wsPath);
    }

    const state = createRuntimeState();
    for (const wsPath of failedRuns) {
      const runId = path.basename(wsPath);
      state.setRun(runId, {
        runId,
        status: "failed",
        attempt: 1,
        workspacePath: wsPath,
        projectId: "platform-web",
        endedAt: new Date(BASE_TIME.getTime() - 5 * ONE_DAY_MS).toISOString(),
        issue: {
          id: runId,
          iid: 1,
          title: runId,
          url: "",
          projectId: "platform-web",
          labels: [],
        },
      });
    }

    // Anything ≥ 1 byte in maxWorkspaceGb is enough room here; we want a
    // value that *forces* overCapacity yet leaves the within-retention
    // guard in charge. 1e-9 GB ≈ 1 byte.
    const tight: RetentionConfig = {
      ...RETENTION,
      maxWorkspaceGb: 1e-9,
    };

    const bus = createEventBus<IssuePilotInternalEvent>();
    const events = collectEvents(bus);

    const plan = await runWorkspaceCleanupOnce({
      workspaceRoot: tmpRoot,
      state,
      retention: tight,
      eventBus: bus,
      now: NOW,
    });

    expect(plan.delete).toHaveLength(0);
    for (const wsPath of failedRuns) {
      expect(fs.existsSync(wsPath)).toBe(true);
    }

    const planned = events.ofType("workspace_cleanup_planned");
    expect(planned).toHaveLength(1);
    const data = planned[0]?.data as {
      overCapacity?: boolean;
      deleteCount?: number;
      totalBytes?: number;
      retainBytes?: number;
    };
    expect(data.overCapacity).toBe(true);
    expect(data.deleteCount).toBe(0);
    expect(data.totalBytes).toBeGreaterThan(data.retainBytes ?? 0);
    expect(events.ofType("workspace_cleanup_completed")).toHaveLength(0);
    expect(events.ofType("workspace_cleanup_failed")).toHaveLength(0);
  });
});
