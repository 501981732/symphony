import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import type { RawIssueNoteRow } from "./fakes/gitlab/data.js";

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
  latestReviewFeedback?: {
    cursor: string;
    comments: Array<{ noteId: number; author: string; body: string }>;
  };
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
      // ignore transient fetch errors
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

interface SeedReviewerNoteInput {
  body: string;
  author: string;
  system?: boolean;
  createdAt?: string;
}

/**
 * Push a reviewer note onto the fake GitLab MR notes store. We bypass
 * the HTTP layer because gitbeaker has no convenient "create MR note"
 * surface in our adapter — the sweep only reads notes, so direct state
 * mutation is the cleanest seam.
 */
function seedReviewerNote(
  ws: E2EWorkspace,
  mrIid: number,
  input: SeedReviewerNoteInput,
): RawIssueNoteRow {
  const list = ws.gitlabState.mergeRequestNotes.get(mrIid) ?? [];
  const id = ws.gitlabState.nextId();
  const now = input.createdAt ?? new Date().toISOString();
  const row: RawIssueNoteRow = {
    id,
    body: input.body,
    system: input.system === true,
    author: { username: input.author, name: input.author },
    created_at: now,
    updated_at: now,
  };
  list.push(row);
  ws.gitlabState.mergeRequestNotes.set(mrIid, list);
  return row;
}

/**
 * Scan the fake-codex debug log for every `turn/start` request the
 * runner sent across the daemon lifetime. Each entry carries the
 * `params.input[0].text` payload, which is exactly the prompt the
 * agent saw.
 */
function readCodexTurnStartPrompts(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, "utf8");
  const prompts: string[] = [];
  for (const line of raw.split("\n")) {
    const arrow = line.indexOf("<- ");
    if (arrow === -1) continue;
    const jsonPart = line.slice(arrow + 3).trim();
    if (!jsonPart.startsWith("{")) continue;
    try {
      const msg = JSON.parse(jsonPart) as {
        method?: string;
        params?: {
          input?: Array<{ type?: string; text?: string }>;
        };
      };
      if (msg.method !== "turn/start") continue;
      const text = msg.params?.input?.[0]?.text;
      if (typeof text === "string") prompts.push(text);
    } catch {
      // skip malformed lines
    }
  }
  return prompts;
}

async function waitForTurnStartPromptCount(
  logPath: string,
  count: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string[]> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  const interval = opts.intervalMs ?? 100;
  let last: string[] = [];
  while (Date.now() < deadline) {
    last = readCodexTurnStartPrompts(logPath);
    if (last.length >= count) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `waitForTurnStartPromptCount: expected >= ${count} prompts, got ${last.length}`,
  );
}

describe("review feedback sweep E2E", () => {
  let ws: E2EWorkspace | undefined;
  let daemon: DaemonHandle | undefined;
  let originalToken: string | undefined;
  let originalDebugLog: string | undefined;
  let debugLogPath: string | undefined;

  beforeEach(() => {
    originalToken = process.env["GITLAB_TOKEN"];
    process.env["GITLAB_TOKEN"] = E2E_TOKEN;
    originalDebugLog = process.env["IPILOT_FAKE_DEBUG_LOG"];
    const dbgDir = mkdtempSync(join(tmpdir(), "issuepilot-codex-dbg-"));
    debugLogPath = join(dbgDir, "codex.log");
    process.env["IPILOT_FAKE_DEBUG_LOG"] = debugLogPath;
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
    if (originalDebugLog === undefined) {
      delete process.env["IPILOT_FAKE_DEBUG_LOG"];
    } else {
      process.env["IPILOT_FAKE_DEBUG_LOG"] = originalDebugLog;
    }
  });

  it(
    "captures reviewer comments, advances the cursor, and injects them into the ai-rework prompt",
    async () => {
      const ISSUE_IID = 91;
      ws = await createE2EWorkspace({
        codexScriptFixture: "codex.happy.json",
        activeLabels: ["ai-ready", "ai-rework"],
        issues: [
          {
            iid: ISSUE_IID,
            title: "Review feedback loop",
            description:
              "Verify that human review comments come back to the agent on the next cycle.",
            labels: ["ai-ready"],
          },
        ],
      });

      const port = await pickFreePort();
      daemon = await startDaemon(
        { workflowPath: ws.workflowPath, port },
        { startLoop: withFastPoll },
      );

      // 1. First cycle: run goes ai-ready → ai-running → completed, label
      //    parked at human-review.
      await ws.gitlabServer.waitFor(
        (s) => {
          const issue = s.issues.get(ISSUE_IID);
          return !!issue && issue.labels.includes("human-review");
        },
        { timeoutMs: 20_000, intervalMs: 50 },
      );
      const firstRun = await waitForRun(
        daemon.url,
        (r) => r.status === "completed",
      );
      expect(firstRun.branch).toMatch(/^ai\//);

      const mr = ws.gitlabState.mergeRequests.get(firstRun.branch);
      expect(mr, "expected dispatch to open an MR for the AI branch").toBeDefined();
      const mrIid = mr!.iid;

      // 2. Reviewer posts the first comment. Sweep should pick it up,
      //    set `latestReviewFeedback`, and advance the cursor to its
      //    `created_at`. The marker-prefix filter must NOT match
      //    because this body is plain-text reviewer feedback.
      const firstNoteAt = new Date(Date.now() - 1000).toISOString();
      seedReviewerNote(ws, mrIid, {
        author: "alice",
        body: "Please add error handling around the empty branch path.",
        createdAt: firstNoteAt,
      });

      const firstSummary = await waitForEvent(
        daemon.url,
        firstRun.runId,
        (e) => {
          if (e.type !== "review_feedback_summary_generated") return false;
          const d = (e.data ?? {}) as { commentCount?: number };
          return d.commentCount === 1;
        },
        { timeoutMs: 30_000 },
      );
      const firstSummaryData = (firstSummary.data ?? {}) as {
        cursor: string;
        comments: Array<{ author: string; body: string }>;
        mrIid: number;
      };
      expect(firstSummaryData.cursor).toBe(firstNoteAt);
      expect(firstSummaryData.mrIid).toBe(mrIid);
      expect(firstSummaryData.comments[0]?.author).toBe("alice");
      expect(firstSummaryData.comments[0]?.body).toContain(
        "Please add error handling",
      );

      // Sanity check the API surface too — the dashboard reads from
      // /api/runs, so a regression in the run-record persistence would
      // hide the carry-forward path even if events look right.
      const runsAfterFirstSweep = await fetchRuns(daemon.url);
      const recordedFirst = runsAfterFirstSweep.find(
        (r) => r.runId === firstRun.runId,
      );
      expect(recordedFirst?.latestReviewFeedback?.cursor).toBe(firstNoteAt);
      expect(recordedFirst?.latestReviewFeedback?.comments).toHaveLength(1);

      // 3. Reviewer posts a second comment. The next sweep tick must
      //    only emit the newer note (cursor advances; old comment is
      //    not re-injected) but the persisted summary should still
      //    reflect the most recent sweep.
      const secondNoteAt = new Date(Date.now() + 50).toISOString();
      seedReviewerNote(ws, mrIid, {
        author: "bob",
        body: "Also add a unit test for the timeout branch please.",
        createdAt: secondNoteAt,
      });

      await waitForEvent(
        daemon.url,
        firstRun.runId,
        (e) => {
          if (e.type !== "review_feedback_summary_generated") return false;
          const d = (e.data ?? {}) as {
            commentCount?: number;
            cursor?: string;
          };
          return d.commentCount === 1 && d.cursor === secondNoteAt;
        },
        { timeoutMs: 30_000 },
      );

      // 4. Human transitions the issue from human-review → ai-rework.
      //    The orchestrator must claim a fresh run (new runId), carry
      //    forward `latestReviewFeedback`, and dispatch a second codex
      //    turn whose prompt includes the review block.
      const issueRow = ws.gitlabState.issues.get(ISSUE_IID);
      expect(issueRow, "issue row must exist").toBeDefined();
      issueRow!.labels = issueRow!.labels.filter((l) => l !== "human-review");
      issueRow!.labels.push("ai-rework");
      issueRow!.updated_at = new Date().toISOString();

      const reworkRun = await waitForRun(
        daemon.url,
        (r) => r.runId !== firstRun.runId && r.status !== "completed",
        { timeoutMs: 30_000 },
      );
      expect(reworkRun.runId).not.toBe(firstRun.runId);

      // 5. Wait until the daemon has spawned the second fake-codex
      //    process and we've recorded both `turn/start` payloads. The
      //    second prompt must carry the standardised review block.
      const prompts = await waitForTurnStartPromptCount(debugLogPath!, 2, {
        timeoutMs: 30_000,
      });
      const reworkPrompt = prompts[1]!;
      expect(reworkPrompt).toContain("## Review feedback");
      expect(reworkPrompt).toContain("Please add error handling");
      // Only the newest cursor-advancing sweep was persisted, so the
      // older comment text from alice is *not* required — what the
      // agent must see is whatever the most recent sweep recorded,
      // which is bob's comment.
      expect(reworkPrompt).toContain(
        "Also add a unit test for the timeout branch please.",
      );

      // The first prompt (initial ai-ready dispatch) must NOT contain
      // the review block — otherwise we'd be leaking stale feedback
      // into brand-new issues that have never been reviewed.
      expect(prompts[0]).not.toContain("## Review feedback");
    },
    90_000,
  );

  it("emits review_feedback_summary_generated with no_mr when no MR has been opened", async () => {
    const ISSUE_IID = 92;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.happy.json",
      activeLabels: ["ai-ready"],
      issues: [
        {
          iid: ISSUE_IID,
          title: "Review feedback no MR path",
          description: "Sweep must stay quiet when no MR exists for the branch.",
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

    // Delete the MR so the sweep falls through the "no MR" branch.
    for (const [key, mr] of ws.gitlabState.mergeRequests) {
      if (mr.source_branch === handoffRun.branch) {
        ws.gitlabState.mergeRequests.delete(key);
        ws.gitlabState.mergeRequestNotes.delete(mr.iid);
      }
    }

    const evt = await waitForEvent(
      daemon.url,
      handoffRun.runId,
      (e) => {
        if (e.type !== "review_feedback_summary_generated") return false;
        const d = (e.data ?? {}) as { reason?: string };
        return d.reason === "no_mr";
      },
      { timeoutMs: 30_000 },
    );
    const data = (evt.data ?? {}) as { comments?: unknown[]; cursor?: unknown };
    expect(data.comments).toEqual([]);
    expect(data.cursor === null || data.cursor === undefined).toBe(true);
  }, 60_000);
});
