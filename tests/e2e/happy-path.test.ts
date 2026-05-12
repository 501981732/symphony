import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  startDaemon,
  startLoop as realStartLoop,
  type LoopDeps,
  type LoopHandle,
} from "@issuepilot/orchestrator";

type DaemonHandle = Awaited<ReturnType<typeof startDaemon>>;

import { listBranches } from "./fakes/git/repo.js";
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

  it("claims an ai-ready issue, runs codex, pushes a branch, opens an MR, writes a note and hands off", async () => {
    if (!ws) throw new Error("workspace not initialised");

    // Pick a deterministic high port for each run to avoid clashing with the
    // daemon's default 4738; can't rely on `port: 0` because the daemon
    // reports the requested port verbatim in its `url`.
    const port = 17_000 + Math.floor(Math.random() * 1_000);
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
    expect(
      ["completed", "running", "human-review"].includes(firstRun.status),
    ).toBe(true);

    // Step 7: event store contains the spec §10 happy-path event types.
    const stateRes = await fetch(`${daemon.url}/api/state`);
    expect(stateRes.ok).toBe(true);
    const stateBody = (await stateRes.json()) as {
      service: { status: string };
    };
    expect(stateBody.service.status === "ready").toBe(true);

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
  }, 60_000);
});
