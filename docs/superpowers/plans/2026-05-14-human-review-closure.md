# Human Review Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close a GitLab issue automatically after its IssuePilot-created MR is manually merged from `human-review`.

**Architecture:** Add small GitLab adapter primitives for source-branch MR lookup, latest IssuePilot workpad discovery, and issue close-with-label-update. Build a pure orchestrator `reconcileHumanReview` unit that consumes those primitives, then wire it into the daemon poll loop before candidate claim so closure never consumes an agent slot.

**Tech Stack:** TypeScript, Node.js 22, pnpm workspace, Vitest, Fastify fake GitLab server, existing IssuePilot orchestrator/tracker packages.

---

## Source Spec

- `docs/superpowers/specs/2026-05-14-human-review-closure-design.md`
- `docs/superpowers/specs/2026-05-11-issuepilot-design.md`

## File Structure

- Modify `packages/tracker-gitlab/src/api-shape.ts`
  - Add issue `state`, MR `updated_at`, and `Issues.edit` close options to the narrow GitLab SDK shape.
- Modify `packages/tracker-gitlab/src/issues.ts`
  - Preserve issue state in adapter projections and add `closeIssue`.
- Modify `packages/tracker-gitlab/src/merge-requests.ts`
  - Add `listMergeRequestsBySourceBranch` returning source branch, state, web URL, and updated time.
- Modify `packages/tracker-gitlab/src/notes.ts`
  - Add `findLatestIssuePilotWorkpadNote` for branch/runId discovery when the marker run id is not known up front.
- Modify `packages/tracker-gitlab/src/types.ts`
  - Expose the new adapter methods.
- Modify `packages/tracker-gitlab/src/adapter.ts`
  - Bind the new helper methods.
- Modify tracker tests:
  - `packages/tracker-gitlab/src/__tests__/issues.test.ts`
  - `packages/tracker-gitlab/src/__tests__/merge-requests.test.ts`
  - `packages/tracker-gitlab/src/__tests__/notes.test.ts`
  - `packages/tracker-gitlab/src/__tests__/adapter.test.ts`
- Create `apps/orchestrator/src/orchestrator/human-review.ts`
  - Pure reconciliation unit: parse branch/runId, choose MR, close merged issues, rework closed-unmerged issues.
- Create `apps/orchestrator/src/orchestrator/__tests__/human-review.test.ts`
  - Unit coverage for all MR states and safety conditions.
- Modify `apps/orchestrator/src/orchestrator/loop.ts`
  - Keep using `reconcileRunning`, but treat it as the place where daemon-level reconciliation runs before retry/claim. No new loop dependency is needed unless the implementation proves readability suffers.
- Modify `apps/orchestrator/src/daemon.ts`
  - Wire `reconcileHumanReview` into the current `reconcileRunning` seam and publish events with issue-aware run indexing.
- Modify `apps/orchestrator/src/orchestrator/__tests__/loop.test.ts`
  - Tighten ordering assertions: reconciliation runs before retries and claim.
- Modify fake GitLab:
  - `tests/e2e/fakes/gitlab/server.ts`
  - `tests/e2e/fakes/gitlab/data.ts` if needed for seeded merged MRs.
- Modify E2E:
  - `tests/e2e/happy-path.test.ts`

## Implementation Notes

- Do not add `ai-done`.
- Do not use `ai-merging`.
- Do not auto-merge MR.
- Prefer one adapter method that closes the issue and removes `human-review` in the same GitLab issue edit call:

```ts
closeIssue(iid, {
  removeLabels: [handoffLabel],
  requireCurrent: [handoffLabel],
})
```

This avoids the bad partial state where `human-review` is removed but the issue remains open.

- Support both workpad marker forms while parsing notes:

```text
<!-- issuepilot:run:<runId> -->
<!-- issuepilot:run=<runId> -->
```

Current reconciliation writes the colon form. Older tests and docs may still contain the equals form.

---

### Task 1: Add GitLab Adapter Primitives

**Files:**
- Modify: `packages/tracker-gitlab/src/api-shape.ts`
- Modify: `packages/tracker-gitlab/src/issues.ts`
- Modify: `packages/tracker-gitlab/src/merge-requests.ts`
- Modify: `packages/tracker-gitlab/src/notes.ts`
- Modify: `packages/tracker-gitlab/src/types.ts`
- Modify: `packages/tracker-gitlab/src/adapter.ts`
- Test: `packages/tracker-gitlab/src/__tests__/issues.test.ts`
- Test: `packages/tracker-gitlab/src/__tests__/merge-requests.test.ts`
- Test: `packages/tracker-gitlab/src/__tests__/notes.test.ts`
- Test: `packages/tracker-gitlab/src/__tests__/adapter.test.ts`

- [ ] **Step 1: Write failing tests for MR lookup by source branch**

Add tests to `packages/tracker-gitlab/src/__tests__/merge-requests.test.ts`:

```ts
describe("listMergeRequestsBySourceBranch", () => {
  it("returns all MRs for a source branch with state and updated time", async () => {
    const all = vi.fn(async () => [
      mrRow({
        iid: 7,
        state: "merged",
        source_branch: "ai/42-add-x",
        web_url: "https://gitlab.example.com/g/p/-/merge_requests/7",
        updated_at: "2026-05-14T10:00:00.000Z",
      }),
    ]);
    const client = makeClient({
      MergeRequests: { all, create: vi.fn(), edit: vi.fn(), show: vi.fn() },
    });

    await expect(
      listMergeRequestsBySourceBranch(client, "ai/42-add-x"),
    ).resolves.toEqual([
      {
        iid: 7,
        webUrl: "https://gitlab.example.com/g/p/-/merge_requests/7",
        state: "merged",
        sourceBranch: "ai/42-add-x",
        updatedAt: "2026-05-14T10:00:00.000Z",
      },
    ]);
    expect(all).toHaveBeenCalledWith({
      projectId: "group/project",
      sourceBranch: "ai/42-add-x",
      perPage: 20,
    });
  });
});
```

- [ ] **Step 2: Run MR test to verify it fails**

Run:

```bash
pnpm --filter @issuepilot/tracker-gitlab test -- src/__tests__/merge-requests.test.ts
```

Expected: FAIL because `listMergeRequestsBySourceBranch` is not exported.

- [ ] **Step 3: Implement MR lookup helper**

In `packages/tracker-gitlab/src/api-shape.ts`, add fields:

```ts
export interface RawMergeRequest {
  // existing fields...
  updated_at?: string;
}
```

In `packages/tracker-gitlab/src/merge-requests.ts`, add:

```ts
export interface MergeRequestByBranch {
  iid: number;
  webUrl: string;
  state: string;
  sourceBranch: string;
  updatedAt?: string;
}

export async function listMergeRequestsBySourceBranch(
  client: GitLabClient<GitLabApi>,
  sourceBranch: string,
): Promise<MergeRequestByBranch[]> {
  return client.request("mergeRequests.all", async (api) => {
    const rows = await api.MergeRequests.all({
      projectId: client.projectId,
      sourceBranch,
      perPage: 20,
    });
    return rows.map((mr) => ({
      iid: mr.iid,
      webUrl: mr.web_url,
      state: mr.state,
      sourceBranch: mr.source_branch,
      ...(mr.updated_at ? { updatedAt: mr.updated_at } : {}),
    }));
  });
}
```

- [ ] **Step 4: Write failing tests for latest workpad note discovery**

Add tests to `packages/tracker-gitlab/src/__tests__/notes.test.ts`:

```ts
describe("findLatestIssuePilotWorkpadNote", () => {
  it("returns the latest IssuePilot workpad note", async () => {
    const all = vi.fn(async () => [
      note({ id: 1, body: "unrelated" }),
      note({
        id: 2,
        body: "<!-- issuepilot:run:run-old -->\n- Branch: `ai/1-old`",
      }),
      note({
        id: 3,
        body: "<!-- issuepilot:run=run-new -->\n- Branch: `ai/1-new`",
      }),
    ]);
    const client = makeClient({ IssueNotes: { all, create: vi.fn(), edit: vi.fn() } });

    await expect(findLatestIssuePilotWorkpadNote(client, 1)).resolves.toEqual({
      id: 3,
      body: "<!-- issuepilot:run=run-new -->\n- Branch: `ai/1-new`",
    });
  });
});
```

- [ ] **Step 5: Implement latest workpad note helper**

In `packages/tracker-gitlab/src/notes.ts`, add:

```ts
const ISSUEPILOT_WORKPAD_RE = /<!--\s*issuepilot:run[:=][^>]+-->/;

export async function findLatestIssuePilotWorkpadNote(
  client: GitLabClient<GitLabApi>,
  iid: number,
): Promise<{ id: number; body: string } | null> {
  return client.request("issueNotes.all", async (api) => {
    const rows = await api.IssueNotes.all(client.projectId, iid, {
      perPage: 100,
    });
    for (const note of [...rows].reverse()) {
      if (note.system) continue;
      if (ISSUEPILOT_WORKPAD_RE.test(note.body)) {
        return { id: note.id, body: note.body };
      }
    }
    return null;
  });
}
```

- [ ] **Step 6: Write failing tests for closeIssue**

Add tests to `packages/tracker-gitlab/src/__tests__/issues.test.ts`:

```ts
describe("closeIssue", () => {
  it("closes an issue and removes handoff labels in one edit", async () => {
    const show = vi
      .fn()
      .mockResolvedValueOnce(issue({ labels: ["human-review", "p1"], state: "opened" }))
      .mockResolvedValueOnce(issue({ labels: ["p1"], state: "closed" }));
    const edit = vi.fn(async () => issue({ labels: ["p1"], state: "closed" }));
    const client = makeClient({ Issues: { all: vi.fn(), show, edit } });

    await expect(
      closeIssue(client, 42, {
        removeLabels: ["human-review"],
        requireCurrent: ["human-review"],
      }),
    ).resolves.toEqual({ labels: ["p1"], state: "closed" });
    expect(edit).toHaveBeenCalledWith("group/project", 42, {
      labels: "p1",
      stateEvent: "close",
    });
  });
});
```

- [ ] **Step 7: Implement closeIssue**

Update `RawIssue` and `IssuesApi.edit` in `api-shape.ts`:

```ts
export interface RawIssue {
  // existing fields...
  state?: "opened" | "closed" | string;
}

edit(
  projectId: string | number,
  iid: number,
  opts: { labels?: string; stateEvent?: "close" | "reopen" },
): Promise<RawIssue>;
```

In `packages/tracker-gitlab/src/issues.ts`, preserve `state` in `getIssue` and implement:

```ts
export async function closeIssue(
  client: GitLabClient<GitLabApi>,
  iid: number,
  opts: {
    removeLabels?: readonly string[];
    requireCurrent?: readonly string[];
  } = {},
): Promise<{ labels: string[]; state: string }> {
  return client.request("issues.close", async (api) => {
    const before = await api.Issues.show(iid, { projectId: client.projectId });
    const currentLabels = [...(before.labels ?? [])];
    const missing = (opts.requireCurrent ?? []).filter(
      (label) => !currentLabels.includes(label),
    );
    if (missing.length > 0) {
      throw new Error(`issue ${iid} missing required label(s): ${missing.join(", ")}`);
    }
    if (before.state !== "opened") {
      throw new Error(`issue ${iid} is not opened`);
    }

    const remove = new Set(opts.removeLabels ?? []);
    const nextLabels = currentLabels.filter((label) => !remove.has(label));
    await api.Issues.edit(client.projectId, iid, {
      labels: nextLabels.join(","),
      stateEvent: "close",
    });

    const verified = await api.Issues.show(iid, { projectId: client.projectId });
    return {
      labels: [...(verified.labels ?? [])],
      state: verified.state ?? "unknown",
    };
  });
}
```

- [ ] **Step 8: Bind adapter surface and update adapter tests**

Update `GitLabAdapter` in `packages/tracker-gitlab/src/types.ts`:

```ts
findLatestIssuePilotWorkpadNote(
  iid: number,
): Promise<{ id: number; body: string } | null>;
listMergeRequestsBySourceBranch(sourceBranch: string): Promise<
  Array<{
    iid: number;
    webUrl: string;
    state: string;
    sourceBranch: string;
    updatedAt?: string;
  }>
>;
closeIssue(
  iid: number,
  opts?: { removeLabels?: readonly string[]; requireCurrent?: readonly string[] },
): Promise<{ labels: string[]; state: string }>;
```

Bind them in `adapter.ts`, then update `adapter.test.ts` method list and delegation assertions.

- [ ] **Step 9: Run tracker tests**

Run:

```bash
pnpm --filter @issuepilot/tracker-gitlab test
pnpm --filter @issuepilot/tracker-gitlab typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit tracker adapter changes**

Run:

```bash
git add packages/tracker-gitlab/src
git commit -m "feat(tracker-gitlab): add human-review closure primitives"
```

---

### Task 2: Add Pure Human Review Reconciler

**Files:**
- Create: `apps/orchestrator/src/orchestrator/human-review.ts`
- Create: `apps/orchestrator/src/orchestrator/__tests__/human-review.test.ts`

- [ ] **Step 1: Write failing unit tests for branch/runId parsing**

In `human-review.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseIssuePilotWorkpad } from "../human-review.js";

describe("parseIssuePilotWorkpad", () => {
  it("parses colon marker and backticked branch", () => {
    expect(
      parseIssuePilotWorkpad(
        "<!-- issuepilot:run:run-1 -->\n- Branch: `ai/7-add-x`",
      ),
    ).toEqual({ runId: "run-1", branch: "ai/7-add-x" });
  });

  it("parses equals marker and plain branch", () => {
    expect(
      parseIssuePilotWorkpad(
        "<!-- issuepilot:run=run-2 -->\n- Branch: ai/8-add-y",
      ),
    ).toEqual({ runId: "run-2", branch: "ai/8-add-y" });
  });
});
```

- [ ] **Step 2: Implement parser**

In `human-review.ts`:

```ts
export function parseIssuePilotWorkpad(
  body: string,
): { runId: string; branch: string } | null {
  const runMatch = body.match(/<!--\s*issuepilot:run[:=]([^>\s]+)\s*-->/);
  const branchMatch = body.match(/Branch:\s*`?([^`\n]+)`?/i);
  const runId = runMatch?.[1]?.trim();
  const branch = branchMatch?.[1]?.trim();
  if (!runId || !branch) return null;
  return { runId, branch };
}
```

- [ ] **Step 3: Write failing tests for MR state decisions**

Add tests for:

```ts
it("closes issue when matching MR is merged");
it("keeps issue unchanged when matching MR is opened");
it("moves issue to ai-rework when matching MR is closed unmerged");
it("does not close when no workpad note exists");
it("does not close when issue lost human-review before close");
```

Use in-memory fakes:

```ts
const events: Array<{ type: string; detail: Record<string, unknown> }> = [];
const gitlab = {
  listHumanReviewIssues: vi.fn(async () => [issue]),
  findLatestIssuePilotWorkpadNote: vi.fn(async () => ({ id: 1, body: noteBody })),
  listMergeRequestsBySourceBranch: vi.fn(async () => [mr]),
  getIssue: vi.fn(async () => issue),
  createIssueNote: vi.fn(async () => ({ id: 2 })),
  closeIssue: vi.fn(async () => ({ labels: [], state: "closed" })),
  transitionLabels: vi.fn(async () => ({ labels: ["ai-rework"] })),
};
await reconcileHumanReview({
  gitlab,
  handoffLabel: "human-review",
  reworkLabel: "ai-rework",
  onEvent: (event) => events.push(event),
});
```

- [ ] **Step 4: Implement reconciler types and MR choice**

Add narrow local interfaces so this module stays testable without daemon imports:

```ts
export interface HumanReviewIssue {
  id: string;
  iid: number;
  title: string;
  url: string;
  projectId: string;
  labels: readonly string[];
  state?: string;
}

export interface HumanReviewMergeRequest {
  iid: number;
  webUrl: string;
  state: string;
  sourceBranch: string;
  updatedAt?: string;
}

export function chooseMergeRequest(
  rows: readonly HumanReviewMergeRequest[],
): HumanReviewMergeRequest | null {
  const byState = (state: string) =>
    rows
      .filter((mr) => mr.state === state)
      .sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""))
      .at(0) ?? null;
  return byState("opened") ?? byState("merged") ?? byState("closed");
}
```

- [ ] **Step 5: Implement `reconcileHumanReview`**

Core behavior:

```ts
export async function reconcileHumanReview(input: ReconcileHumanReviewInput) {
  const issues = await input.gitlab.listHumanReviewIssues();
  input.onEvent({
    type: "human_review_scan_started",
    runId: "human-review-scan",
    issueIid: 0,
    ts: now(),
    detail: { count: issues.length },
  });

  for (const issue of issues) {
    if (!issue.labels.includes(input.handoffLabel)) continue;
    const note = await input.gitlab.findLatestIssuePilotWorkpadNote(issue.iid);
    const parsed = note ? parseIssuePilotWorkpad(note.body) : null;
    if (!parsed) {
      input.onEvent(eventFor(issue, "human_review_mr_missing", { reason: "missing_workpad" }));
      continue;
    }

    const mrs = await input.gitlab.listMergeRequestsBySourceBranch(parsed.branch);
    const mr = chooseMergeRequest(mrs.filter((row) => row.sourceBranch === parsed.branch));
    if (!mr) {
      input.onEvent(eventFor(issue, "human_review_mr_missing", { branch: parsed.branch, runId: parsed.runId }));
      continue;
    }

    if (mr.state === "opened") {
      input.onEvent(eventFor(issue, "human_review_mr_still_open", { branch: parsed.branch, mrIid: mr.iid, runId: parsed.runId }));
      continue;
    }

    if (mr.state === "merged") {
      const latest = await input.gitlab.getIssue(issue.iid);
      if (latest.state !== "opened" || !latest.labels.includes(input.handoffLabel)) {
        input.onEvent(eventFor(issue, "human_review_reconcile_failed", { reason: "issue_state_changed", runId: parsed.runId }));
        continue;
      }
      await input.gitlab.createIssueNote(issue.iid, buildFinalNote({ issue, mr, branch: parsed.branch, runId: parsed.runId }));
      await input.gitlab.closeIssue(issue.iid, {
        removeLabels: [input.handoffLabel],
        requireCurrent: [input.handoffLabel],
      });
      input.onEvent(eventFor(issue, "human_review_issue_closed", { branch: parsed.branch, mrIid: mr.iid, runId: parsed.runId }));
      continue;
    }

    if (mr.state === "closed") {
      await input.gitlab.transitionLabels(issue.iid, {
        add: [input.reworkLabel],
        remove: [input.handoffLabel],
        requireCurrent: [input.handoffLabel],
      });
      input.onEvent(eventFor(issue, "human_review_rework_requested", { branch: parsed.branch, mrIid: mr.iid, runId: parsed.runId }));
    }
  }
}
```

Keep event helper local and small. Include `issueIid` on every event so daemon can persist issue-scoped closure events even when runtime state was lost after restart.

- [ ] **Step 6: Run orchestrator unit test**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/orchestrator/__tests__/human-review.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit reconciler unit**

Run:

```bash
git add apps/orchestrator/src/orchestrator/human-review.ts apps/orchestrator/src/orchestrator/__tests__/human-review.test.ts
git commit -m "feat(orchestrator): reconcile merged human-review issues"
```

---

### Task 3: Wire Reconciler Into Daemon Polling

**Files:**
- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `apps/orchestrator/src/orchestrator/loop.ts`
- Modify: `apps/orchestrator/src/orchestrator/__tests__/loop.test.ts`
- Modify: `apps/orchestrator/src/index.ts`

- [ ] **Step 1: Tighten loop ordering test**

In `loop.test.ts`, add an assertion that `reconcileRunning` runs before retry dispatch and claim:

```ts
it("runs reconciliation before retry dispatch and claim", async () => {
  const sequence: string[] = [];
  const deps = createFakeLoopDeps({
    reconcileRunning: vi.fn(async () => sequence.push("reconcile")),
    claim: vi.fn(async () => {
      sequence.push("claim");
      return [];
    }),
    dispatch: vi.fn(async (runId: string) => sequence.push(`dispatch:${runId}`)),
  });
  deps.state.setRun("retry-1", {
    runId: "retry-1",
    status: "retrying",
    attempt: 2,
    nextRetryAt: new Date().toISOString(),
  });

  const loop = startLoop(deps);
  await loop.tick();
  await loop.stop();

  expect(sequence[0]).toBe("reconcile");
});
```

- [ ] **Step 2: Run loop test**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/orchestrator/__tests__/loop.test.ts
```

Expected: PASS if the existing loop already calls `reconcileRunning` first. If it fails, fix loop order before continuing.

- [ ] **Step 3: Export reconciler if needed**

Update `apps/orchestrator/src/index.ts` if tests or downstream package exports require:

```ts
export {
  reconcileHumanReview,
  parseIssuePilotWorkpad,
  chooseMergeRequest,
} from "./orchestrator/human-review.js";
```

- [ ] **Step 4: Wire daemon `reconcileRunning`**

Replace the current no-op:

```ts
reconcileRunning: async () => undefined,
```

with a call to `reconcileHumanReview`.

Build the GitLab slice using existing adapter methods:

```ts
reconcileRunning: async () => {
  await reconcileHumanReview({
    gitlab: {
      listHumanReviewIssues: async () => {
        const issues = await gitlab.listCandidateIssues({
          activeLabels: [workflow.tracker.handoffLabel],
          excludeLabels: [
            workflow.tracker.runningLabel,
            workflow.tracker.failedLabel,
            workflow.tracker.blockedLabel,
          ],
        });
        return Promise.all(issues.map((issue) => gitlab.getIssue(issue.iid)));
      },
      findLatestIssuePilotWorkpadNote: gitlab.findLatestIssuePilotWorkpadNote,
      listMergeRequestsBySourceBranch: gitlab.listMergeRequestsBySourceBranch,
      getIssue: gitlab.getIssue,
      createIssueNote: gitlab.createIssueNote,
      closeIssue: gitlab.closeIssue,
      transitionLabels: gitlab.transitionLabels,
    },
    handoffLabel: workflow.tracker.handoffLabel,
    reworkLabel: "ai-rework",
    onEvent: publishIssueEvent,
  });
},
```

Prefer adding `reworkLabel` to workflow config only if it already exists in parsed tracker config. If the parsed config has no dedicated field, use `workflow.tracker.activeLabels.find((l) => l === "ai-rework") ?? "ai-rework"` and avoid broad workflow schema changes in this task.

- [ ] **Step 5: Add issue-aware event publishing**

Current `publishEvent` persists only if it can infer issue iid from `runIndex` or runtime state. Add a wrapper for human-review events:

```ts
const publishIssueEvent = (event: {
  type: string;
  runId: string;
  issueIid: number;
  ts: string;
  detail: Record<string, unknown>;
}): void => {
  if (event.issueIid > 0) {
    runIndex.set(event.runId, runKey(workflow, event.issueIid));
  }
  publishEvent({
    type: event.type,
    runId: event.runId,
    ts: event.ts,
    detail: event.detail,
  });
};
```

For issue-specific events, use the parsed workpad runId when available. For scan-level events without an issue, either skip persistence or use a synthetic `human-review-scan` run id and `issueIid: 0`.

- [ ] **Step 6: Run orchestrator tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test
pnpm --filter @issuepilot/orchestrator typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit daemon wiring**

Run:

```bash
git add apps/orchestrator/src
git commit -m "feat(orchestrator): close merged human-review issues"
```

---

### Task 4: Extend Fake GitLab And E2E Closure Coverage

**Files:**
- Modify: `tests/e2e/fakes/gitlab/server.ts`
- Modify: `tests/e2e/fakes/gitlab/server.test.ts`
- Modify: `tests/e2e/fakes/gitlab/gitbeaker.test.ts`
- Modify: `tests/e2e/happy-path.test.ts`

- [ ] **Step 1: Write fake server tests for issue close**

In `server.test.ts`, add coverage for `PUT /issues/:iid` with `state_event=close` or `stateEvent=close`:

```ts
it("closes an issue through the update endpoint", async () => {
  const issue = state.issues.get(7)!;
  expect(issue.state).toBe("opened");

  const res = await server.app.inject({
    method: "PUT",
    url: `/api/v4/projects/${encodeURIComponent(state.projectId)}/issues/7`,
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { labels: "p1", state_event: "close" },
  });

  expect(res.statusCode).toBe(200);
  expect(state.issues.get(7)?.state).toBe("closed");
  expect(state.issues.get(7)?.labels).toEqual(["p1"]);
});
```

- [ ] **Step 2: Implement fake issue close**

Update `UpdateIssueBody`:

```ts
interface UpdateIssueBody {
  labels?: string | string[];
  state_event?: "close" | "reopen";
  stateEvent?: "close" | "reopen";
}
```

In the issue update route:

```ts
const stateEvent = req.body.state_event ?? req.body.stateEvent;
if (stateEvent === "close") row.state = "closed";
if (stateEvent === "reopen") row.state = "opened";
```

- [ ] **Step 3: Write E2E expectation for merged MR closure**

In `tests/e2e/happy-path.test.ts`, after the run reaches `human-review`, mutate fake MR state:

```ts
const mr = ws.gitlabState.mergeRequests.get(aiBranches[0]!);
if (!mr) throw new Error("expected MR");
mr.state = "merged";
mr.updated_at = new Date().toISOString();

await ws.gitlabServer.waitFor(
  (s) => s.issues.get(ISSUE_IID)?.state === "closed",
  { timeoutMs: 10_000, intervalMs: 50 },
);

expect(ws.gitlabState.issues.get(ISSUE_IID)?.labels).not.toContain(
  "human-review",
);
expect((ws.gitlabState.notes.get(ISSUE_IID) ?? []).some((n) =>
  n.body.includes("MR merged"),
)).toBe(true);
```

This should fail until Tasks 1-3 are fully wired.

- [ ] **Step 4: Run fake GitLab tests**

Run:

```bash
pnpm test -- tests/e2e/fakes/gitlab/server.test.ts tests/e2e/fakes/gitlab/gitbeaker.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run happy path E2E**

Run:

```bash
pnpm test -- tests/e2e/happy-path.test.ts
```

Expected: PASS, including issue closure after fake MR state becomes `merged`.

- [ ] **Step 6: Commit E2E changes**

Run:

```bash
git add tests/e2e
git commit -m "test(e2e): cover human-review closure"
```

---

### Task 5: Final Verification And Docs Check

**Files:**
- Modify docs only if implementation names differ from the approved spec.

- [ ] **Step 1: Run focused package checks**

Run:

```bash
pnpm --filter @issuepilot/tracker-gitlab test
pnpm --filter @issuepilot/tracker-gitlab typecheck
pnpm --filter @issuepilot/orchestrator test
pnpm --filter @issuepilot/orchestrator typecheck
```

Expected: PASS.

- [ ] **Step 2: Run E2E and workspace checks**

Run:

```bash
pnpm test -- tests/e2e/happy-path.test.ts
pnpm typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 3: Inspect final diff**

Run:

```bash
git status --short
git log --oneline -5
```

Expected: only intentional implementation commits are present and the worktree is clean after the final commit.

- [ ] **Step 4: Update docs if implementation changed a public behavior**

Only edit specs if the final implementation intentionally differs from the approved design, such as event names or adapter behavior. Run:

```bash
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Final commit if docs changed**

Run:

```bash
git add docs/superpowers/specs docs/superpowers/plans
git commit -m "docs: align human-review closure implementation notes"
```

Skip this step if no docs changed during implementation.

## Plan Review Notes

Subagent plan review was not dispatched in this session because the active system rules allow spawning agents only when the user explicitly asks for subagents or parallel agent work. The plan is structured so a future reviewer can compare this file directly against `docs/superpowers/specs/2026-05-14-human-review-closure-design.md`.
