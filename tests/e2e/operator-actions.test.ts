import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  startDaemon,
  startLoop as realStartLoop,
  type LoopDeps,
  type LoopHandle,
} from "@issuepilot/orchestrator";

import { pickFreePort } from "./helpers/net.js";
import {
  createE2EWorkspace,
  E2E_TOKEN,
  type E2EWorkspace,
} from "./helpers/workspace.js";

type DaemonHandle = Awaited<ReturnType<typeof startDaemon>>;

const FAST_POLL_MS = 250;

function withFastPoll(deps: LoopDeps): LoopHandle {
  return realStartLoop({
    ...deps,
    pollIntervalMs: FAST_POLL_MS,
    loadConfig: () => ({ pollIntervalMs: FAST_POLL_MS }),
  });
}

interface RunSnapshot {
  runId: string;
  status: string;
  attempt: number;
}

async function fetchRuns(daemonUrl: string): Promise<RunSnapshot[]> {
  const res = await fetch(`${daemonUrl}/api/runs`);
  if (!res.ok) {
    throw new Error(`GET /api/runs failed: HTTP ${res.status}`);
  }
  return (await res.json()) as RunSnapshot[];
}

async function waitForRunStatus(
  daemonUrl: string,
  predicate: (run: RunSnapshot) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<RunSnapshot> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  const interval = opts.intervalMs ?? 100;
  let lastSeen: RunSnapshot[] = [];
  while (Date.now() < deadline) {
    try {
      lastSeen = await fetchRuns(daemonUrl);
      const match = lastSeen.find(predicate);
      if (match) return match;
    } catch {
      // swallow transient fetch errors while daemon boots
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `waitForRunStatus timed out; last seen: ${JSON.stringify(lastSeen)}`,
  );
}

/**
 * Wait until `/api/events?runId=...` returns at least one event matching the
 * predicate. Required by the stop scenarios because `status=running` is set
 * before the runner spawns codex; the `runCancelRegistry` only gets a
 * cancel closure once `driveLifecycle` reaches `turn/start` and invokes
 * `onTurnActive`. Polling for `codex_turn_started` is the earliest
 * observable signal that the cancel closure is wired.
 */
async function waitForEvent(
  daemonUrl: string,
  runId: string,
  predicate: (event: { type: string }) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  const interval = opts.intervalMs ?? 100;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${daemonUrl}/api/events?runId=${encodeURIComponent(runId)}&limit=500`,
      );
      if (res.ok) {
        const events = (await res.json()) as Array<{ type: string }>;
        if (events.some(predicate)) return;
      }
    } catch {
      // ignore transient errors
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `waitForEvent: no matching event for run ${runId} within ${opts.timeoutMs ?? 15_000}ms`,
  );
}

describe("operator actions E2E", () => {
  let ws: E2EWorkspace | undefined;
  let daemon: DaemonHandle | undefined;
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env["GITLAB_TOKEN"];
    process.env["GITLAB_TOKEN"] = E2E_TOKEN;
  });

  afterEach(async () => {
    try {
      await daemon?.stop();
    } catch {
      // swallow
    }
    daemon = undefined;
    await ws?.cleanup();
    ws = undefined;
    if (originalToken === undefined) {
      delete process.env["GITLAB_TOKEN"];
    } else {
      process.env["GITLAB_TOKEN"] = originalToken;
    }
  });

  it("retry: failed run → POST /retry → state goes claimed + ai-rework label", async () => {
    const ISSUE_IID = 31;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.turn-failed.json",
      issues: [
        {
          iid: ISSUE_IID,
          title: "Operator retry scenario",
          description: "Codex fails; operator clicks Retry.",
          labels: ["ai-ready"],
        },
      ],
    });
    const port = await pickFreePort();
    daemon = await startDaemon(
      { workflowPath: ws.workflowPath, port },
      { startLoop: withFastPoll },
    );

    // First dispatch drives the run to failed via turn/failed.
    await ws.gitlabServer.waitFor(
      (s) => {
        const issue = s.issues.get(ISSUE_IID);
        return !!issue && issue.labels.includes("ai-failed");
      },
      { timeoutMs: 15_000, intervalMs: 50 },
    );

    const runs = await fetchRuns(daemon.url);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.status).toBe("failed");
    expect(run.attempt).toBe(1);

    const resp = await fetch(`${daemon.url}/api/runs/${run.runId}/retry`, {
      method: "POST",
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Right after retry, state should already reflect attempt+1 and
    // status=claimed. The fixture's `active_labels` is just `["ai-ready"]`,
    // so the loop never re-claims this `ai-rework` issue and the run stays
    // at `claimed`. The Phase 2 plan acknowledges this gap: end-to-end
    // re-dispatch (claimed → running → completed/failed) needs either
    // `ai-rework` in `active_labels` (and a runId-reuse rule in
    // `claimCandidates`) or `retryRun` flipping the existing run record to
    // `retrying`. Both are deferred to Phase 3+.
    const afterRetry = (await fetchRuns(daemon.url)).find(
      (r) => r.runId === run.runId,
    );
    expect(afterRetry).toBeDefined();
    expect(afterRetry?.attempt).toBe(2);
    expect(afterRetry?.status).toBe("claimed");

    const issue = ws.gitlabState.issues.get(ISSUE_IID);
    if (!issue) throw new Error("issue gone after retry");
    expect(issue.labels).toContain("ai-rework");
    expect(issue.labels).not.toContain("ai-failed");
    expect(issue.labels).not.toContain("ai-blocked");

    // Verify operator audit events recorded.
    const eventsRes = await fetch(
      `${daemon.url}/api/events?runId=${encodeURIComponent(run.runId)}&limit=500`,
    );
    expect(eventsRes.ok).toBe(true);
    const events = (await eventsRes.json()) as Array<{
      type: string;
      data?: { action?: string };
    }>;
    const retryEvents = events.filter(
      (e) =>
        (e.type === "operator_action_requested" ||
          e.type === "operator_action_succeeded") &&
        e.data?.action === "retry",
    );
    expect(retryEvents.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("stop-interrupt: running run → POST /stop → turn/interrupt → run transitions to failed", async () => {
    const ISSUE_IID = 32;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.stop-interrupt.json",
      // Long turn timeout so the run sits in "running" until the operator
      // clicks Stop. Once turn/interrupt resolves, the runner returns
      // status=cancelled which dispatch funnels into "failed".
      turnTimeoutMs: 20_000,
      issues: [
        {
          iid: ISSUE_IID,
          title: "Operator stop scenario",
          description: "Codex stays mid-turn until the operator stops it.",
          labels: ["ai-ready"],
        },
      ],
    });
    const port = await pickFreePort();
    daemon = await startDaemon(
      { workflowPath: ws.workflowPath, port },
      { startLoop: withFastPoll },
    );

    // Wait for the run to land in "running" state. This happens after the
    // fake codex responded to turn/start but before turn/completed (the
    // fixture blocks at `expect: turn/interrupt`).
    const running = await waitForRunStatus(
      daemon.url,
      (r) => r.status === "running",
      { timeoutMs: 15_000 },
    );

    // status=running fires from dispatch BEFORE codex is spawned, so the
    // cancel closure may not yet be registered. Wait for the codex side to
    // emit turn_started, which the orchestrator wraps as
    // codex_turn_started — by then onTurnActive has been called.
    await waitForEvent(
      daemon.url,
      running.runId,
      (e) => e.type === "codex_turn_started",
      { timeoutMs: 15_000 },
    );

    const resp = await fetch(`${daemon.url}/api/runs/${running.runId}/stop`, {
      method: "POST",
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // After turn/interrupt + turn/completed(interrupted), the runner returns
    // status=cancelled. dispatch's catch branch classifies that as
    // non-retryable failed (code: runner_cancelled), so the run lands at
    // status=failed with the failed label set.
    await ws.gitlabServer.waitFor(
      (s) => {
        const issue = s.issues.get(ISSUE_IID);
        return !!issue && issue.labels.includes("ai-failed");
      },
      { timeoutMs: 15_000, intervalMs: 50 },
    );

    const finalRun = (await fetchRuns(daemon.url)).find(
      (r) => r.runId === running.runId,
    );
    expect(finalRun).toBeDefined();
    expect(finalRun?.status).toBe("failed");

    // The runner saw turn/completed with status=interrupted and emitted
    // codex_turn_completed; operator_action_succeeded was emitted by the
    // orchestrator side as well.
    const eventsRes = await fetch(
      `${daemon.url}/api/events?runId=${encodeURIComponent(running.runId)}&limit=500`,
    );
    expect(eventsRes.ok).toBe(true);
    const events = (await eventsRes.json()) as Array<{
      type: string;
      data?: { action?: string; turn?: { status?: string } };
    }>;
    const stopEvents = events.filter(
      (e) =>
        (e.type === "operator_action_requested" ||
          e.type === "operator_action_succeeded") &&
        e.data?.action === "stop",
    );
    expect(stopEvents.length).toBeGreaterThanOrEqual(2);
    const interrupted = events.find(
      (e) =>
        e.type === "codex_turn_completed" &&
        e.data?.turn?.status === "interrupted",
    );
    expect(interrupted).toBeDefined();
  }, 30_000);

  it("stop-timeout: unresponsive codex → POST /stop returns 409 cancel_failed and run goes stopping → failed", async () => {
    const ISSUE_IID = 33;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.stop-ignore-interrupt.json",
      // Short enough that the test finishes before the default 30s vitest
      // timeout but long enough to let us observe the intermediate
      // `stopping` state after the cancel times out at 500ms.
      turnTimeoutMs: 8_000,
      issues: [
        {
          iid: ISSUE_IID,
          title: "Operator stop timeout scenario",
          description:
            "Codex stays mid-turn and ignores turn/interrupt; cancel times out.",
          labels: ["ai-ready"],
        },
      ],
    });
    const port = await pickFreePort();
    daemon = await startDaemon(
      { workflowPath: ws.workflowPath, port },
      { startLoop: withFastPoll },
    );

    const running = await waitForRunStatus(
      daemon.url,
      (r) => r.status === "running",
      { timeoutMs: 15_000 },
    );

    // Ensure the cancel closure is registered before stopping (see
    // stop-interrupt scenario for the rationale).
    await waitForEvent(
      daemon.url,
      running.runId,
      (e) => e.type === "codex_turn_started",
      { timeoutMs: 15_000 },
    );

    const resp = await fetch(
      `${daemon.url}/api/runs/${running.runId}/stop?cancelTimeoutMs=500`,
      { method: "POST" },
    );
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as {
      ok: boolean;
      code: string;
      reason: string;
    };
    expect(body).toMatchObject({
      ok: false,
      code: "cancel_failed",
      reason: "cancel_timeout",
    });

    // After cancel_timeout the run is parked in `stopping` while
    // turnTimeoutMs (8s) takes over.
    const stopping = await waitForRunStatus(
      daemon.url,
      (r) => r.runId === running.runId && r.status === "stopping",
      { timeoutMs: 5_000 },
    );
    expect(stopping.status).toBe("stopping");

    // Eventually the turn times out and dispatch funnels the run to failed.
    await ws.gitlabServer.waitFor(
      (s) => {
        const issue = s.issues.get(ISSUE_IID);
        return !!issue && issue.labels.includes("ai-failed");
      },
      { timeoutMs: 20_000, intervalMs: 100 },
    );
    const finalRun = (await fetchRuns(daemon.url)).find(
      (r) => r.runId === running.runId,
    );
    expect(finalRun?.status).toBe("failed");
  }, 45_000);
});
