import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  startDaemon,
  startLoop as realStartLoop,
  type LoopDeps,
  type LoopHandle,
} from "@issuepilot/orchestrator";

type DaemonHandle = Awaited<ReturnType<typeof startDaemon>>;

import { listBranches } from "./fakes/git/repo.js";
import { pickFreePort } from "./helpers/net.js";
import {
  createE2EWorkspace,
  E2E_TOKEN,
  type E2EWorkspace,
} from "./helpers/workspace.js";

const ISSUE_IID = 7;
const FAST_POLL_MS = 250;

function withFastPoll(deps: LoopDeps): LoopHandle {
  return realStartLoop({
    ...deps,
    pollIntervalMs: FAST_POLL_MS,
    loadConfig: () => ({ pollIntervalMs: FAST_POLL_MS }),
  });
}

describe("happy path E2E", () => {
  let ws: E2EWorkspace | undefined;
  let daemon: DaemonHandle | undefined;
  let originalToken: string | undefined;

  beforeEach(async () => {
    originalToken = process.env["GITLAB_TOKEN"];
    process.env["GITLAB_TOKEN"] = E2E_TOKEN;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.happy.json",
      issues: [
        {
          iid: ISSUE_IID,
          title: "Add AI changelog entry",
          description: "Please record the new feature in CHANGELOG.",
          labels: ["ai-ready"],
        },
      ],
    });
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

  it("claims an ai-ready issue, hands off, then closes after the MR is merged", async () => {
    if (!ws) throw new Error("workspace not initialised");

    const startedAt = performance.now();

    // Use a free OS-assigned port instead of a random number from a fixed
    // band. The daemon reports `host:port` verbatim in `url`, so we can't
    // pass `port: 0` and read the bound port back.
    const port = await pickFreePort();
    daemon = await startDaemon(
      { workflowPath: ws.workflowPath, port },
      { startLoop: withFastPoll },
    );

    // Step 1-4: orchestrator picks up the issue and drives codex to completion.
    //           We wait until the GitLab handoff label appears, which the
    //           orchestrator only sets after reconcile finishes.
    await ws.gitlabServer.waitFor(
      (s) => {
        const issue = s.issues.get(ISSUE_IID);
        return !!issue && issue.labels.includes("human-review");
      },
      { timeoutMs: 20_000, intervalMs: 50 },
    );

    const issue = ws.gitlabState.issues.get(ISSUE_IID);
    if (!issue) throw new Error("issue gone after waitFor");

    // Step 5: labels — running was removed, handoff was added.
    expect(issue.labels).toContain("human-review");
    expect(issue.labels).not.toContain("ai-running");

    // Step 5: branch was pushed back to the fake "origin" bare repo.
    const branches = await listBranches(ws.bareRepo.bareDir);
    const aiBranches = branches.filter((b) => b.startsWith("ai/"));
    expect(aiBranches.length).toBeGreaterThanOrEqual(1);

    // Step 5: an open MR exists with our branch as source.
    expect(ws.gitlabState.mergeRequests.size).toBeGreaterThanOrEqual(1);
    const mr = ws.gitlabState.mergeRequests.get(aiBranches[0]!);
    expect(mr).toBeDefined();
    expect(mr?.target_branch).toBe("main");
    expect(mr?.state).toBe("opened");

    // Step 5: at least one workpad / progress note was written on the issue.
    const notes = ws.gitlabState.notes.get(ISSUE_IID) ?? [];
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes.some((n) => n.body.includes("IssuePilot"))).toBe(true);

    // Step 6: orchestrator HTTP API exposes the run record as completed-ish
    //         (status is "running" until reconcile flips to "completed" at the
    //         end of dispatch — we accept either as long as the run exists).
    const runsRes = await fetch(`${daemon.url}/api/runs`);
    expect(runsRes.ok).toBe(true);
    const runs = (await runsRes.json()) as Array<{
      runId: string;
      status: string;
    }>;
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const firstRun = runs[0];
    if (!firstRun) throw new Error("expected at least one run");
    // Wait for the run to flip to `completed` — the dispatch path always
    // ends with `state.setRun(..., status: "completed")` after reconcile,
    // so anything other than that means the lifecycle stalled. Avoid the
    // overly broad accept-list which used to mask real regressions.
    await waitForCompletedRun(daemon.url, firstRun.runId);

    // Step 6: a human merges the MR in GitLab. The next daemon poll should
    // reconcile the `human-review` issue, remove the handoff label, and close
    // the GitLab issue.
    if (!mr) throw new Error("expected MR before merge mutation");
    mr.state = "merged";
    mr.updated_at = new Date().toISOString();

    await ws.gitlabServer.waitFor(
      (s) => {
        const latest = s.issues.get(ISSUE_IID);
        return latest?.state === "closed";
      },
      { timeoutMs: 10_000, intervalMs: 50 },
    );

    expect(issue.state).toBe("closed");
    expect(issue.labels).not.toContain("human-review");
    expect(issue.labels).not.toContain("ai-running");
    const closingNote = (ws.gitlabState.notes.get(ISSUE_IID) ?? []).find((n) =>
      n.body.includes("## IssuePilot closed this issue"),
    );
    expect(closingNote).toBeDefined();
    expect(closingNote?.body).toContain("- Status: closed");
    expect(closingNote?.body).toContain(
      "The linked MR was merged by a human reviewer",
    );

    // Step 7: event store contains the spec §10 happy-path event types.
    const stateRes = await fetch(`${daemon.url}/api/state`);
    expect(stateRes.ok).toBe(true);
    const stateBody = (await stateRes.json()) as {
      service: { status: string };
      summary: Record<string, number>;
    };
    expect(stateBody.service.status === "ready").toBe(true);
    expect(stateBody.summary["human-review"]).toBe(0);

    const eventsRes = await fetch(
      `${daemon.url}/api/events?runId=${encodeURIComponent(firstRun.runId)}&limit=200`,
    );
    expect(eventsRes.ok).toBe(true);
    const eventsBody = (await eventsRes.json()) as Array<{ type: string }>;
    const eventTypes = new Set(eventsBody.map((e) => e.type));
    expect(eventTypes.has("codex_session_started")).toBe(true);
    expect(eventTypes.has("codex_turn_started")).toBe(true);
    expect(eventTypes.has("codex_turn_completed")).toBe(true);
    expect(
      eventTypes.has("codex_tool_call_started") ||
        eventTypes.has("codex_tool_call_completed"),
    ).toBe(true);

    // plan §Phase 8 验收清单：happy path 在本机 ≤ 30s。我们让 vitest
    // 的 testTimeout 留 30s，然后这里再补一道软上限断言，便于在 CI
    // 上回放性能回归 — 一旦超过 25s 立刻定位 root cause（poll 间隔
    // 加长？多打了一次 fetch？hook 慢了？）。
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeLessThan(25_000);
  }, 30_000);
});

async function waitForCompletedRun(
  daemonUrl: string,
  runId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${daemonUrl}/api/runs`);
    if (res.ok) {
      const list = (await res.json()) as Array<{
        runId: string;
        status: string;
      }>;
      const found = list.find((r) => r.runId === runId);
      if (found?.status === "completed") return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitForCompletedRun: run ${runId} did not reach completed`);
}
