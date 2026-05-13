import { describe, it, expect, vi } from "vitest";
import { driveLifecycle } from "../lifecycle.js";
import type { RpcClient } from "../rpc.js";

function createFakeRpc(
  responses: Map<string, unknown>,
  notifications: Array<{ method: string; params: unknown }> = [],
): RpcClient & {
  notifHandler: (m: string, p: unknown) => void;
  requestHandler: (m: string, p: unknown) => Promise<unknown> | unknown;
} {
  let notifHandler: (m: string, p: unknown) => void = () => {};
  let requestHandler: (m: string, p: unknown) => Promise<unknown> | unknown =
    () => {
      throw new Error("No request handler registered");
    };

  const client: RpcClient & {
    notifHandler: (m: string, p: unknown) => void;
    requestHandler: (m: string, p: unknown) => Promise<unknown> | unknown;
  } = {
      get notifHandler() {
        return notifHandler;
      },
      get requestHandler() {
        return requestHandler;
      },
      request: vi.fn(async (method: string) => {
        if (responses.has(method)) {
          return responses.get(method);
        }
        throw new Error(`Unexpected method: ${method}`);
      }),
      notify: vi.fn(),
      onNotification: vi.fn((handler) => {
        notifHandler = handler;
      }),
      onMalformed: vi.fn(),
      onRequest: vi.fn((handler) => {
        requestHandler = handler;
      }),
      close: vi.fn(async () => {}),
      waitExit: vi.fn(async () => ({ code: 0, signal: null })),
    };

  setTimeout(() => {
    for (const n of notifications) {
      notifHandler(n.method, n.params);
    }
  }, 10);

  return client;
}

describe("driveLifecycle", () => {
  it("completes a single-turn lifecycle", async () => {
    const rpc = createFakeRpc(
      new Map([
        [
          "initialize",
          { serverInfo: { name: "codex", version: "1.0" } },
        ],
        ["thread/start", { threadId: "t1" }],
        ["turn/start", { turnId: "u1" }],
      ]),
      [
        {
          method: "turn/completed",
          params: { turnId: "u1", stop: true },
        },
      ],
    );

    const events: string[] = [];
    const result = await driveLifecycle({
      rpc,
      maxTurns: 3,
      prompt: "Fix the bug",
      title: "Fix bug",
      cwd: "/tmp/ws",
      threadName: "test-thread",
      sandboxType: "workspace-write",
      approvalPolicy: "never",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 5000,
      tools: [],
      onEvent: (type) => {
        events.push(type);
      },
    });

    expect(result.status).toBe("completed");
    expect(result.turnsUsed).toBe(1);
    expect(result.threadId).toBe("t1");
    expect(events).toContain("session_started");
    expect(events).toContain("turn_started");
    expect(events).toContain("turn_completed");
  });

  it("reports failed status on turn/failed", async () => {
    const rpc = createFakeRpc(
      new Map([
        ["initialize", { serverInfo: { name: "codex", version: "1.0" } }],
        ["thread/start", { threadId: "t1" }],
        ["turn/start", { turnId: "u1" }],
      ]),
      [
        {
          method: "turn/failed",
          params: { turnId: "u1", error: "something went wrong" },
        },
      ],
    );

    const result = await driveLifecycle({
      rpc,
      maxTurns: 3,
      prompt: "Fix",
      title: "Fix",
      cwd: "/tmp/ws",
      threadName: "test",
      sandboxType: "workspace-write",
      approvalPolicy: "never",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 5000,
      tools: [],
      onEvent: () => {},
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("something went wrong");
  });

  it("stops after maxTurns if no stop signal", async () => {
    let turnCount = 0;
    const rpc = createFakeRpc(new Map([
      ["initialize", { serverInfo: { name: "codex", version: "1.0" } }],
      ["thread/start", { threadId: "t1" }],
    ]));

    (rpc.request as ReturnType<typeof vi.fn>).mockImplementation(
      async (method: string) => {
        if (method === "initialize")
          return { serverInfo: { name: "codex", version: "1.0" } };
        if (method === "thread/start") return { threadId: "t1" };
        if (method === "turn/start") {
          turnCount++;
          const turnId = `u${turnCount}`;
          setTimeout(() => {
            rpc.notifHandler("turn/completed", {
              turnId,
              stop: turnCount >= 2,
            });
          }, 5);
          return { turnId };
        }
        throw new Error(`Unexpected: ${method}`);
      },
    );

    const result = await driveLifecycle({
      rpc,
      maxTurns: 2,
      prompt: "Fix",
      title: "Fix",
      cwd: "/tmp/ws",
      threadName: "test",
      sandboxType: "workspace-write",
      approvalPolicy: "never",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 5000,
      tools: [],
      onEvent: () => {},
    });

    expect(result.turnsUsed).toBe(2);
    expect(result.status).toBe("completed");
  });

  it("handles app-server dynamic tool call requests", async () => {
    const rpc = createFakeRpc(
      new Map([
        ["initialize", { serverInfo: { name: "codex", version: "1.0" } }],
        ["thread/start", { threadId: "t1" }],
        ["turn/start", { turnId: "u1" }],
      ]),
      [
        {
          method: "turn/completed",
          params: { turnId: "u1", stop: true },
        },
      ],
    );

    const events: string[] = [];
    const resultPromise = driveLifecycle({
      rpc,
      maxTurns: 1,
      prompt: "Fix",
      title: "Fix",
      cwd: "/tmp/ws",
      threadName: "test",
      sandboxType: "workspace-write",
      approvalPolicy: "never",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 5000,
      tools: [
        {
          name: "gitlab_get_issue",
          description: "Get issue",
          inputSchema: { type: "object" },
          handler: vi.fn(async () => ({ ok: true })),
        },
      ],
      onEvent: (type) => events.push(type),
    });

    await Promise.resolve();
    const response = await rpc.requestHandler("item/tool/call", {
      tool: "gitlab_get_issue",
      arguments: {},
      callId: "call-1",
      threadId: "t1",
      turnId: "u1",
    });
    const result = await resultPromise;

    expect(response).toMatchObject({
      success: true,
      contentItems: [
        { type: "inputText", text: JSON.stringify({ ok: true }) },
      ],
    });
    expect(events).toContain("tool_call_started");
    expect(events).toContain("tool_call_completed");
    expect(result.status).toBe("completed");
  });

  it("auto-approves command and file approval requests when approvalPolicy is never", async () => {
    const rpc = createFakeRpc(
      new Map([
        ["initialize", { serverInfo: { name: "codex", version: "1.0" } }],
        ["thread/start", { threadId: "t1" }],
        ["turn/start", { turnId: "u1" }],
      ]),
      [
        {
          method: "turn/completed",
          params: { turnId: "u1", stop: true },
        },
      ],
    );
    const events: string[] = [];

    const resultPromise = driveLifecycle({
      rpc,
      maxTurns: 1,
      prompt: "Fix",
      title: "Fix",
      cwd: "/tmp/ws",
      threadName: "test",
      sandboxType: "workspace-write",
      approvalPolicy: "never",
      turnSandboxPolicy: { type: "workspaceWrite" },
      turnTimeoutMs: 5000,
      tools: [],
      onEvent: (type) => events.push(type),
    });

    await Promise.resolve();
    await expect(
      rpc.requestHandler("item/commandExecution/requestApproval", {}),
    ).resolves.toEqual({ decision: "accept" });
    await expect(
      rpc.requestHandler("item/fileChange/requestApproval", {}),
    ).resolves.toEqual({ decision: "accept" });
    await resultPromise;

    expect(events.filter((e) => e === "approval_auto_approved")).toHaveLength(2);
  });
});
