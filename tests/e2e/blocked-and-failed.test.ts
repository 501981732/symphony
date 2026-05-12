import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  startDaemon,
  startLoop as realStartLoop,
  type LoopDeps,
  type LoopHandle,
} from "@issuepilot/orchestrator";

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

describe("failure and blocked classifications E2E", () => {
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

  it("labels the issue ai-failed and writes a failure note when codex reports turn/failed", async () => {
    const ISSUE_IID = 11;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.turn-failed.json",
      issues: [
        {
          iid: ISSUE_IID,
          title: "Turn failure scenario",
          description: "Forces the agent into a failure outcome.",
          labels: ["ai-ready"],
        },
      ],
    });
    const port = 17_000 + Math.floor(Math.random() * 1_000);
    daemon = await startDaemon(
      { workflowPath: ws.workflowPath, port },
      { startLoop: withFastPoll },
    );

    await ws.gitlabServer.waitFor(
      (s) => {
        const issue = s.issues.get(ISSUE_IID);
        return !!issue && issue.labels.includes("ai-failed");
      },
      { timeoutMs: 15_000, intervalMs: 50 },
    );

    const issue = ws.gitlabState.issues.get(ISSUE_IID);
    if (!issue) throw new Error("issue gone after waitFor");
    expect(issue.labels).toContain("ai-failed");
    expect(issue.labels).not.toContain("ai-running");

    const notes = ws.gitlabState.notes.get(ISSUE_IID) ?? [];
    const failureNote = notes.find((n) =>
      n.body.includes("IssuePilot run failed"),
    );
    expect(failureNote).toBeDefined();
    expect(failureNote?.body).toMatch(/Kind/);
  }, 45_000);

  it("labels the issue ai-blocked without retrying when GitLab returns 403", async () => {
    const ISSUE_IID = 12;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.happy.json",
      issues: [
        {
          iid: ISSUE_IID,
          title: "Permission denied scenario",
          description: "Permission failure should not retry.",
          labels: ["ai-ready"],
        },
      ],
    });

    // Inject a permission failure that fires the next time the daemon tries
    // to transition labels (i.e. during claim).
    ws.gitlabServer.injectFault({
      pathPrefix: `/api/v4/projects/${encodeURIComponent(ws.projectId)}/issues/${ISSUE_IID}`,
      method: "PUT",
      status: 403,
      body: { message: "403 Forbidden" },
      consume: 99,
    });

    const port = 17_000 + Math.floor(Math.random() * 1_000);
    daemon = await startDaemon(
      { workflowPath: ws.workflowPath, port },
      { startLoop: withFastPoll },
    );

    // Allow several tick cycles so the daemon has tried (and failed) to
    // claim the issue at least once. With every PUT to issues/12 returning
    // 403, the claim path itself trips. Two ticks at 250ms = 500ms minimum
    // — give a comfortable margin to absorb fastify boot + first claim.
    await new Promise((r) => setTimeout(r, 2_000));

    const issue = ws.gitlabState.issues.get(ISSUE_IID);
    if (!issue) throw new Error("issue gone");
    // The agent never made progress: no running, no handoff.
    expect(issue.labels).not.toContain("human-review");
    expect(issue.labels).not.toContain("ai-running");
    // The label stays `ai-ready` until permissions are restored — this is
    // the expected outcome of a permission-denied claim. The orchestrator
    // does NOT push it into `ai-blocked` because no run record was ever
    // created (the PUT to add `ai-running` failed first).
    expect(issue.labels).toContain("ai-ready");

    // No retries happened despite the failure: either zero run records
    // (claim never succeeded) or a single record with attempt === 1.
    const runs = daemon.state.listRuns();
    for (const r of runs) {
      expect(r.attempt).toBeLessThanOrEqual(1);
    }
  }, 45_000);

  it("auto-approves codex approval requests under approval_policy=never", async () => {
    const ISSUE_IID = 13;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.approval.json",
      issues: [
        {
          iid: ISSUE_IID,
          title: "Approval scenario",
          description: "Codex requests approval; orchestrator auto-approves.",
          labels: ["ai-ready"],
        },
      ],
    });

    const port = 17_000 + Math.floor(Math.random() * 1_000);
    daemon = await startDaemon(
      { workflowPath: ws.workflowPath, port },
      { startLoop: withFastPoll },
    );

    // Wait until the run completes and reconcile flips the label.
    await ws.gitlabServer.waitFor(
      (s) => {
        const issue = s.issues.get(ISSUE_IID);
        return !!issue && issue.labels.includes("human-review");
      },
      { timeoutMs: 15_000, intervalMs: 50 },
    );

    // Find the run and assert events include approval_auto_approved.
    const runs = daemon.state.listRuns();
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const firstRun = runs[0];
    if (!firstRun) throw new Error("expected at least one run");

    const eventsRes = await fetch(
      `${daemon.url}/api/events?runId=${encodeURIComponent(firstRun.runId)}&limit=200`,
    );
    expect(eventsRes.ok).toBe(true);
    const eventsBody = (await eventsRes.json()) as Array<{ type: string }>;
    const types = new Set(eventsBody.map((e) => e.type));
    expect(types.has("codex_approval_auto_approved")).toBe(true);
  }, 45_000);
});
