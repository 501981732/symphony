import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RetentionConfig } from "@issuepilot/shared-contracts";

import { createRuntimeState } from "../../runtime/state.js";
import {
  runWorkspaceCleanupOnce,
  type RunWorkspaceCleanupInput,
} from "../workspace-cleanup.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const BASE_TIME = new Date("2026-05-16T12:00:00.000Z");
const NOW = () => BASE_TIME;

const retention: RetentionConfig = {
  successfulRunDays: 7,
  failedRunDays: 30,
  maxWorkspaceGb: 50,
  cleanupIntervalMs: 3_600_000,
};

interface CapturedEvent {
  type: string;
  runId: string;
  message: string;
  data?: unknown;
}

function makeEventBus(): {
  bus: RunWorkspaceCleanupInput["eventBus"];
  events: CapturedEvent[];
} {
  const events: CapturedEvent[] = [];
  return {
    events,
    bus: {
      publish(event) {
        events.push({
          type: event.type,
          runId: event.runId,
          message: event.message,
          data: event.data,
        });
      },
    } as RunWorkspaceCleanupInput["eventBus"],
  };
}

function seedWorkspace(root: string, project: string, run: string): string {
  const wsPath = path.join(root, project, run);
  fs.mkdirSync(wsPath, { recursive: true });
  fs.writeFileSync(path.join(wsPath, "trash.txt"), "expired");
  return wsPath;
}

describe("runWorkspaceCleanupOnce", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-cleanup-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("deletes expired successful workspaces and emits planned + completed events", async () => {
    const wsPath = seedWorkspace(tmpRoot, "platform-web", "run-old");
    const state = createRuntimeState();
    state.setRun("run-old", {
      runId: "run-old",
      status: "completed",
      attempt: 1,
      workspacePath: wsPath,
      projectId: "platform-web",
      endedAt: new Date(BASE_TIME.getTime() - 10 * ONE_DAY_MS).toISOString(),
      issue: {
        id: "12345",
        iid: 7,
        title: "old",
        url: "https://gitlab.example/projects/platform-web/issues/7",
        projectId: "platform-web",
        labels: [],
      },
    });

    const { bus, events } = makeEventBus();

    const plan = await runWorkspaceCleanupOnce({
      workspaceRoot: tmpRoot,
      state,
      retention,
      eventBus: bus,
      now: NOW,
    });

    expect(plan.delete).toHaveLength(1);
    expect(plan.delete[0]?.workspacePath).toBe(wsPath);
    expect(fs.existsSync(wsPath)).toBe(false);

    const types = events.map((e) => e.type);
    expect(types).toContain("workspace_cleanup_planned");
    expect(types).toContain("workspace_cleanup_completed");
    expect(types).not.toContain("workspace_cleanup_failed");

    const completed = events.find(
      (e) => e.type === "workspace_cleanup_completed",
    );
    expect((completed?.data as { workspacePath?: string })?.workspacePath).toBe(
      wsPath,
    );
  });

  it("never deletes workspaces tied to active runs", async () => {
    const wsPath = seedWorkspace(tmpRoot, "platform-web", "run-active");
    const state = createRuntimeState();
    state.setRun("run-active", {
      runId: "run-active",
      status: "running",
      attempt: 1,
      workspacePath: wsPath,
      projectId: "platform-web",
      issue: {
        id: "1",
        iid: 1,
        title: "active",
        url: "",
        projectId: "platform-web",
        labels: [],
      },
    });

    const { bus, events } = makeEventBus();
    const plan = await runWorkspaceCleanupOnce({
      workspaceRoot: tmpRoot,
      state,
      retention,
      eventBus: bus,
      now: NOW,
    });

    expect(plan.delete).toHaveLength(0);
    expect(fs.existsSync(wsPath)).toBe(true);
    const completed = events.filter(
      (e) => e.type === "workspace_cleanup_completed",
    );
    expect(completed).toHaveLength(0);
  });

  it("continues on per-entry rm failure and emits workspace_cleanup_failed", async () => {
    const wsA = seedWorkspace(tmpRoot, "platform-web", "run-a");
    const wsB = seedWorkspace(tmpRoot, "platform-web", "run-b");
    const state = createRuntimeState();
    const endedAt = new Date(
      BASE_TIME.getTime() - 14 * ONE_DAY_MS,
    ).toISOString();
    for (const [id, ws] of [
      ["run-a", wsA],
      ["run-b", wsB],
    ] as const) {
      state.setRun(id, {
        runId: id,
        status: "completed",
        attempt: 1,
        workspacePath: ws,
        projectId: "platform-web",
        endedAt,
        issue: {
          id,
          iid: 1,
          title: id,
          url: "",
          projectId: "platform-web",
          labels: [],
        },
      });
    }

    const failingRm = async (
      target: fsPromises.FileHandle | string,
      opts?: { recursive?: boolean; force?: boolean } | undefined,
    ): Promise<void> => {
      if (typeof target === "string" && target === wsA) {
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
      }
      return fsPromises.rm(target as string, opts);
    };

    const { bus, events } = makeEventBus();
    const plan = await runWorkspaceCleanupOnce({
      workspaceRoot: tmpRoot,
      state,
      retention,
      eventBus: bus,
      now: NOW,
      fs: { rm: failingRm as typeof fsPromises.rm },
    });

    expect(plan.delete).toHaveLength(2);
    // Both deletes were attempted; B succeeded, A failed but is still in plan.
    expect(fs.existsSync(wsA)).toBe(true);
    expect(fs.existsSync(wsB)).toBe(false);

    const failed = events.find((e) => e.type === "workspace_cleanup_failed");
    expect(failed).toBeDefined();
    expect((failed?.data as { workspacePath?: string })?.workspacePath).toBe(
      wsA,
    );

    const completed = events.filter(
      (e) => e.type === "workspace_cleanup_completed",
    );
    expect(completed).toHaveLength(1);
    expect(
      (completed[0]?.data as { workspacePath?: string })?.workspacePath,
    ).toBe(wsB);
  });

  it("emits workspace_cleanup_planned with totalBytes + delete count", async () => {
    const wsPath = seedWorkspace(tmpRoot, "platform-web", "run-old");
    const state = createRuntimeState();
    state.setRun("run-old", {
      runId: "run-old",
      status: "completed",
      attempt: 1,
      workspacePath: wsPath,
      projectId: "platform-web",
      endedAt: new Date(BASE_TIME.getTime() - 10 * ONE_DAY_MS).toISOString(),
      issue: {
        id: "1",
        iid: 1,
        title: "x",
        url: "",
        projectId: "platform-web",
        labels: [],
      },
    });

    const { bus, events } = makeEventBus();
    await runWorkspaceCleanupOnce({
      workspaceRoot: tmpRoot,
      state,
      retention,
      eventBus: bus,
      now: NOW,
    });

    const planned = events.find((e) => e.type === "workspace_cleanup_planned");
    expect(planned).toBeDefined();
    const data = planned?.data as {
      deleteCount?: number;
      totalBytes?: number;
      retainBytes?: number;
    };
    expect(data?.deleteCount).toBe(1);
    expect(data?.totalBytes).toBeGreaterThanOrEqual(7);
    expect(data?.retainBytes).toBe(retention.maxWorkspaceGb * 1024 ** 3);
  });
});
