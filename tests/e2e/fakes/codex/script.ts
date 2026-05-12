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

export type ScriptStep = ScriptExpectStep | ScriptNotifyStep | ScriptToolCallStep;

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

  async function nextMessage(): Promise<JsonRpcMessage | null> {
    if (queued.length > 0) {
      return queued.shift() as JsonRpcMessage;
    }
    while (true) {
      const line = await io.readLine();
      if (line === null) return null;
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(trimmed) as JsonRpcMessage;
      } catch (err) {
        throw new Error(`malformed JSON from runner: ${(err as Error).message}`);
      }
      // Route tool-call responses to their waiter without blocking the script.
      if (
        typeof parsed.id === "number" &&
        parsed.method === undefined &&
        pendingToolCalls.has(parsed.id)
      ) {
        const waiter = pendingToolCalls.get(parsed.id);
        if (!waiter) continue;
        pendingToolCalls.delete(parsed.id);
        waiter.resolve(parsed);
        continue;
      }
      return parsed;
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
      // Pump messages until the matching response arrives. Any non-matching
      // messages get queued so the next `expect` can consume them.
      while (pendingToolCalls.has(id)) {
        const next = await nextMessage();
        if (next === null) {
          // EOF — bail only if we never received the response.
          if (pendingToolCalls.has(id)) {
            pendingToolCalls.delete(id);
            throw new Error(
              `tool_call ${step.tool_call.tool} did not receive a response before EOF`,
            );
          }
          break;
        }
        queued.push(next);
      }
      await responsePromise;
    } else {
      // exhaustive
      const _never: never = step;
      throw new Error(`unknown script step: ${JSON.stringify(_never)}`);
    }
  }
}
