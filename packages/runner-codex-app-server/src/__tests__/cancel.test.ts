import { describe, it, expect, vi } from "vitest";

import { driveLifecycle, type DriveInput } from "../lifecycle.js";
import type { RpcClient } from "../rpc.js";

interface FakeRpcOptions {
  responses?: Map<string, unknown>;
  beforeNotifications?: () => Promise<void> | void;
}

function createFakeRpc(opts: FakeRpcOptions = {}): RpcClient & {
  getNotificationHandler(): (m: string, p: unknown) => void;
  requestCalls: Array<{ method: string; params: unknown }>;
} {
  const responses =
    opts.responses ??
    new Map<string, unknown>([
      ["initialize", { serverInfo: { name: "codex", version: "1.0" } }],
      ["thread/start", { thread: { id: "thr_abc" } }],
      ["turn/start", { turn: { id: "turn_xyz" } }],
      ["turn/interrupt", {}],
    ]);
  const requestCalls: Array<{ method: string; params: unknown }> = [];
  let notifHandler: (m: string, p: unknown) => void = () => {};

  const client: RpcClient & {
    getNotificationHandler(): (m: string, p: unknown) => void;
    requestCalls: Array<{ method: string; params: unknown }>;
  } = {
    request: vi.fn(async (method: string, params: unknown) => {
      requestCalls.push({ method, params });
      if (!responses.has(method)) {
        throw new Error(`Unexpected method: ${method}`);
      }
      return responses.get(method);
    }),
    notify: vi.fn(),
    onNotification: vi.fn((handler) => {
      notifHandler = handler;
    }),
    onMalformed: vi.fn(),
    onRequest: vi.fn(),
    close: vi.fn(async () => {}),
    waitExit: vi.fn(async () => ({ code: 0, signal: null })),
    getNotificationHandler() {
      return notifHandler;
    },
    requestCalls,
  };

  return client;
}

function baseInput(rpc: RpcClient): DriveInput {
  return {
    rpc,
    maxTurns: 1,
    prompt: "do the thing",
    title: "issue#1",
    cwd: "/tmp/x",
    threadName: "test",
    sandboxType: "workspace-write",
    approvalPolicy: "never",
    turnSandboxPolicy: { type: "workspaceWrite" },
    turnTimeoutMs: 2000,
    tools: [],
    onEvent: () => {},
  };
}

describe("driveLifecycle cancel API", () => {
  it("invokes onTurnActive with a cancel closure after turn/start", async () => {
    const rpc = createFakeRpc();
    const cancels: Array<() => Promise<void>> = [];

    const drivePromise = driveLifecycle({
      ...baseInput(rpc),
      onTurnActive: (cancel) => cancels.push(cancel),
    });

    // Wait until turn/start was issued and onTurnActive should have fired.
    await vi.waitFor(() => {
      expect(cancels.length).toBeGreaterThan(0);
    });

    expect(typeof cancels[0]).toBe("function");

    // Let the turn settle so driveLifecycle resolves.
    rpc.getNotificationHandler()("turn/completed", {
      turnId: "turn_xyz",
      stop: true,
    });
    await drivePromise;
  });

  it("cancel closure sends turn/interrupt with current threadId and turnId", async () => {
    const rpc = createFakeRpc();
    let cancel!: () => Promise<void>;

    const drivePromise = driveLifecycle({
      ...baseInput(rpc),
      onTurnActive: (c) => {
        cancel = c;
      },
    });

    await vi.waitFor(() => {
      expect(cancel).toBeDefined();
    });

    await cancel();

    const interrupt = rpc.requestCalls.find(
      (r) => r.method === "turn/interrupt",
    );
    expect(interrupt).toBeDefined();
    expect(interrupt?.params).toEqual({
      threadId: "thr_abc",
      turnId: "turn_xyz",
    });

    // Drain the lifecycle so it doesn't hang.
    rpc.getNotificationHandler()("turn/completed", {
      turnId: "turn_xyz",
      turn: { id: "turn_xyz", status: "interrupted" },
    });
    const result = await drivePromise;
    expect(result.status).toBe("cancelled");
  });

  it("cancel closure becomes a noop after the turn settles", async () => {
    const rpc = createFakeRpc();
    let cancel!: () => Promise<void>;

    const drivePromise = driveLifecycle({
      ...baseInput(rpc),
      onTurnActive: (c) => {
        cancel = c;
      },
    });

    await vi.waitFor(() => {
      expect(cancel).toBeDefined();
    });

    rpc.getNotificationHandler()("turn/completed", {
      turnId: "turn_xyz",
      stop: true,
    });
    await drivePromise;

    const before = rpc.requestCalls.filter(
      (r) => r.method === "turn/interrupt",
    ).length;
    await cancel();
    const after = rpc.requestCalls.filter(
      (r) => r.method === "turn/interrupt",
    ).length;
    expect(after).toBe(before);
  });

  it("recognises turn/completed with turn.status='interrupted' as cancelled", async () => {
    const rpc = createFakeRpc();

    const drivePromise = driveLifecycle(baseInput(rpc));

    await vi.waitFor(() => {
      expect(
        rpc.requestCalls.some((r) => r.method === "turn/start"),
      ).toBe(true);
    });

    rpc.getNotificationHandler()("turn/completed", {
      turnId: "turn_xyz",
      turn: { id: "turn_xyz", status: "interrupted" },
    });

    const result = await drivePromise;
    expect(result.status).toBe("cancelled");
  });
});
