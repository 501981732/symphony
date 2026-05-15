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

import type {
  RawMergeRequestRow,
  RawPipelineRow,
} from "./fakes/gitlab/data.js";

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
  branch: string;
  attempt: number;
  latestCiStatus?: string;
}

async function fetchRuns(daemonUrl: string): Promise<RunSnapshot[]> {
  const res = await fetch(`${daemonUrl}/api/runs`);
  if (!res.ok) {
    throw new Error(`GET /api/runs failed: HTTP ${res.status}`);
  }
  return (await res.json()) as RunSnapshot[];
}

async function waitForRun(
  daemonUrl: string,
  predicate: (run: RunSnapshot) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<RunSnapshot> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  const interval = opts.intervalMs ?? 100;
  let lastSeen: RunSnapshot[] = [];
  while (Date.now() < deadline) {
    try {
      lastSeen = await fetchRuns(daemonUrl);
      const match = lastSeen.find(predicate);
      if (match) return match;
    } catch {
      // ignore transient fetch errors while the daemon boots
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `waitForRun timed out; last seen: ${JSON.stringify(lastSeen)}`,
  );
}

async function waitForEvent(
  daemonUrl: string,
  runId: string,
  predicate: (event: { type: string; data?: unknown }) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ type: string; data?: unknown }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  const interval = opts.intervalMs ?? 100;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${daemonUrl}/api/events?runId=${encodeURIComponent(runId)}&limit=500`,
      );
      if (res.ok) {
        const events = (await res.json()) as Array<{
          type: string;
          data?: unknown;
        }>;
        const match = events.find(predicate);
        if (match) return match;
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

function seedPipeline(
  ws: E2EWorkspace,
  branch: string,
  status: RawPipelineRow["status"],
): void {
  const now = new Date().toISOString();
  ws.gitlabState.pipelines.push({
    id: ws.gitlabState.nextId(),
    project_id: ws.gitlabState.projectNumericId,
    ref: branch,
    sha: "deadbeef",
    status,
    created_at: now,
    updated_at: now,
  });
}

function ensureOpenMr(ws: E2EWorkspace, branch: string): RawMergeRequestRow {
  const existing = ws.gitlabState.mergeRequests.get(branch);
  if (existing) return existing;
  const now = new Date().toISOString();
  const iid = ws.gitlabState.nextId();
  const mr: RawMergeRequestRow = {
    id: ws.gitlabState.nextId(),
    iid,
    project_id: ws.gitlabState.projectNumericId,
    title: "CI feedback test",
    description: "",
    source_branch: branch,
    target_branch: "main",
    state: "opened",
    web_url: `${ws.gitlabState.origin}/${ws.gitlabState.projectId}/-/merge_requests/${iid}`,
    created_at: now,
    updated_at: now,
  };
  ws.gitlabState.mergeRequests.set(branch, mr);
  ws.gitlabState.mergeRequestNotes.set(mr.iid, []);
  return mr;
}

describe("ci feedback E2E", () => {
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

  it("success pipeline keeps labels and records latestCiStatus=success", async () => {
    const ISSUE_IID = 81;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.happy.json",
      ciEnabled: true,
      issues: [
        {
          iid: ISSUE_IID,
          title: "CI success",
          description: "Issue should stay parked at human-review.",
          labels: ["ai-ready"],
        },
      ],
    });
    const port = await pickFreePort();
    daemon = await startDaemon(
      { workflowPath: ws.workflowPath, port },
      { startLoop: withFastPoll },
    );

    // Wait until the issue is parked at `human-review` so we know the run
    // record has a stable branch we can pipeline-seed against.
    await ws.gitlabServer.waitFor(
      (s) => {
        const issue = s.issues.get(ISSUE_IID);
        return !!issue && issue.labels.includes("human-review");
      },
      { timeoutMs: 20_000, intervalMs: 50 },
    );
    const handoffRun = await waitForRun(
      daemon.url,
      (r) => r.status === "completed",
    );

    ensureOpenMr(ws, handoffRun.branch);
    seedPipeline(ws, handoffRun.branch, "success");

    await waitForEvent(daemon.url, handoffRun.runId, (e) => {
      const data = (e.data ?? {}) as { status?: string; action?: string };
      return e.type === "ci_status_observed" && data.status === "success";
    });

    const issue = ws.gitlabState.issues.get(ISSUE_IID);
    expect(issue?.labels).toContain("human-review");
    expect(issue?.labels).not.toContain("ai-rework");

    const refreshed = (await fetchRuns(daemon.url)).find(
      (r) => r.runId === handoffRun.runId,
    );
    expect(refreshed?.latestCiStatus).toBe("success");
  }, 35_000);

  it("failed pipeline transitions to ai-rework and writes a marker note", async () => {
    const ISSUE_IID = 82;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.happy.json",
      ciEnabled: true,
      issues: [
        {
          iid: ISSUE_IID,
          title: "CI failed → ai-rework",
          description: "Pipeline failure should recycle the issue.",
          labels: ["ai-ready"],
        },
      ],
    });
    const port = await pickFreePort();
    daemon = await startDaemon(
      { workflowPath: ws.workflowPath, port },
      { startLoop: withFastPoll },
    );

    await ws.gitlabServer.waitFor(
      (s) => {
        const issue = s.issues.get(ISSUE_IID);
        return !!issue && issue.labels.includes("human-review");
      },
      { timeoutMs: 20_000, intervalMs: 50 },
    );
    const handoffRun = await waitForRun(
      daemon.url,
      (r) => r.status === "completed",
    );

    ensureOpenMr(ws, handoffRun.branch);
    seedPipeline(ws, handoffRun.branch, "failed");

    await ws.gitlabServer.waitFor(
      (s) => {
        const issue = s.issues.get(ISSUE_IID);
        return !!issue && issue.labels.includes("ai-rework");
      },
      { timeoutMs: 20_000, intervalMs: 50 },
    );

    const issue = ws.gitlabState.issues.get(ISSUE_IID);
    expect(issue?.labels).toContain("ai-rework");
    expect(issue?.labels).not.toContain("human-review");

    const notes = ws.gitlabState.notes.get(ISSUE_IID) ?? [];
    const ciFeedbackNote = notes.find((n) =>
      n.body.includes(`<!-- issuepilot:ci-feedback:${handoffRun.runId} -->`),
    );
    expect(ciFeedbackNote, "expected a ci-feedback marker note").toBeDefined();
    expect(ciFeedbackNote?.body).toContain("failing CI pipeline");

    await waitForEvent(
      daemon.url,
      handoffRun.runId,
      (e) => e.type === "ci_status_rework_triggered",
    );
  }, 35_000);

  it("pipeline lookup failure emits ci_status_lookup_failed and keeps labels", async () => {
    const ISSUE_IID = 83;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.happy.json",
      ciEnabled: true,
      issues: [
        {
          iid: ISSUE_IID,
          title: "CI lookup down",
          description: "Pipeline endpoint 500s; labels must stay put.",
          labels: ["ai-ready"],
        },
      ],
    });
    const port = await pickFreePort();
    daemon = await startDaemon(
      { workflowPath: ws.workflowPath, port },
      { startLoop: withFastPoll },
    );

    await ws.gitlabServer.waitFor(
      (s) => {
        const issue = s.issues.get(ISSUE_IID);
        return !!issue && issue.labels.includes("human-review");
      },
      { timeoutMs: 20_000, intervalMs: 50 },
    );
    const handoffRun = await waitForRun(
      daemon.url,
      (r) => r.status === "completed",
    );

    ensureOpenMr(ws, handoffRun.branch);

    // Inject 500 faults on `/pipelines` only. The scanner first calls
    // findMergeRequestBySourceBranch (different prefix) and then
    // getPipelineStatus — only the second throws, which is exactly the
    // path that maps to `ci_status_lookup_failed`. `consume: 50` lets the
    // fault survive multiple poll cycles, since the loop runs at 250ms.
    ws.gitlabServer.injectFault({
      pathPrefix: `/api/v4/projects/${encodeURIComponent(ws.projectId)}/pipelines`,
      method: "GET",
      status: 500,
      body: { message: "pipelines unavailable" },
      consume: 50,
    });

    // Tickle the loop a few times: faults only fire when the scanner
    // reaches getPipelineStatus, and findMergeRequestBySourceBranch
    // shares the same path prefix so the fault could intercept that too.
    // Either way we expect a `ci_status_lookup_failed` audit event.
    await waitForEvent(
      daemon.url,
      handoffRun.runId,
      (e) => e.type === "ci_status_lookup_failed",
      { timeoutMs: 20_000 },
    );

    const issue = ws.gitlabState.issues.get(ISSUE_IID);
    expect(issue?.labels).toContain("human-review");
    expect(issue?.labels).not.toContain("ai-rework");
  }, 35_000);
});
