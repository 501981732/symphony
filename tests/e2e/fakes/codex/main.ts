#!/usr/bin/env node
/**
 * CLI entry for the fake Codex app-server. Reads a script from the path in
 * `IPILOT_FAKE_SCRIPT` (or the first CLI argument) and replays it against
 * stdin/stdout in newline-delimited JSON-RPC form.
 *
 * Designed to be spawnable from `@issuepilot/runner-codex-app-server` so the
 * full runner lifecycle can be exercised in tests.
 */

import { readFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";

import { runScript, type ScriptIO, type ScriptStep } from "./script.js";

function resolveScriptPath(): string {
  const fromEnv = process.env["IPILOT_FAKE_SCRIPT"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const fromArg = process.argv[2];
  if (fromArg && fromArg.length > 0) return fromArg;
  throw new Error(
    "fake-codex: set IPILOT_FAKE_SCRIPT or pass a script path as the first argument",
  );
}

function loadScript(path: string): ScriptStep[] {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`fake-codex: script ${path} must be a JSON array`);
  }
  return parsed as ScriptStep[];
}

function createStdioIO(rl: Interface): {
  io: ScriptIO;
  close: () => void;
} {
  const buffer: string[] = [];
  let resolveNext: ((value: string | null) => void) | null = null;
  let ended = false;

  rl.on("line", (line: string) => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(line);
    } else {
      buffer.push(line);
    }
  });
  rl.on("close", () => {
    ended = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(null);
    }
  });

  const io: ScriptIO = {
    async readLine() {
      if (buffer.length > 0) return buffer.shift() as string;
      if (ended) return null;
      return new Promise<string | null>((resolve) => {
        resolveNext = resolve;
      });
    },
    writeLine(line: string) {
      process.stdout.write(line + "\n");
    },
  };
  return {
    io,
    close: () => {
      ended = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(null);
      }
    },
  };
}

async function main(): Promise<void> {
  const scriptPath = resolveScriptPath();
  const steps = loadScript(scriptPath);
  const rl = createInterface({ input: process.stdin });
  const { io, close } = createStdioIO(rl);

  try {
    await runScript(steps, io);
  } catch (err) {
    process.stderr.write(
      `fake-codex error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  } finally {
    close();
    rl.close();
  }
}

void main();
