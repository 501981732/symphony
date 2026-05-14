# Issue Note Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement structured GitLab Issue notes for IssuePilot handoff, failure / blocked, and human-review closing flows.

**Architecture:** Keep note ownership in the orchestrator. `reconcile.ts` generates the final success handoff note after MR creation/update and before the label transition to `human-review`; `daemon.ts` generates failure / blocked notes from the dispatch failure callback; `human-review.ts` generates the closing note after a merged MR is verified. GitLab adapter APIs remain unchanged except for narrowing the orchestrator's local reconcile slice to carry MR web URLs already returned by the adapter.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces, GitLab adapter package, orchestrator daemon.

---

## File Structure

- Modify `apps/orchestrator/src/orchestrator/reconcile.ts`
  - Owns MR body generation, structured handoff note generation, workpad marker lookup, and success label transition.
- Modify `apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts`
  - Unit coverage for structured success handoff note, existing-note update, no-code-change handoff, MR URL propagation, and configured rework label.
- Modify `apps/orchestrator/src/orchestrator/dispatch.ts`
  - Pass `reworkLabel` from the daemon into reconcile without changing dispatch ownership.
- Modify `apps/orchestrator/src/daemon.ts`
  - Pass `reworkLabel` into reconcile and enrich failure / blocked note creation with run id, branch, status label, and ready label.
- Modify `apps/orchestrator/src/__tests__/daemon.test.ts`
  - Unit coverage for daemon wiring where practical.
- Modify `tests/e2e/blocked-and-failed.test.ts`
  - End-to-end assertions for structured failure / blocked note fields.
- Modify `apps/orchestrator/src/orchestrator/human-review.ts`
  - Owns structured closing note template.
- Modify `apps/orchestrator/src/orchestrator/__tests__/human-review.test.ts`
  - Unit coverage for closing note body.
- Modify `docs/superpowers/specs/2026-05-11-issuepilot-design.md`
  - Sync the old workpad/fallback note description with the new handoff-note design.
- Modify `docs/getting-started.md`
  - Sync user-facing English note guidance.
- Modify `docs/getting-started.zh-CN.md`
  - Sync user-facing Chinese note guidance.
- Modify `README.md`
  - Sync high-level English note wording if it still says fallback note.
- Modify `README.zh-CN.md`
  - Sync high-level Chinese note wording if it still says fallback note.

## Task 1: Structured Success Handoff Note

**Files:**
- Modify: `apps/orchestrator/src/orchestrator/reconcile.ts`
- Modify: `apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts`
- Modify: `apps/orchestrator/src/orchestrator/dispatch.ts`
- Modify: `apps/orchestrator/src/daemon.ts`
- Test: `apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts`

- [ ] **Step 1: Write failing tests for the created handoff note**

In `apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts`, change the mock MR return to include `webUrl`:

```ts
createMergeRequest: vi.fn(async () => ({
  iid: 100,
  webUrl: "https://gitlab.example.com/group/project/-/merge_requests/100",
})),
```

Add `reworkLabel` to `baseInput`:

```ts
reworkLabel: "ai-rework",
```

Add a test:

```ts
it("creates a structured handoff note before moving to human-review", async () => {
  const input = baseInput(mocks);
  input.agentSummary = "Fixed the null check";
  input.agentValidation = "pnpm --filter @issuepilot/orchestrator test passed";
  input.agentRisks = "None identified";

  await reconcile(input);

  expect(mocks.gitlab.createNote).toHaveBeenCalledWith(
    42,
    expect.stringContaining("## IssuePilot handoff"),
  );
  const note = mocks.gitlab.createNote.mock.calls[0]![1];
  expect(note).toContain("<!-- issuepilot:run:run-1 -->");
  expect(note).toContain("- Status: human-review");
  expect(note).toContain("- Run: `run-1`");
  expect(note).toContain("- Attempt: 1");
  expect(note).toContain("- Branch: `ai/42-fix-bug`");
  expect(note).toContain(
    "- MR: !100 https://gitlab.example.com/group/project/-/merge_requests/100",
  );
  expect(note).toContain("### What changed\nFixed the null check");
  expect(note).toContain(
    "### Validation\npnpm --filter @issuepilot/orchestrator test passed",
  );
  expect(note).toContain("### Risks / follow-ups\nNone identified");
  expect(note).toContain("move this Issue to `ai-rework`");
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/orchestrator/__tests__/reconcile.test.ts
```

Expected: FAIL because `ReconcileInput` has no `reworkLabel`, MR returns no `webUrl` in the local reconcile type, and the note still uses the old `**IssuePilot run**` body.

- [ ] **Step 3: Extend reconcile input and local GitLab slice**

In `apps/orchestrator/src/orchestrator/reconcile.ts`, add:

```ts
reworkLabel: string;
```

to `ReconcileInput`, and change local MR types:

```ts
findMergeRequest(
  sourceBranch: string,
): Promise<{ iid: number; title: string; description: string; webUrl?: string } | null>;
createMergeRequest(opts: {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}): Promise<{ iid: number; webUrl?: string }>;
```

Use optional `webUrl` for existing MR compatibility because the current daemon path always returns `null` from `findMergeRequest`; later code can tighten this when a real finder exists.

- [ ] **Step 4: Pass `reworkLabel` through dispatch and daemon**

In `apps/orchestrator/src/orchestrator/dispatch.ts`, extend `DispatchDeps["reconcile"]` opts and `DispatchInput` with:

```ts
reworkLabel: string;
```

Pass it in the reconcile call:

```ts
reworkLabel: input.reworkLabel,
```

In `apps/orchestrator/src/daemon.ts`, pass workflow config into dispatch:

```ts
reworkLabel: workflow.tracker.reworkLabel,
```

- [ ] **Step 5: Implement `buildHandoffNote`**

In `apps/orchestrator/src/orchestrator/reconcile.ts`, replace `buildWorkpadNote` with a structured handoff builder:

```ts
function fallbackText(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function mrLine(mr: { iid: number; webUrl?: string } | null): string {
  if (!mr) return "not created";
  return mr.webUrl ? `!${mr.iid} ${mr.webUrl}` : `!${mr.iid}`;
}

function buildHandoffNote(
  input: ReconcileInput,
  mr: { iid: number; webUrl?: string } | null,
): string {
  const summary = fallbackText(
    input.agentSummary,
    input.noCodeChangeReason
      ? `No code changes: ${input.noCodeChangeReason}`
      : "Codex completed without a structured summary; see commits.",
  );
  const validation = fallbackText(
    input.agentValidation,
    input.noCodeChangeReason
      ? "No validation command was reported for this no-code-change run."
      : "(no validation summary)",
  );
  const risks = fallbackText(input.agentRisks, "None reported.");

  return [
    `<!-- issuepilot:run:${input.runId} -->`,
    "## IssuePilot handoff",
    "",
    `- Status: ${input.handoffLabel}`,
    `- Run: \`${input.runId}\``,
    `- Attempt: ${input.attempt}`,
    `- Branch: \`${input.branch}\``,
    `- MR: ${mrLine(mr)}`,
    "",
    "### What changed",
    summary,
    "",
    "### Validation",
    validation,
    "",
    "### Risks / follow-ups",
    risks,
    "",
    "### Next action",
    `Review and merge the MR, or move this Issue to \`${input.reworkLabel}\` if changes are required.`,
  ].join("\n");
}
```

- [ ] **Step 6: Use the handoff builder in both reconcile branches**

In the no-commit branch, call:

```ts
const noteBody = buildHandoffNote(
  {
    ...input,
    noCodeChangeReason,
  },
  null,
);
```

In the commit branch, keep the created or existing MR in a local variable:

```ts
let handoffMr: { iid: number; webUrl?: string };
if (!existingMr) {
  const mr = await input.gitlab.createMergeRequest(...);
  handoffMr = mr;
} else {
  await input.gitlab.updateMergeRequest(...);
  handoffMr = existingMr;
}
const noteBody = buildHandoffNote(input, handoffMr);
```

Keep the marker lookup before create/update:

```ts
const marker = `<!-- issuepilot:run:${input.runId} -->`;
const existingNote = await input.gitlab.findWorkpadNote(input.iid, marker);
```

- [ ] **Step 7: Run focused reconcile tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/orchestrator/__tests__/reconcile.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add apps/orchestrator/src/orchestrator/reconcile.ts \
  apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts \
  apps/orchestrator/src/orchestrator/dispatch.ts \
  apps/orchestrator/src/daemon.ts
git commit -m "feat(orchestrator): structure issue handoff notes"
```

## Task 2: No-Code-Change and Existing-Note Coverage

**Files:**
- Modify: `apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts`
- Modify: `apps/orchestrator/src/orchestrator/reconcile.ts`
- Test: `apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts`

- [ ] **Step 1: Tighten the no-code-change test**

Update the existing no-code-change test to assert:

```ts
const note = mocks.gitlab.createNote.mock.calls[0]![1];
expect(note).toContain("## IssuePilot handoff");
expect(note).toContain("- MR: not created");
expect(note).toContain(
  "No code changes: Existing implementation already satisfies the issue.",
);
expect(note).toContain("move this Issue to `ai-rework`");
```

- [ ] **Step 2: Tighten the existing-note update test**

Update the existing workpad test:

```ts
expect(mocks.gitlab.updateNote).toHaveBeenCalledWith(
  42,
  7,
  expect.stringContaining("## IssuePilot handoff"),
);
expect(mocks.gitlab.updateNote).toHaveBeenCalledWith(
  42,
  7,
  expect.stringContaining("issuepilot:run:run-1"),
);
expect(mocks.gitlab.createNote).not.toHaveBeenCalled();
```

- [ ] **Step 3: Run test to verify current implementation fails if Task 1 was not complete**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/orchestrator/__tests__/reconcile.test.ts
```

Expected after Task 1: PASS. Expected before Task 1: FAIL on old note content.

- [ ] **Step 4: Fix any missed fallback behavior**

If the test fails, adjust only `buildHandoffNote` fallback logic. Do not special-case test strings outside the note builder.

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/orchestrator/src/orchestrator/reconcile.ts \
  apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts
git commit -m "test(orchestrator): cover issue handoff note fallbacks"
```

## Task 3: Structured Failure and Blocked Notes

**Files:**
- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `tests/e2e/blocked-and-failed.test.ts`
- Modify if needed: `apps/orchestrator/src/__tests__/daemon.test.ts`
- Test: `tests/e2e/blocked-and-failed.test.ts`

- [ ] **Step 1: Write failing E2E assertions for failed notes**

In `tests/e2e/blocked-and-failed.test.ts`, update the first failure-note assertion:

```ts
expect(failureNote?.body).toContain("## IssuePilot run failed");
expect(failureNote?.body).toContain("- Status: ai-failed");
expect(failureNote?.body).toContain("- Run: `");
expect(failureNote?.body).toContain("- Attempt: 1");
expect(failureNote?.body).toContain("- Branch: `");
expect(failureNote?.body).toContain("### Reason");
expect(failureNote?.body).toContain("### Next action");
expect(failureNote?.body).toContain("move this Issue back to `ai-ready`");
```

- [ ] **Step 2: Add blocked-note assertion where claim 403 transitions to blocked**

In the existing claim 403 test, after the issue label assertions, inspect notes:

```ts
const notes = ws.gitlabState.notes.get(ISSUE_IID) ?? [];
const blockedNote = notes.find((n) =>
  n.body.includes("## IssuePilot run blocked"),
);
expect(blockedNote).toBeDefined();
expect(blockedNote?.body).toContain("- Status: ai-blocked");
expect(blockedNote?.body).toContain("### Reason");
expect(blockedNote?.body).toContain("move this Issue back to `ai-ready`");
```

If that path currently does not create a note because claim fails before dispatch, keep this as an explicit discovered gap and implement note creation in the claim-failure path instead of loosening the test.

- [ ] **Step 3: Run E2E tests to verify failure**

Run:

```bash
pnpm --filter @issuepilot/e2e test -- blocked-and-failed.test.ts
```

Expected: FAIL because the failure note uses the old `Kind` / `Reason` template and claim 403 may not write a blocked note yet.

- [ ] **Step 4: Replace `createFailureNote` with a structured builder**

In `apps/orchestrator/src/daemon.ts`, change `createFailureNote` to accept context:

```ts
async function createFailureNote(
  gitlab: GitLabAdapter,
  iid: number,
  input: {
    runId: string;
    branch: string;
    classification: Classification;
    attempt: number;
    statusLabel: string;
    readyLabel: string;
  },
): Promise<void> {
  const title =
    input.classification.kind === "blocked"
      ? "IssuePilot run blocked"
      : "IssuePilot run failed";
  await gitlab.createIssueNote(
    iid,
    [
      `## ${title}`,
      "",
      `- Status: ${input.statusLabel}`,
      `- Run: \`${input.runId}\``,
      `- Attempt: ${input.attempt}`,
      `- Branch: \`${input.branch}\``,
      "",
      "### Reason",
      input.classification.reason,
      "",
      "### Next action",
      `Address the reason above, then move this Issue back to \`${input.readyLabel}\`.`,
    ].join("\n"),
  );
}
```

Use `workflow.tracker.activeLabels[0] ?? "ai-ready"` as the ready label in the daemon. If the workflow parser exposes a stronger field later, use that instead.

- [ ] **Step 5: Pass failure context from dispatch callback**

In the `onFailure` closure in `apps/orchestrator/src/daemon.ts`, pass:

```ts
await createFailureNote(gitlab, issue.iid, {
  runId: _failedRunId,
  branch,
  classification,
  attempt,
  statusLabel: label,
  readyLabel: workflow.tracker.activeLabels[0] ?? "ai-ready",
});
```

- [ ] **Step 6: Handle claim-failure blocked notes if needed**

If Step 2 exposed that claim failures do not pass through `onFailure`, find the claim failure transition in `apps/orchestrator/src/daemon.ts` and create the same structured blocked note there with:

```ts
runId,
branch,
classification: { kind: "blocked", reason: "...", code: "claim_failed" },
attempt: run.attempt,
statusLabel: workflow.tracker.blockedLabel,
readyLabel: workflow.tracker.activeLabels[0] ?? "ai-ready",
```

Keep this branch best-effort: label transition failure should still be logged as it is today.

- [ ] **Step 7: Run focused E2E tests**

Run:

```bash
pnpm --filter @issuepilot/e2e test -- blocked-and-failed.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add apps/orchestrator/src/daemon.ts \
  apps/orchestrator/src/__tests__/daemon.test.ts \
  tests/e2e/blocked-and-failed.test.ts
git commit -m "feat(orchestrator): structure failure issue notes"
```

## Task 4: Structured Closing Note

**Files:**
- Modify: `apps/orchestrator/src/orchestrator/human-review.ts`
- Modify: `apps/orchestrator/src/orchestrator/__tests__/human-review.test.ts`
- Test: `apps/orchestrator/src/orchestrator/__tests__/human-review.test.ts`

- [ ] **Step 1: Write failing closing note test**

In `apps/orchestrator/src/orchestrator/__tests__/human-review.test.ts`, update the merged-MR test:

```ts
expect(mocks.gitlab.createIssueNote).toHaveBeenCalledWith(
  7,
  expect.stringContaining("## IssuePilot closed this issue"),
);
const note = mocks.gitlab.createIssueNote.mock.calls[0]![1];
expect(note).toContain("- Status: closed");
expect(note).toContain("- Run: `run-7`");
expect(note).toContain("- Branch: `ai/7-add-x`");
expect(note).toContain("- MR: !70 https://gitlab.example.com/mr/70");
expect(note).toContain("removed `human-review` and closed this Issue");
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/orchestrator/__tests__/human-review.test.ts
```

Expected: FAIL because the old note starts with `IssuePilot closing note:`.

- [ ] **Step 3: Implement the closing template**

In `apps/orchestrator/src/orchestrator/human-review.ts`, update `buildMergedFinalNote`:

```ts
function buildMergedFinalNote(
  parsed: IssuePilotWorkpadRef,
  mr: HumanReviewMergeRequest,
  handoffLabel: string,
): string {
  return [
    "## IssuePilot closed this issue",
    "",
    "- Status: closed",
    `- Run: \`${parsed.runId}\``,
    `- Branch: \`${parsed.branch}\``,
    `- MR: !${mr.iid} ${mr.webUrl}`,
    "",
    "### Result",
    `The linked MR was merged by a human reviewer, so IssuePilot removed \`${handoffLabel}\` and closed this Issue.`,
  ].join("\n");
}
```

Update call site:

```ts
await input.gitlab.createIssueNote(
  issueIid,
  buildMergedFinalNote(parsed, mr, input.handoffLabel),
);
```

- [ ] **Step 4: Run human-review tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/orchestrator/__tests__/human-review.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add apps/orchestrator/src/orchestrator/human-review.ts \
  apps/orchestrator/src/orchestrator/__tests__/human-review.test.ts
git commit -m "feat(orchestrator): structure closing issue notes"
```

## Task 5: Documentation Sync

**Files:**
- Modify: `docs/superpowers/specs/2026-05-11-issuepilot-design.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/getting-started.zh-CN.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Test: documentation grep and whitespace checks

- [ ] **Step 1: Find stale note wording**

Run:

```bash
rg -n "workpad note|fallback note|handoff note|issuepilot:run=|issuepilot:run:<runId>|Issue note|Issue 收到 handoff note" README.md README.zh-CN.md docs
```

Expected: identify the old descriptions that still imply separate fallback notes or equals-marker examples.

- [ ] **Step 2: Update the main design spec**

In `docs/superpowers/specs/2026-05-11-issuepilot-design.md`, change the note strategy section to say:

```md
5. Issue note 策略：P0 维护一条 orchestrator-owned handoff note，使用
   `<!-- issuepilot:run:<runId> -->` marker 做去重、恢复和 human-review
   reconciliation。reconcile 阶段在创建或更新 MR 后写入该 note；缺失的
   summary / validation / risks 通过字段 fallback 表达，不再写独立成功
   fallback note。
```

- [ ] **Step 3: Update getting-started docs**

In both getting-started files, explain that the final Issue note has:

```md
<!-- issuepilot:run:<runId> -->
## IssuePilot handoff
```

and includes branch, MR, summary, validation, risks, and next action.

- [ ] **Step 4: Update READMEs if stale**

Replace high-level mentions of `persistent workpad note + fallback note` with `structured handoff note with marker-based recovery`, in English and Chinese.

- [ ] **Step 5: Verify docs**

Run:

```bash
rg -n "issuepilot:run=" README.md README.zh-CN.md docs
git diff --check
```

Expected: no stale equals-marker references unless they intentionally describe backward-compatible parsing; no whitespace errors.

- [ ] **Step 6: Commit Task 5**

```bash
git add docs/superpowers/specs/2026-05-11-issuepilot-design.md \
  docs/getting-started.md \
  docs/getting-started.zh-CN.md \
  README.md \
  README.zh-CN.md
git commit -m "docs: align issue note handoff guidance"
```

## Task 6: Full Verification

**Files:**
- No source changes expected unless verification exposes a defect.
- Test: all touched package and E2E checks.

- [ ] **Step 1: Run orchestrator tests**

```bash
pnpm --filter @issuepilot/orchestrator test
```

Expected: PASS.

- [ ] **Step 2: Run E2E tests**

```bash
pnpm --filter @issuepilot/e2e test
```

Expected: PASS.

- [ ] **Step 3: Run workspace checks if available**

```bash
pnpm -w turbo run test typecheck lint
```

Expected: PASS. If some tasks are not configured, record the exact missing task output in the final handoff instead of hiding it.

- [ ] **Step 4: Run final diff checks**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intentional uncommitted changes if a previous step failed before commit.

- [ ] **Step 5: Final implementation handoff**

Summarize:

- commits created,
- tests run,
- any test gaps or environment blockers,
- whether docs and implementation now agree on `<!-- issuepilot:run:<runId> -->`.
