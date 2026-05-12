/**
 * Script engine for the fake Codex app-server.
 *
 * A script is an ordered list of steps:
 *   - `expect`  — wait for a JSON-RPC request or notification with the given
 *                 method coming from the runner; if `respond` is set and the
 *                 message carries an id, reply with the given result/error.
 *   - `notify`  — send a JSON-RPC notification (no id) to the runner.
 *   - `tool_call` — send `item/tool/call` as a server-request (with id) and
 *                  wait for the runner's response before moving on.
 *
 * The engine is decoupled from real stdio via the `ScriptIO` interface so the
 * same code is exercised by tests and by the CLI wrapper.
 */

export interface ScriptRespond {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ScriptExpectStep {
  expect: string;
  respond?: ScriptRespond;
  /** When set, allow the wait to be skipped if it takes longer than ms. */
  timeoutMs?: number;
}

export interface ScriptNotifyStep {
  notify: string;
  params?: unknown;
}

export interface ScriptToolCallStep {
  tool_call: {
    callId: string;
    tool: string;
    threadId: string;
    turnId: string;
    arguments: unknown;
  };
}

/**
 * Generic server-request: send any JSON-RPC method as a server-request (has
 * an `id`) and wait for the runner's response. Use this for approval
 * requests, user input requests, or any non-tool-call server-side request.
 */
export interface ScriptRequestStep {
  request: {
    method: string;
    params?: unknown;
  };
  /** Optional callback to inspect the response while the script runs. */
  expectResponse?: {
    /** Either "result" or "error" — used purely for documentation. */
    kind: "result" | "error";
  };
}

export type ScriptStep =
  | ScriptExpectStep
  | ScriptNotifyStep
  | ScriptToolCallStep
  | ScriptRequestStep;

export interface ScriptIO {
  /** Read the next newline-delimited JSON message. Resolve null on EOF. */
  readLine(): Promise<string | null>;
  /** Write a newline-delimited JSON message. */
  writeLine(line: string): void;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function isExpect(step: ScriptStep): step is ScriptExpectStep {
  return Object.prototype.hasOwnProperty.call(step, "expect");
}
function isNotify(step: ScriptStep): step is ScriptNotifyStep {
  return Object.prototype.hasOwnProperty.call(step, "notify");
}
function isToolCall(step: ScriptStep): step is ScriptToolCallStep {
  return Object.prototype.hasOwnProperty.call(step, "tool_call");
}
function isRequest(step: ScriptStep): step is ScriptRequestStep {
  return Object.prototype.hasOwnProperty.call(step, "request");
}

/**
 * Run a script against the provided IO. The promise resolves once all steps
 * have been processed; it rejects on protocol violation (unexpected method,
 * malformed JSON, EOF before script completion, etc.).
 */
export async function runScript(
  steps: readonly ScriptStep[],
  io: ScriptIO,
): Promise<void> {
  // Tool-call IDs use their own counter so they cannot collide with client ids.
  let serverRequestId = 100_000;
  // Cache pending server-request ids so we can route their responses.
  const pendingToolCalls = new Map<
    number,
    {
      resolve: (msg: JsonRpcMessage) => void;
      reject: (err: Error) => void;
    }
  >();
  // Buffer of messages that arrived while we were waiting on something else.
  const queued: JsonRpcMessage[] = [];

  /**
   * Read the next message from the runner. tool-call responses get routed to
   * their waiter and we report that fact by returning a `routed` sentinel so
   * the caller can decide whether to keep waiting (e.g. for an `expect`) or
   * stop (e.g. when the tool_call step already has its response).
   */
  type ReadOutcome =
    | { kind: "message"; value: JsonRpcMessage }
    | { kind: "routed" }
    | { kind: "eof" };

  async function readOne(): Promise<ReadOutcome> {
    if (queued.length > 0) {
      return { kind: "message", value: queued.shift() as JsonRpcMessage };
    }
    const line = await io.readLine();
    if (line === null) return { kind: "eof" };
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return readOne();
    }
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcMessage;
    } catch (err) {
      throw new Error(`malformed JSON from runner: ${(err as Error).message}`);
    }
    if (
      typeof parsed.id === "number" &&
      parsed.method === undefined &&
      pendingToolCalls.has(parsed.id)
    ) {
      const waiter = pendingToolCalls.get(parsed.id);
      if (waiter) {
        pendingToolCalls.delete(parsed.id);
        waiter.resolve(parsed);
      }
      return { kind: "routed" };
    }
    return { kind: "message", value: parsed };
  }

  async function nextMessage(): Promise<JsonRpcMessage | null> {
    while (true) {
      const outcome = await readOne();
      if (outcome.kind === "message") return outcome.value;
      if (outcome.kind === "eof") return null;
      // routed — keep reading until we get a regular message.
    }
  }

  for (const step of steps) {
    if (isExpect(step)) {
      const msg = await nextMessage();
      if (!msg) {
        throw new Error(
          `expected ${step.expect} but runner closed the connection`,
        );
      }
      if (msg.method !== step.expect) {
        throw new Error(
          `expected ${step.expect} but received ${String(msg.method ?? "(no method)")}`,
        );
      }
      if (step.respond) {
        if (msg.id === undefined || msg.id === null) {
          throw new Error(
            `cannot respond to a notification (${step.expect}); drop the respond field for notifications`,
          );
        }
        const payload: Record<string, unknown> = {
          jsonrpc: "2.0",
          id: msg.id,
        };
        if (step.respond.error !== undefined) {
          payload["error"] = step.respond.error;
        } else {
          payload["result"] = step.respond.result ?? null;
        }
        io.writeLine(JSON.stringify(payload));
      }
    } else if (isNotify(step)) {
      const payload: Record<string, unknown> = {
        jsonrpc: "2.0",
        method: step.notify,
      };
      if (step.params !== undefined) payload["params"] = step.params;
      io.writeLine(JSON.stringify(payload));
    } else if (isToolCall(step)) {
      serverRequestId += 1;
      const id = serverRequestId;
      const payload = {
        jsonrpc: "2.0",
        id,
        method: "item/tool/call",
        params: {
          callId: step.tool_call.callId,
          tool: step.tool_call.tool,
          threadId: step.tool_call.threadId,
          turnId: step.tool_call.turnId,
          arguments: step.tool_call.arguments,
        },
      };
      const responsePromise = new Promise<JsonRpcMessage>((resolve, reject) => {
        pendingToolCalls.set(id, { resolve, reject });
      });
      io.writeLine(JSON.stringify(payload));
      // Pump messages until the matching response arrives. Routed messages
      // (the response we want) end the loop; regular messages get queued so
      // the next `expect` can consume them.
      while (pendingToolCalls.has(id)) {
        const outcome = await readOne();
        if (outcome.kind === "eof") {
          if (pendingToolCalls.has(id)) {
            pendingToolCalls.delete(id);
            throw new Error(
              `tool_call ${step.tool_call.tool} did not receive a response before EOF`,
            );
          }
          break;
        }
        if (outcome.kind === "message") {
          queued.push(outcome.value);
        }
        // routed — loop condition will exit naturally on next iteration.
      }
      await responsePromise;
    } else if (isRequest(step)) {
      serverRequestId += 1;
      const id = serverRequestId;
      const payload: Record<string, unknown> = {
        jsonrpc: "2.0",
        id,
        method: step.request.method,
      };
      if (step.request.params !== undefined) {
        payload["params"] = step.request.params;
      }
      const responsePromise = new Promise<JsonRpcMessage>((resolve, reject) => {
        pendingToolCalls.set(id, { resolve, reject });
      });
      io.writeLine(JSON.stringify(payload));
      while (pendingToolCalls.has(id)) {
        const outcome = await readOne();
        if (outcome.kind === "eof") {
          if (pendingToolCalls.has(id)) {
            pendingToolCalls.delete(id);
            throw new Error(
              `request ${step.request.method} did not receive a response before EOF`,
            );
          }
          break;
        }
        if (outcome.kind === "message") {
          queued.push(outcome.value);
        }
      }
      await responsePromise;
    } else {
      // exhaustive
      const _never: never = step;
      throw new Error(`unknown script step: ${JSON.stringify(_never)}`);
    }
  }
}
