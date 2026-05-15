# IssuePilot P0 Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the highest-risk P0 gaps from the gap spec so IssuePilot aligns with the root `SPEC.md` where it should, while keeping GitLab-specific product choices explicit.

**Architecture:** Keep this as four independently reviewable slices: workflow filename / docs alignment, reconciler MR lookup hardening, non-interactive Codex input handling, and event-contract cleanup. Do not introduce V2 dashboard actions, databases, multi-worker execution, or auto-merge behavior in this plan.

**Tech Stack:** TypeScript, pnpm workspaces, Commander CLI, Vitest, Fastify, Next.js docs, GitLab adapter, Codex app-server runner.

---

## Scope And Sequencing

This plan implements the P0 portion of `docs/superpowers/specs/2026-05-15-issuepilot-gap-closure-design.md`.

It intentionally does not implement:

- V2 dashboard actions (`retry`, `stop`, `archive run`).
- CI failure auto-rework.
- Database-backed run history.
- workspace prune policy beyond documentation.
- Docker/Kubernetes or SSH workers.
- automatic merge.

Recommended execution order:

1. Task 1 and Task 2 together: `WORKFLOW.md` default + entrypoint docs.
2. Task 3: MR lookup hardening.
3. Task 4: user-input-required handling.
4. Task 5: event contract cleanup.
5. Task 6: smoke evidence and release boundary docs.

Each task should be committed separately.

## File Structure

- Modify `apps/orchestrator/src/cli.ts`
  - Owns CLI workflow path resolution and ready banner copy.
- Modify `apps/orchestrator/src/__tests__/cli.test.ts`
  - Tests `WORKFLOW.md` default lookup and `.agents/workflow.md` compatibility warning.
- Modify `packages/workflow/src/parse.ts`
  - Replace `.agents/workflow.md`-specific comments with generic workflow file wording.
- Modify `packages/workflow/src/__tests__/parse.test.ts`
  - Keeps parser behavior stable; only add tests if comments become behavior.
- Modify `docs/superpowers/specs/2026-05-11-issuepilot-design.md`
  - Sync main design to `WORKFLOW.md` as the long-term default.
- Modify `README.md`, `README.zh-CN.md`
  - Sync quickstart, comparison table, layout wording, and examples.
- Modify `docs/getting-started.md`, `docs/getting-started.zh-CN.md`
  - Sync detailed setup examples from `.agents/workflow.md` to `WORKFLOW.md`.
- Modify `docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`
  - Sync smoke setup and add evidence template.
- Modify `apps/orchestrator/src/daemon.ts`
  - Wire real MR lookup into `reconcile`; improve ready banner data if needed.
- Modify `apps/orchestrator/src/__tests__/daemon.test.ts`
  - Tests daemon passes real `findMergeRequest` behavior into reconcile where practical.
- Modify `packages/tracker-gitlab/src/merge-requests.ts`
  - Add a first-class `findMergeRequestBySourceBranch` helper if reusing list helper is not expressive enough.
- Modify `packages/tracker-gitlab/src/adapter.ts`
  - Expose the MR finder on `GitLabAdapter`.
- Modify `packages/tracker-gitlab/src/types.ts`
  - Add the adapter method contract.
- Modify `packages/tracker-gitlab/src/__tests__/merge-requests.test.ts`
  - Tests opened MR selection for the source branch.
- Modify `packages/runner-codex-app-server/src/lifecycle.ts`
  - Handles app-server user input requests without stalling and maps them to a deterministic result.
- Modify `packages/runner-codex-app-server/src/__tests__/lifecycle.test.ts`
  - Tests user-input-required behavior.
- Modify `apps/orchestrator/src/orchestrator/classify.ts`
  - Maps user-input-required outcomes to `blocked` if lifecycle cannot continue.
- Modify `apps/orchestrator/src/orchestrator/__tests__/classify.test.ts`
  - Tests classification.
- Modify `packages/shared-contracts/src/events.ts`
  - Extends canonical P0 event types/payload expectations.
- Modify `apps/orchestrator/src/server/index.ts`
  - Keeps API/SSE payloads aligned with shared event shape.
- Modify `packages/observability/src/event-store.ts`
  - Only if persistence needs normalization at the storage boundary.
- Modify dashboard tests under `apps/dashboard/**`
  - Update only if the shared event shape changes frontend assumptions.

## Task 1: Workflow Filename Defaults

**Files:**
- Modify: `apps/orchestrator/src/cli.ts`
- Modify: `apps/orchestrator/src/__tests__/cli.test.ts`
- Modify: `packages/workflow/src/parse.ts`
- Test: `apps/orchestrator/src/__tests__/cli.test.ts`

- [ ] **Step 1: Write failing tests for default `WORKFLOW.md` lookup**

In `apps/orchestrator/src/__tests__/cli.test.ts`, add a test that creates `WORKFLOW.md` in `tmpDir`, changes `process.cwd()` for the test, then runs `issuepilot run` without `--workflow`.

Expected test shape:

```ts
it("run defaults to ./WORKFLOW.md when --workflow is omitted", async () => {
  const originalCwd = process.cwd();
  fs.writeFileSync(path.join(tmpDir, "WORKFLOW.md"), "---\ntitle: test\n---\n");
  process.chdir(tmpDir);
  const startDaemon = vi.fn(async () => ({
    host: "127.0.0.1",
    port: 4738,
    url: "http://127.0.0.1:4738",
    state: {} as never,
    stop: async () => undefined,
    wait: async () => undefined,
  }));
  const cli = buildCli({ startDaemon });
  try {
    await cli.parseAsync(["run"], { from: "user" });
  } finally {
    process.chdir(originalCwd);
  }
  expect(startDaemon).toHaveBeenCalledWith({
    workflowPath: path.join(tmpDir, "WORKFLOW.md"),
    port: 4738,
    host: "127.0.0.1",
  });
});
```

- [ ] **Step 2: Write failing tests for `.agents/workflow.md` compatibility warning**

Add a test that only creates `.agents/workflow.md`, runs `issuepilot validate` without `--workflow`, and expects the CLI to use that path while printing a deprecation warning.

Expected assertion:

```ts
expect(mockWarn).toHaveBeenCalledWith(
  expect.stringContaining(".agents/workflow.md is deprecated as a default"),
);
```

- [ ] **Step 3: Run focused CLI tests and confirm failure**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/__tests__/cli.test.ts
```

Expected: FAIL because `--workflow` is currently required.

- [ ] **Step 4: Implement workflow path resolution helper**

In `apps/orchestrator/src/cli.ts`, add:

```ts
interface ResolvedWorkflowPath {
  path: string;
  warning?: string;
}

function resolveWorkflowPath(input: unknown, cwd = process.cwd()): ResolvedWorkflowPath {
  if (typeof input === "string" && input.trim().length > 0) {
    return { path: path.resolve(input) };
  }
  const rootWorkflow = path.resolve(cwd, "WORKFLOW.md");
  if (fs.existsSync(rootWorkflow)) return { path: rootWorkflow };
  const legacyWorkflow = path.resolve(cwd, ".agents", "workflow.md");
  if (fs.existsSync(legacyWorkflow)) {
    return {
      path: legacyWorkflow,
      warning:
        "Warning: .agents/workflow.md is deprecated as a default workflow path; move it to WORKFLOW.md or pass --workflow explicitly.",
    };
  }
  return { path: rootWorkflow };
}
```

- [ ] **Step 5: Make `--workflow` optional for `run` and `validate`**

Change `.requiredOption("--workflow <path>", ...)` to `.option("--workflow <path>", ...)` in both commands. Use `resolveWorkflowPath(opts.workflow)`, print `warning` with `console.warn`, then keep the existing existence check.

- [ ] **Step 6: Update parser comments**

In `packages/workflow/src/parse.ts`, replace comments that say `.agents/workflow.md` with `workflow file` or `WORKFLOW.md-compatible file`. Do not change parser behavior here.

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/__tests__/cli.test.ts
pnpm --filter @issuepilot/workflow test -- src/__tests__/parse.test.ts src/__tests__/loader.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add apps/orchestrator/src/cli.ts apps/orchestrator/src/__tests__/cli.test.ts packages/workflow/src/parse.ts
git commit -m "feat(cli): default to root workflow file"
```

## Task 2: Entry Point And Documentation Sync

**Files:**
- Modify: `docs/superpowers/specs/2026-05-11-issuepilot-design.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/getting-started.zh-CN.md`
- Modify: `docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`

- [ ] **Step 1: Update the main design spec**

Replace default workflow file references in `docs/superpowers/specs/2026-05-11-issuepilot-design.md`:

```text
.agents/workflow.md
```

with:

```text
WORKFLOW.md
```

Where compatibility needs to be mentioned, add:

```md
`.agents/workflow.md` is accepted only when passed explicitly with `--workflow`, or during the P0 migration fallback when `WORKFLOW.md` is absent.
```

- [ ] **Step 2: Sync README comparison tables**

In `README.md` and `README.zh-CN.md`, change the IssuePilot workflow row to say root `WORKFLOW.md`, not `.agents/workflow.md`.

- [ ] **Step 3: Sync quickstart paths**

In both getting-started docs, change:

```bash
WORKFLOW_PATH="$(pwd)/.agents/workflow.md"
```

to:

```bash
WORKFLOW_PATH="$(pwd)/WORKFLOW.md"
```

Update `git add` examples accordingly.

- [ ] **Step 4: Clarify daemon/dashboard process split**

Where docs imply `issuepilot run` starts both daemon and dashboard, rewrite to:

```md
`issuepilot run` starts the orchestrator daemon and local API. Run `pnpm dev:dashboard` separately for the Next.js dashboard during P0 source-checkout development.
```

- [ ] **Step 5: Sync smoke runbook**

In `docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`, change setup to create `WORKFLOW.md` in the target project. Keep one note that legacy `.agents/workflow.md` can be passed explicitly but should not be used as the default.

- [ ] **Step 6: Run documentation checks**

Run:

```bash
git diff --check
rg -n "\.agents/workflow.md" README.md README.zh-CN.md docs/getting-started.md docs/getting-started.zh-CN.md docs/superpowers/specs/2026-05-11-issuepilot-design.md docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md
```

Expected: remaining `.agents/workflow.md` hits are compatibility notes only.

- [ ] **Step 7: Commit Task 2**

```bash
git add README.md README.zh-CN.md docs/getting-started.md docs/getting-started.zh-CN.md docs/superpowers/specs/2026-05-11-issuepilot-design.md docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md
git commit -m "docs: align workflow file default with SPEC"
```

## Task 3: Reconcile Uses Real MR Lookup

**Files:**
- Modify: `packages/tracker-gitlab/src/types.ts`
- Modify: `packages/tracker-gitlab/src/merge-requests.ts`
- Modify: `packages/tracker-gitlab/src/adapter.ts`
- Modify: `packages/tracker-gitlab/src/__tests__/merge-requests.test.ts`
- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts`
- Test: `packages/tracker-gitlab/src/__tests__/merge-requests.test.ts`
- Test: `apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts`

- [ ] **Step 1: Add an adapter-level failing test**

In `packages/tracker-gitlab/src/__tests__/merge-requests.test.ts`, add:

```ts
describe("findMergeRequestBySourceBranch", () => {
  it("returns the opened MR for a source branch", async () => {
    const all = vi.fn(async () => [
      mrRow({ iid: 6, state: "opened", source_branch: "ai/42-add-x" }),
    ]);
    const client = makeClient({
      MergeRequests: { all, create: vi.fn(), edit: vi.fn(), show: vi.fn() },
    });
    await expect(findMergeRequestBySourceBranch(client, "ai/42-add-x")).resolves.toMatchObject({
      iid: 6,
      state: "opened",
      sourceBranch: "ai/42-add-x",
    });
  });
});
```

Expected: FAIL because helper does not exist.

- [ ] **Step 2: Implement `findMergeRequestBySourceBranch`**

In `packages/tracker-gitlab/src/merge-requests.ts`, add:

```ts
export async function findMergeRequestBySourceBranch(
  client: GitLabClient<GitLabApi>,
  sourceBranch: string,
): Promise<SourceBranchMergeRequestSummary | null> {
  const rows = await listMergeRequestsBySourceBranch(client, sourceBranch);
  return (
    rows.find((mr) => mr.sourceBranch === sourceBranch && mr.state === "opened") ??
    rows.find((mr) => mr.sourceBranch === sourceBranch) ??
    null
  );
}
```

- [ ] **Step 3: Expose it through the adapter**

In `packages/tracker-gitlab/src/types.ts`, add method to `GitLabAdapter`:

```ts
findMergeRequestBySourceBranch(sourceBranch: string): Promise<SourceBranchMergeRequestSummary | null>;
```

In `packages/tracker-gitlab/src/adapter.ts`, bind it.

- [ ] **Step 4: Wire daemon reconcile to adapter lookup**

In `apps/orchestrator/src/daemon.ts`, replace:

```ts
findMergeRequest: async () => null,
```

with:

```ts
findMergeRequest: async (sourceBranch) => {
  const mr = await gitlab.findMergeRequestBySourceBranch(sourceBranch);
  if (!mr) return null;
  return {
    iid: mr.iid,
    title: "",
    description: "",
    webUrl: mr.webUrl,
  };
},
```

If the adapter summary is extended to include title/description, map those fields instead of empty strings.

- [ ] **Step 5: Keep existing reconciler unit tests passing**

`apps/orchestrator/src/orchestrator/reconcile.ts` already calls `input.gitlab.findMergeRequest(input.branch)`. Add or keep the existing test `updates existing MR instead of creating`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm --filter @issuepilot/tracker-gitlab test -- src/__tests__/merge-requests.test.ts src/__tests__/adapter.test.ts
pnpm --filter @issuepilot/orchestrator test -- src/orchestrator/__tests__/reconcile.test.ts src/__tests__/daemon.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add packages/tracker-gitlab/src packages/tracker-gitlab/src/__tests__ apps/orchestrator/src/daemon.ts apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts
git commit -m "fix(orchestrator): reuse existing merge requests"
```

## Task 4: Non-Interactive Codex Input Handling

**Files:**
- Modify: `packages/runner-codex-app-server/src/lifecycle.ts`
- Modify: `packages/runner-codex-app-server/src/__tests__/lifecycle.test.ts`
- Modify: `apps/orchestrator/src/orchestrator/classify.ts`
- Modify: `apps/orchestrator/src/orchestrator/__tests__/classify.test.ts`

- [ ] **Step 1: Write failing lifecycle test**

In `packages/runner-codex-app-server/src/__tests__/lifecycle.test.ts`, add a test that calls `rpc.requestHandler("item/tool/requestUserInput", ...)` after `driveLifecycle` registers request handlers.

Expected assertion:

```ts
await expect(
  rpc.requestHandler("item/tool/requestUserInput", { turnId: "u1" }),
).resolves.toMatchObject({
  success: false,
});
expect(events).toContain("turn_input_required");
```

- [ ] **Step 2: Implement a protocol response instead of throwing**

In `packages/runner-codex-app-server/src/lifecycle.ts`, replace:

```ts
throw new Error("IssuePilot P0 does not support interactive user input");
```

with:

```ts
return {
  success: false,
  contentItems: [
    {
      type: "inputText",
      text:
        "This is a non-interactive IssuePilot run. Operator input is unavailable. If blocked, record the blocker and mark the issue ai-blocked.",
    },
  ],
};
```

- [ ] **Step 3: Ensure lifecycle still cannot stall**

If the app-server continues the turn after that response, the normal turn timeout remains the upper bound. Add a test that `turn_input_required` event is emitted and no request handler throws synchronously.

- [ ] **Step 4: Add classification fallback**

In `apps/orchestrator/src/orchestrator/classify.ts`, ensure any runner failure reason containing `turn_input_required` or `user input` becomes:

```ts
{ kind: "blocked", reason, code: "codex_input_required" }
```

Only do this if failures can still surface from older app-server versions.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm --filter @issuepilot/runner-codex-app-server test -- src/__tests__/lifecycle.test.ts
pnpm --filter @issuepilot/orchestrator test -- src/orchestrator/__tests__/classify.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add packages/runner-codex-app-server/src apps/orchestrator/src/orchestrator/classify.ts apps/orchestrator/src/orchestrator/__tests__/classify.test.ts
git commit -m "fix(runner): handle non-interactive input requests"
```

## Task 5: P0 Event Contract Cleanup

**Files:**
- Modify: `packages/shared-contracts/src/events.ts`
- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `apps/orchestrator/src/server/index.ts`
- Modify: `apps/orchestrator/src/server/__tests__/server.test.ts`
- Modify: `apps/dashboard/components/detail/event-timeline.tsx`
- Modify: dashboard tests only as needed.

- [ ] **Step 1: Audit emitted event types**

Run:

```bash
rg -n "type: \"|type: `|publishEvent\\(|onEvent\\(" apps/orchestrator/src packages/runner-codex-app-server/src packages/tracker-gitlab/src
```

Record any emitted types missing from `packages/shared-contracts/src/events.ts`.

- [ ] **Step 2: Extend shared event types**

Add missing P0 event types such as these if still absent:

```ts
"reconcile_no_commits",
"gitlab_workpad_note_created",
"gitlab_workpad_note_updated",
"human_review_scan_started",
"human_review_mr_found",
"human_review_mr_missing",
"human_review_mr_still_open",
"human_review_mr_merged",
"human_review_issue_closed",
"human_review_mr_closed_unmerged",
"human_review_rework_requested",
"human_review_reconcile_failed",
```

- [ ] **Step 3: Normalize publish shape in daemon**

In `apps/orchestrator/src/daemon.ts`, change `toEventRecord` to produce `createdAt` consistently while preserving `ts` only if old readers still need it:

```ts
return {
  id: randomUUID(),
  runId: event.runId,
  type: event.type,
  message: event.type,
  createdAt: event.ts,
  data: redact(event.detail),
};
```

When issue context is available, include the shared `issue` field. If not available for synthetic scan events, use a documented placeholder or keep those events as scan-only records with tests documenting the exception.

- [ ] **Step 4: Keep server backward compatibility during transition**

`apps/orchestrator/src/server/index.ts` currently reads `createdAt` or `ts`. Keep this fallback for one release:

```ts
const value = event["createdAt"] ?? event["ts"];
```

Do not remove it in P0.

- [ ] **Step 5: Update dashboard event timeline only if labels changed**

If event type names change, update `apps/dashboard/components/detail/event-timeline.tsx` maps. Prefer adding missing types to shared contracts over renaming persisted event types.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm --filter @issuepilot/shared-contracts test -- src/__tests__/events.test.ts
pnpm --filter @issuepilot/orchestrator test -- src/server/__tests__/server.test.ts src/__tests__/daemon.test.ts
pnpm --filter @issuepilot/dashboard test -- components/detail/event-timeline.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add packages/shared-contracts/src/events.ts apps/orchestrator/src apps/dashboard/components/detail
git commit -m "refactor(events): normalize P0 event contract"
```

## Task 6: Smoke Evidence And Release Boundary Docs

**Files:**
- Modify: `docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/getting-started.zh-CN.md`

- [ ] **Step 1: Add smoke evidence template**

In the smoke runbook, add a section:

```md
## Smoke Evidence Template

- Date:
- Issue URL:
- MR URL:
- Workflow path:
- Command:
- API URL:
- Dashboard URL:
- Handoff note marker:
- Closing note observed:
- Final issue state:
- Verification commands:
- Operator notes:
```

- [ ] **Step 2: Clarify `pnpm smoke` responsibility**

State that `pnpm smoke` starts orchestrator and waits for `/api/state`, but the operator still performs GitLab/MR/dashboard verification steps.

- [ ] **Step 3: Clarify release boundary**

In README roadmap/current status, keep:

```md
P0 source-checkout usage is supported; packaged install/upgrade is still a V1 release task.
```

- [ ] **Step 4: Run documentation checks**

Run:

```bash
git diff --check
pnpm format:check -- README.md README.zh-CN.md docs/getting-started.md docs/getting-started.zh-CN.md docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md
```

If `pnpm format:check -- <files>` is not supported by the repo script, run `pnpm format:check` and note the broader scope.

- [ ] **Step 5: Commit Task 6**

```bash
git add README.md README.zh-CN.md docs/getting-started.md docs/getting-started.zh-CN.md docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md
git commit -m "docs: add smoke evidence and release boundary"
```

## Final Verification

After all tasks are complete, run:

```bash
git diff --check
pnpm -w turbo run build test typecheck lint
pnpm test:smoke
```

Expected:

- All commands pass.
- No `.agents/workflow.md` references remain as default guidance.
- `WORKFLOW.md` is the default workflow file in public docs.
- `issuepilot run` works with `./WORKFLOW.md` without `--workflow`.
- `issuepilot run --workflow .agents/workflow.md` still works explicitly.
- Existing MR reconcile path updates instead of creating duplicates.
- user-input-required cannot stall a run.
- P0 event types are represented in shared contracts.

## Handoff Notes

- Keep each task as a separate commit.
- Do not change root `SPEC.md` in this plan unless the user explicitly asks to upstream IssuePilot GitLab extensions into the open spec.
- Preserve unrelated local changes.
- If real GitLab smoke cannot run due credentials or network, mark the smoke evidence as blocked with exact error output instead of treating it as passed.
