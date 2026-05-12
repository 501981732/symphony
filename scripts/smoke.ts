#!/usr/bin/env node
/**
 * `pnpm smoke` entry point.
 *
 * Spawns the orchestrator daemon as a child process against the workflow
 * passed on the CLI, polls `/api/state` until it reports
 * `service.status === "ready"`, then prints a banner pointing engineers
 * at the dashboard URL so they can walk through the spec §18.3 manual
 * smoke checklist.
 *
 * Signals (`SIGINT`, `SIGTERM`) are forwarded to the daemon and we wait
 * for its clean exit before terminating the wrapper.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { execa } from "execa";

import {
  formatReadyBanner,
  parseSmokeArgs,
  pollUntilReady,
} from "./smoke-runner.js";

async function main(): Promise<number> {
  const parsed = parseSmokeArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`Error: ${parsed.error}`);
    console.error("");
    console.error(
      "Usage: pnpm smoke --workflow <path> [--port 4738] " +
        "[--dashboard-url http://localhost:3000] [--host 127.0.0.1] " +
        "[--readiness-timeout-ms 15000]",
    );
    return 1;
  }
  const opts = parsed.options;

  const workflowAbs = path.resolve(opts.workflowPath);
  if (!fs.existsSync(workflowAbs)) {
    console.error(`Error: workflow file not found at ${workflowAbs}.`);
    return 1;
  }

  const repoRoot = process.cwd();
  console.log(
    `[smoke] starting orchestrator daemon on ${opts.apiHost}:${opts.port}…`,
  );

  const child = execa(
    "pnpm",
    [
      "--filter",
      "@issuepilot/orchestrator",
      "exec",
      "node",
      "dist/bin.js",
      "run",
      "--workflow",
      workflowAbs,
      "--port",
      String(opts.port),
    ],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
      reject: false,
    },
  );

  let stopped = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopped) return;
    stopped = true;
    console.log(`\n[smoke] received ${signal}, shutting daemon down…`);
    try {
      child.kill(signal);
    } catch {
      // swallow — child may already be gone.
    }
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  let banner = "";
  try {
    const state = await pollUntilReady(
      `http://${opts.apiHost}:${opts.port}/api/state`,
      { timeoutMs: opts.readinessTimeoutMs, intervalMs: 250 },
    );
    banner = formatReadyBanner({
      apiUrl: `http://${opts.apiHost}:${opts.port}`,
      dashboardUrl: opts.dashboardUrl,
      state,
    });
    console.log(banner);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[smoke] readiness check failed: ${message}`);
    stop("SIGTERM");
    await child;
    return 1;
  }

  const result = await child;
  if (result.exitCode && result.exitCode !== 0 && !stopped) {
    console.error(`[smoke] daemon exited with code ${result.exitCode}.`);
    return result.exitCode;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[smoke] fatal: ${message}`);
    process.exitCode = 1;
  });
