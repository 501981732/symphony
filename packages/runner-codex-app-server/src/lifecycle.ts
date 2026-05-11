import type { RpcClient } from "./rpc.js";

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: object;
}

export interface DriveInput {
  rpc: RpcClient;
  maxTurns: number;
  prompt: string;
  title: string;
  cwd: string;
  threadName: string;
  sandboxType: string;
  approvalPolicy: string;
  turnSandboxPolicy: { type: string };
  turnTimeoutMs: number;
  tools: ToolSchema[];
  onEvent: (type: string, data?: unknown) => void;
}

export interface DriveResult {
  status: "completed" | "failed" | "blocked" | "cancelled" | "timeout";
  turnsUsed: number;
  lastTurnId?: string | undefined;
  threadId?: string | undefined;
  failureReason?: string | undefined;
}

type TurnOutcome =
  | { kind: "completed"; stop: boolean }
  | { kind: "failed"; error: string }
  | { kind: "cancelled" }
  | { kind: "timeout" };

function waitForTurn(
  rpc: RpcClient,
  turnId: string,
  timeoutMs: number,
  onEvent: (type: string, data?: unknown) => void,
): Promise<TurnOutcome> {
  return new Promise<TurnOutcome>((resolve) => {
    const timer = setTimeout(() => {
      resolve({ kind: "timeout" });
    }, timeoutMs);

    rpc.onNotification((method, params) => {
      const p = params as Record<string, unknown> | undefined;

      if (method === "turn/completed" && p?.["turnId"] === turnId) {
        clearTimeout(timer);
        onEvent("turn_completed", params);
        resolve({ kind: "completed", stop: !!p["stop"] });
      } else if (method === "turn/failed" && p?.["turnId"] === turnId) {
        clearTimeout(timer);
        onEvent("turn_failed", params);
        resolve({
          kind: "failed",
          error: String(p["error"] ?? "unknown"),
        });
      } else if (method === "turn/cancelled" && p?.["turnId"] === turnId) {
        clearTimeout(timer);
        onEvent("turn_cancelled", params);
        resolve({ kind: "cancelled" });
      } else if (method === "turn/timeout" && p?.["turnId"] === turnId) {
        clearTimeout(timer);
        onEvent("turn_timeout", params);
        resolve({ kind: "timeout" });
      } else {
        onEvent(method.replace(/\//g, "_"), params);
      }
    });
  });
}

export async function driveLifecycle(input: DriveInput): Promise<DriveResult> {
  const { rpc, onEvent } = input;

  await rpc.request("initialize", {
    client: { name: "issuepilot", version: "0.0.0" },
    capabilities: {},
  });
  rpc.notify("initialized", {});
  onEvent("session_started");

  const threadResult = (await rpc.request("thread/start", {
    name: input.threadName,
    cwd: input.cwd,
    sandbox: { type: input.sandboxType },
    approvalPolicy: input.approvalPolicy,
    tools: input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  })) as { threadId: string };

  const threadId = threadResult.threadId;
  let turnsUsed = 0;
  let lastTurnId: string | undefined;

  for (let i = 0; i < input.maxTurns; i++) {
    const turnResult = (await rpc.request("turn/start", {
      threadId,
      prompt: input.prompt,
      title: input.title,
      cwd: input.cwd,
      sandboxPolicy: input.turnSandboxPolicy,
    })) as { turnId: string };

    const turnId = turnResult.turnId;
    lastTurnId = turnId;
    turnsUsed++;
    onEvent("turn_started", { turnId });

    const outcome = await waitForTurn(
      rpc,
      turnId,
      input.turnTimeoutMs,
      onEvent,
    );

    if (outcome.kind === "completed" && outcome.stop) {
      return { status: "completed", turnsUsed, lastTurnId, threadId };
    }
    if (outcome.kind === "failed") {
      return {
        status: "failed",
        turnsUsed,
        lastTurnId,
        threadId,
        failureReason: outcome.error,
      };
    }
    if (outcome.kind === "cancelled") {
      return { status: "cancelled", turnsUsed, lastTurnId, threadId };
    }
    if (outcome.kind === "timeout") {
      return {
        status: "timeout",
        turnsUsed,
        lastTurnId,
        threadId,
        failureReason: "Turn timed out",
      };
    }

    if (outcome.kind === "completed" && !outcome.stop && i === input.maxTurns - 1) {
      return { status: "completed", turnsUsed, lastTurnId, threadId };
    }
  }

  return { status: "completed", turnsUsed, lastTurnId, threadId };
}
