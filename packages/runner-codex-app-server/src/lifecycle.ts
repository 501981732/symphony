import type { RpcClient } from "./rpc.js";

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: object;
  handler?: ((args: unknown) => Promise<unknown>) | undefined;
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
  /**
   * Optional hook invoked at the start of each turn. The supplied closure
   * issues a `turn/interrupt` JSON-RPC request bound to the current
   * `(threadId, turnId)`. After the turn settles (any outcome), calling the
   * closure becomes a noop so callers do not need to track turn state. The
   * hook may be called multiple times if `maxTurns > 1` — each turn receives
   * a fresh closure tied to its own turnId.
   */
  onTurnActive?: (cancel: () => Promise<void>) => void;
}

export interface DriveResult {
  status: "completed" | "failed" | "blocked" | "cancelled" | "timeout";
  turnsUsed: number;
  lastTurnId?: string | undefined;
  threadId?: string | undefined;
  failureReason?: string | undefined;
}

interface DynamicToolCallParams {
  arguments: unknown;
  callId: string;
  threadId: string;
  tool: string;
  turnId: string;
}

interface QueuedNotification {
  method: string;
  params: unknown;
}

type TurnOutcome =
  | { kind: "completed"; stop: boolean }
  | { kind: "failed"; error: string }
  | { kind: "cancelled" }
  | { kind: "timeout" };

type NotificationConsumer = (method: string, params: unknown) => boolean;

const NON_INTERACTIVE_INPUT_REPLY =
  "This is a non-interactive IssuePilot run. Operator input is unavailable. " +
  "If blocked, record the blocker and mark the issue ai-blocked.";

const NOTIFICATION_EVENT_MAP: Record<string, string> = {
  "turn/notification": "notification",
};

function nestedId(
  params: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const nested = params?.[key];
  if (!nested || typeof nested !== "object") return undefined;
  const id = (nested as Record<string, unknown>)["id"];
  return typeof id === "string" ? id : undefined;
}

function eventTurnId(
  params: Record<string, unknown> | undefined,
): string | undefined {
  const direct = params?.["turnId"];
  return typeof direct === "string" ? direct : nestedId(params, "turn");
}

function resultThreadId(result: unknown): string {
  const direct = (result as { threadId?: unknown }).threadId;
  if (typeof direct === "string") return direct;

  const nested = (result as { thread?: { id?: unknown } }).thread?.id;
  if (typeof nested === "string") return nested;

  throw new Error("thread/start response did not include a thread id");
}

function resultTurnId(result: unknown): string {
  const direct = (result as { turnId?: unknown }).turnId;
  if (typeof direct === "string") return direct;

  const nested = (result as { turn?: { id?: unknown } }).turn?.id;
  if (typeof nested === "string") return nested;

  throw new Error("turn/start response did not include a turn id");
}

function normalizeSandboxPolicy(
  policy: { type: string } & Record<string, unknown>,
  cwd: string,
): Record<string, unknown> {
  if (policy.type === "workspaceWrite") {
    return {
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
      ...policy,
    };
  }

  if (policy.type === "readOnly") {
    return {
      networkAccess: false,
      ...policy,
    };
  }

  return policy;
}

function notificationOutcome(
  method: string,
  params: unknown,
  turnId: string,
  onEvent: (type: string, data?: unknown) => void,
): TurnOutcome | undefined {
  const p = params as Record<string, unknown> | undefined;
  const currentTurnId = eventTurnId(p);

  if (method === "turn/completed" && currentTurnId === turnId) {
    onEvent("turn_completed", params);
    const turnStatus = (p?.["turn"] as { status?: unknown } | undefined)
      ?.status;
    if (turnStatus === "interrupted") {
      return { kind: "cancelled" };
    }
    return { kind: "completed", stop: p?.["stop"] !== false };
  }
  if (method === "turn/failed" && currentTurnId === turnId) {
    onEvent("turn_failed", params);
    return {
      kind: "failed",
      error: String(p?.["error"] ?? "unknown"),
    };
  }
  if (method === "turn/cancelled" && currentTurnId === turnId) {
    onEvent("turn_cancelled", params);
    return { kind: "cancelled" };
  }
  if (method === "turn/timeout" && currentTurnId === turnId) {
    onEvent("turn_timeout", params);
    return { kind: "timeout" };
  }

  const eventType = NOTIFICATION_EVENT_MAP[method] ?? "malformed_message";
  onEvent(eventType, params);
  return undefined;
}

function waitForTurn(
  queuedNotifications: QueuedNotification[],
  setNotificationConsumer: (consumer: NotificationConsumer | null) => void,
  turnId: string,
  timeoutMs: number,
  onEvent: (type: string, data?: unknown) => void,
): Promise<TurnOutcome> {
  return new Promise<TurnOutcome>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      setNotificationConsumer(null);
      resolve({ kind: "timeout" });
    }, timeoutMs);

    const settle = (outcome: TurnOutcome): void => {
      if (settled) return;
      settled = true;
      setNotificationConsumer(null);
      clearTimeout(timer);
      resolve(outcome);
    };

    const consume: NotificationConsumer = (method, params) => {
      const outcome = notificationOutcome(method, params, turnId, onEvent);
      if (outcome) {
        settle(outcome);
      }
      return true;
    };

    while (queuedNotifications.length > 0 && !settled) {
      const next = queuedNotifications.shift()!;
      consume(next.method, next.params);
    }

    if (!settled) {
      setNotificationConsumer(consume);
    }
  });
}

export async function driveLifecycle(input: DriveInput): Promise<DriveResult> {
  const { rpc, onEvent } = input;
  const toolsByName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const queuedNotifications: QueuedNotification[] = [];
  let notificationConsumer: NotificationConsumer | null = null;

  rpc.onNotification((method, params) => {
    if (notificationConsumer?.(method, params)) return;
    queuedNotifications.push({ method, params });
  });

  rpc.onRequest(async (method, params) => {
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      if (input.approvalPolicy === "never") {
        onEvent("approval_auto_approved", params);
        return { decision: "accept" };
      }
      onEvent("approval_required", params);
      return { decision: "cancel" };
    }

    if (method === "item/tool/requestUserInput") {
      onEvent("turn_input_required", params);
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: NON_INTERACTIVE_INPUT_REPLY,
          },
        ],
      };
    }

    if (method !== "item/tool/call") {
      throw new Error(`Unsupported server request: ${method}`);
    }

    const call = params as DynamicToolCallParams;
    const tool = toolsByName.get(call.tool);
    if (!tool?.handler) {
      onEvent("unsupported_tool_call", params);
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: `Unsupported tool: ${call.tool}`,
          },
        ],
      };
    }

    onEvent("tool_call_started", params);
    try {
      const result = await tool.handler(call.arguments);
      onEvent("tool_call_completed", { ...call, result });
      return {
        success: true,
        contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onEvent("tool_call_failed", { ...call, error: message });
      return {
        success: false,
        contentItems: [{ type: "inputText", text: message }],
      };
    }
  });

  await rpc.request("initialize", {
    clientInfo: { name: "issuepilot", version: "0.0.0" },
    capabilities: {},
  });
  rpc.notify("initialized", {});
  onEvent("session_started");

  const threadResult = (await rpc.request("thread/start", {
    cwd: input.cwd,
    sandbox: input.sandboxType,
    approvalPolicy: input.approvalPolicy,
    tools: input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  })) as unknown;

  const threadId = resultThreadId(threadResult);
  let turnsUsed = 0;
  let lastTurnId: string | undefined;

  for (let i = 0; i < input.maxTurns; i++) {
    const turnResult = (await rpc.request("turn/start", {
      threadId,
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      cwd: input.cwd,
      sandboxPolicy: normalizeSandboxPolicy(input.turnSandboxPolicy, input.cwd),
    })) as unknown;

    const turnId = resultTurnId(turnResult);
    lastTurnId = turnId;
    turnsUsed++;
    onEvent("turn_started", { turnId });

    let turnSettled = false;
    const cancelTurn = async (): Promise<void> => {
      if (turnSettled) return;
      await rpc.request("turn/interrupt", { threadId, turnId });
    };
    input.onTurnActive?.(cancelTurn);

    const outcome = await waitForTurn(
      queuedNotifications,
      (consumer) => {
        notificationConsumer = consumer;
      },
      turnId,
      input.turnTimeoutMs,
      onEvent,
    );
    turnSettled = true;

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

    if (
      outcome.kind === "completed" &&
      !outcome.stop &&
      i === input.maxTurns - 1
    ) {
      return { status: "completed", turnsUsed, lastTurnId, threadId };
    }
  }

  return { status: "completed", turnsUsed, lastTurnId, threadId };
}
