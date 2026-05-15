import { describe, expect, it } from "vitest";

import { runScript, type ScriptIO, type ScriptStep } from "./script.js";

interface CapturedMessage {
  readonly raw: string;
  readonly value: Record<string, unknown>;
}

function createTestIO(): {
  io: ScriptIO;
  send: (msg: Record<string, unknown>) => void;
  end: () => void;
  written: CapturedMessage[];
  awaitWritten: (count: number, timeoutMs?: number) => Promise<void>;
} {
  const written: CapturedMessage[] = [];
  const incoming: string[] = [];
  let resolveNext: ((value: string | null) => void) | null = null;
  let ended = false;

  const io: ScriptIO = {
    async readLine() {
      if (incoming.length > 0) {
        return incoming.shift() as string;
      }
      if (ended) return null;
      return new Promise<string | null>((resolve) => {
        resolveNext = resolve;
      });
    },
    writeLine(line: string) {
      const value = JSON.parse(line) as Record<string, unknown>;
      written.push({ raw: line, value });
    },
  };

  return {
    io,
    send(msg) {
      const line = JSON.stringify(msg);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(line);
      } else {
        incoming.push(line);
      }
    },
    end() {
      ended = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(null);
      }
    },
    written,
    async awaitWritten(count, timeoutMs = 1000) {
      const deadline = Date.now() + timeoutMs;
      while (written.length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `awaitWritten timed out: wanted ${count} writes, got ${written.length}`,
          );
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}

describe("runScript", () => {
  it("expect+respond mirrors a JSON-RPC request id and sends result", async () => {
    const steps: ScriptStep[] = [
      {
        expect: "initialize",
        respond: { result: { serverInfo: { name: "fake-codex" } } },
      },
    ];
    const { io, send, end, written, awaitWritten } = createTestIO();
    const done = runScript(steps, io);

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await awaitWritten(1);
    end();
    await done;

    expect(written).toHaveLength(1);
    expect(written[0]?.value).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "fake-codex" } },
    });
  });

  it("expect accepts a notification (no response needed)", async () => {
    const steps: ScriptStep[] = [
      { expect: "initialized" },
      { notify: "session/marker", params: { ok: true } },
    ];
    const { io, send, end, written, awaitWritten } = createTestIO();
    const done = runScript(steps, io);

    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    await awaitWritten(1);
    end();
    await done;

    expect(written[0]?.value).toMatchObject({
      method: "session/marker",
      params: { ok: true },
    });
    expect(written[0]?.value["id"]).toBeUndefined();
  });

  it("tool_call sends a server-request and waits for its result", async () => {
    const steps: ScriptStep[] = [
      {
        tool_call: {
          callId: "c1",
          tool: "gitlab_create_issue_note",
          threadId: "t1",
          turnId: "u1",
          arguments: { iid: 42, body: "hi" },
        },
      },
    ];
    const { io, send, end, written, awaitWritten } = createTestIO();
    const done = runScript(steps, io);

    await awaitWritten(1);
    const sent = written[0]?.value as Record<string, unknown>;
    expect(sent["method"]).toBe("item/tool/call");
    expect(sent["id"]).toBeTypeOf("number");

    send({
      jsonrpc: "2.0",
      id: sent["id"],
      result: { success: true, contentItems: [] },
    });
    end();
    await done;
  });

  it("throws when expect sees the wrong method", async () => {
    const steps: ScriptStep[] = [{ expect: "initialize" }];
    const { io, send, end } = createTestIO();
    const done = runScript(steps, io);
    send({ jsonrpc: "2.0", id: 1, method: "other/method", params: {} });
    end();
    await expect(done).rejects.toThrow(/expected initialize/i);
  });

  it("supports an error response on expect", async () => {
    const steps: ScriptStep[] = [
      {
        expect: "initialize",
        respond: { error: { code: -32000, message: "boom" } },
      },
    ];
    const { io, send, end, written, awaitWritten } = createTestIO();
    const done = runScript(steps, io);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await awaitWritten(1);
    end();
    await done;
    expect(written[0]?.value).toMatchObject({
      id: 1,
      error: { code: -32000, message: "boom" },
    });
  });

  it("request + expectResponse=result accepts a result reply", async () => {
    const steps: ScriptStep[] = [
      {
        request: { method: "item/commandExecution/requestApproval" },
        expectResponse: { kind: "result" },
      },
    ];
    const { io, send, end, written, awaitWritten } = createTestIO();
    const done = runScript(steps, io);
    await awaitWritten(1);
    const sent = written[0]?.value as Record<string, unknown>;
    send({
      jsonrpc: "2.0",
      id: sent["id"],
      result: { decision: "accept" },
    });
    end();
    await done;
  });

  it("request + expectResponse=result rejects an error reply", async () => {
    const steps: ScriptStep[] = [
      {
        request: { method: "item/commandExecution/requestApproval" },
        expectResponse: { kind: "result" },
      },
    ];
    const { io, send, end, written, awaitWritten } = createTestIO();
    const done = runScript(steps, io);
    await awaitWritten(1);
    const sent = written[0]?.value as Record<string, unknown>;
    send({
      jsonrpc: "2.0",
      id: sent["id"],
      error: { code: -32000, message: "denied" },
    });
    end();
    await expect(done).rejects.toThrow(/expected a result but received error/i);
  });

  it("request + expectResponse=error rejects an unexpected result", async () => {
    const steps: ScriptStep[] = [
      {
        request: { method: "item/commandExecution/requestApproval" },
        expectResponse: { kind: "error" },
      },
    ];
    const { io, send, end, written, awaitWritten } = createTestIO();
    const done = runScript(steps, io);
    await awaitWritten(1);
    const sent = written[0]?.value as Record<string, unknown>;
    send({
      jsonrpc: "2.0",
      id: sent["id"],
      result: { decision: "accept" },
    });
    end();
    await expect(done).rejects.toThrow(
      /expected an error but received result/i,
    );
  });
});
