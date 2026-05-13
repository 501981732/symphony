/**
 * Combined "spin up daemon + wait for issue label" harness.
 *
 * Most e2e cases follow the same shape: start the orchestrator daemon
 * against a freshly-built workspace, then wait for the fake GitLab to
 * observe the label transition that signals the scenario completed.
 * This helper folds both into a single call so individual `it(...)`
 * blocks can focus on the differentiated assertions.
 */

import {
  startDaemon,
  startLoop as realStartLoop,
  type LoopDeps,
  type LoopHandle,
} from "@issuepilot/orchestrator";

import { pickFreePort } from "./net.js";
import type { E2EWorkspace } from "./workspace.js";

type DaemonHandle = Awaited<ReturnType<typeof startDaemon>>;

interface RunUntilLabelOptions {
  ws: E2EWorkspace;
  iid: number;
  expectLabel: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface RunUntilLabelResult {
  daemon: DaemonHandle;
}

export async function runUntilLabel(
  opts: RunUntilLabelOptions,
): Promise<RunUntilLabelResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  function withFastPoll(deps: LoopDeps): LoopHandle {
    return realStartLoop({
      ...deps,
      pollIntervalMs,
      loadConfig: () => ({ pollIntervalMs }),
    });
  }

  const port = await pickFreePort();
  const daemon = await startDaemon(
    { workflowPath: opts.ws.workflowPath, port },
    { startLoop: withFastPoll },
  );

  await opts.ws.gitlabServer.waitFor(
    (state) => {
      const issue = state.issues.get(opts.iid);
      return !!issue && issue.labels.includes(opts.expectLabel);
    },
    { timeoutMs, intervalMs: 50 },
  );

  return { daemon };
}
