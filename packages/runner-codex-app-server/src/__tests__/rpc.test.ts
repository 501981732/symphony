import { describe, it, expect, afterEach } from "vitest";
import { spawnRpc } from "../rpc.js";

describe("spawnRpc", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  it("sends a request and receives a response", async () => {
    const script = `
      process.stdin.setEncoding("utf-8");
      let buf = "";
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const msg = JSON.parse(line);
            if (msg.method === "echo") {
              const resp = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.params });
              process.stdout.write(resp + "\\n");
            }
          } catch {}
        }
      });
    `;

    const rpc = spawnRpc({ command: "node", args: ["-e", script] });
    cleanup = async () => rpc.close();

    const result = await rpc.request("echo", { hello: "world" });
    expect(result).toEqual({ hello: "world" });
  });

  it("resolves notify without waiting for response", async () => {
    const script = `
      process.stdin.resume();
      setTimeout(() => process.exit(0), 2000);
    `;

    const rpc = spawnRpc({ command: "node", args: ["-e", script] });
    cleanup = async () => rpc.close();

    rpc.notify("ping", {});
  });

  it("rejects pending requests when process exits", async () => {
    const script = `
      setTimeout(() => process.exit(0), 100);
    `;

    const rpc = spawnRpc({ command: "node", args: ["-e", script] });
    cleanup = async () => rpc.close();

    await expect(rpc.request("test", {})).rejects.toThrow();
  });

  it("calls onNotification for server-initiated messages", async () => {
    const script = `
      const msg = JSON.stringify({ jsonrpc: "2.0", method: "server/event", params: { type: "hello" } });
      process.stdout.write(msg + "\\n");
      process.stdin.resume();
      setTimeout(() => process.exit(0), 1000);
    `;

    const rpc = spawnRpc({ command: "node", args: ["-e", script] });
    cleanup = async () => rpc.close();

    const received = await new Promise<{ method: string; params: unknown }>(
      (resolve) => {
        rpc.onNotification((method, params) => {
          resolve({ method, params });
        });
      },
    );

    expect(received.method).toBe("server/event");
    expect(received.params).toEqual({ type: "hello" });
  });

  it("responds to server-initiated requests", async () => {
    const script = `
      process.stdin.setEncoding("utf-8");
      let buf = "";
      setTimeout(() => {
        const req = JSON.stringify({ jsonrpc: "2.0", id: "srv-1", method: "server/ask", params: { value: 2 } });
        process.stdout.write(req + "\\n");
      }, 10);
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const msg = JSON.parse(line);
          if (msg.id === "srv-1") {
            const note = JSON.stringify({ jsonrpc: "2.0", method: "server/response-seen", params: msg.result });
            process.stdout.write(note + "\\n");
          }
        }
      });
    `;

    const rpc = spawnRpc({ command: "node", args: ["-e", script] });
    cleanup = async () => rpc.close();
    rpc.onRequest((_method, params) => ({
      doubled: (params as { value: number }).value * 2,
    }));

    const received = await new Promise<{ method: string; params: unknown }>(
      (resolve) => {
        rpc.onNotification((method, params) => resolve({ method, params }));
      },
    );

    expect(received.method).toBe("server/response-seen");
    expect(received.params).toEqual({ doubled: 4 });
  });

  it("returns JSON-RPC errors for unhandled server-initiated requests", async () => {
    const script = `
      process.stdin.setEncoding("utf-8");
      let buf = "";
      setTimeout(() => {
        const req = JSON.stringify({ jsonrpc: "2.0", id: "srv-1", method: "server/ask", params: {} });
        process.stdout.write(req + "\\n");
      }, 10);
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const msg = JSON.parse(line);
          if (msg.id === "srv-1") {
            const note = JSON.stringify({ jsonrpc: "2.0", method: "server/error-seen", params: msg.error });
            process.stdout.write(note + "\\n");
          }
        }
      });
    `;

    const rpc = spawnRpc({ command: "node", args: ["-e", script] });
    cleanup = async () => rpc.close();

    const received = await new Promise<{ method: string; params: unknown }>(
      (resolve) => {
        rpc.onNotification((method, params) => resolve({ method, params }));
      },
    );

    expect(received.method).toBe("server/error-seen");
    expect(received.params).toMatchObject({ code: -32603 });
  });

  it("calls onMalformed for non-JSON lines", async () => {
    const script = `
      process.stdout.write("not json\\n");
      process.stdin.resume();
      setTimeout(() => process.exit(0), 1000);
    `;

    const rpc = spawnRpc({ command: "node", args: ["-e", script] });
    cleanup = async () => rpc.close();

    const malformed = await new Promise<string>((resolve) => {
      rpc.onMalformed((line) => {
        resolve(line);
      });
    });

    expect(malformed).toBe("not json");
  });

  it("waitExit resolves with exit code", async () => {
    const script = `process.exit(42);`;

    const rpc = spawnRpc({ command: "node", args: ["-e", script] });
    cleanup = async () => rpc.close();

    const exit = await rpc.waitExit();
    expect(exit.code).toBe(42);
  });
});
