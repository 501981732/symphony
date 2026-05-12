import { afterEach, describe, expect, it } from "vitest";

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnRpc } from "@issuepilot/runner-codex-app-server";

import type { ScriptStep } from "./script.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TSX_BIN = join(HERE, "..", "..", "node_modules", ".bin", "tsx");
const FAKE_MAIN = join(HERE, "main.ts");

interface Workspace {
  dir: string;
  scriptPath: string;
  cleanup: () => void;
}

function writeScript(steps: ScriptStep[]): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "issuepilot-fake-codex-"));
  const scriptPath = join(dir, "script.json");
  writeFileSync(scriptPath, JSON.stringify(steps));
  return {
    dir,
    scriptPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("fake codex CLI (main.ts)", () => {
  let ws: Workspace | undefined;

  afterEach(() => {
    ws?.cleanup();
    ws = undefined;
  });

  it("answers an `initialize` request from a real RpcClient", async () => {
    ws = writeScript([
      {
        expect: "initialize",
        respond: { result: { serverInfo: { name: "fake-codex", version: "0.0.0" } } },
      },
      { expect: "initialized" },
    ]);

    const rpc = spawnRpc({
      command: TSX_BIN,
      args: [FAKE_MAIN, ws.scriptPath],
    });

    const reply = await rpc.request<{ serverInfo: { name: string } }>(
      "initialize",
      { client: { name: "test", version: "0.0.0" }, capabilities: {} },
    );
    expect(reply.serverInfo.name).toBe("fake-codex");
    rpc.notify("initialized", {});

    await rpc.close();
    const exit = await rpc.waitExit();
    expect(exit.code === 0 || exit.code === undefined).toBe(true);
  });

  it("exits non-zero when the script expects something the runner never sends", async () => {
    ws = writeScript([{ expect: "thread/start" }]);

    const rpc = spawnRpc({
      command: TSX_BIN,
      args: [FAKE_MAIN, ws.scriptPath],
    });

    rpc.notify("initialized", {});
    await rpc.close();
    const exit = await rpc.waitExit();
    expect(exit.code).not.toBe(0);
  });

  it("supports notification then tool_call then turn/completed", async () => {
    ws = writeScript([
      { expect: "initialize", respond: { result: { ok: true } } },
      { expect: "initialized" },
      { expect: "thread/start", respond: { result: { threadId: "t1" } } },
      { expect: "turn/start", respond: { result: { turnId: "u1" } } },
      {
        notify: "turn/notification",
        params: { turnId: "u1", message: "working" },
      },
      { notify: "turn/completed", params: { turnId: "u1", stop: true } },
    ]);

    const events: string[] = [];
    const rpc = spawnRpc({
      command: TSX_BIN,
      args: [FAKE_MAIN, ws.scriptPath],
    });
    rpc.onNotification((method) => {
      events.push(method);
    });

    await rpc.request("initialize", {});
    rpc.notify("initialized", {});
    await rpc.request("thread/start", {});
    await rpc.request("turn/start", {});

    // Give the fake a moment to drain its notifications.
    await new Promise((r) => setTimeout(r, 50));

    await rpc.close();
    await rpc.waitExit();

    expect(events).toContain("turn/notification");
    expect(events).toContain("turn/completed");
  });
});
