# IssuePilot Design Spec

Date: 2026-05-11
Status: Draft for user review
Repository context: this repository is a fork of OpenAI Symphony and is used as the protocol/reference source for IssuePilot.

## 1. Purpose

IssuePilot is an internal AI engineering orchestrator inspired by Symphony.

The product goal is to turn GitLab Issues into isolated, observable Codex implementation runs. Engineers manage Issue state and review Merge Requests instead of supervising individual agent sessions.

The first version must prove one complete loop:

```text
GitLab Issue with ai-ready label
  -> IssuePilot claims it
  -> isolated git worktree is prepared
  -> Codex app-server runs in that worktree
  -> code is changed and committed
  -> branch is pushed
  -> Merge Request is created or updated
  -> Issue is commented
  -> Issue moves to human-review
```

## 2. Reference Model

This project should not directly port the Elixir implementation.

Use this fork as reference for:

- the language-agnostic service boundary in `SPEC.md`
- workflow-file based configuration
- isolated per-issue workspaces
- orchestrator ownership of scheduling state
- Codex app-server JSON-RPC lifecycle
- dashboard/event observability concepts

Do not inherit the Elixir-specific implementation as production architecture.

IssuePilot will be implemented as a TypeScript product with GitLab and Codex app-server as first-class P0 integrations.

## 3. Non-Goals for P0

P0 must avoid broad platform scope.

Out of scope:

- multi-tenant permissions
- remote worker pools
- Kubernetes sandboxing
- visual workflow builders
- automatic merge to default branch
- Claude Code runner
- arbitrary GitLab REST/GraphQL tool access
- rich operational controls in the dashboard
- long-term analytics database

The system may reserve extension points for these, but P0 should not implement them.

## 4. Technology Choices

### 4.1 Runtime and Monorepo

Use:

- TypeScript
- Node.js 22 LTS
- pnpm workspaces
- Turborepo where useful for local developer workflow
- Vitest for tests
- ESLint and Prettier for code quality

### 4.2 Applications

```text
apps/
  orchestrator/
    Local daemon and CLI. Owns polling, dispatch, Codex app-server sessions,
    GitLab writes, event storage, and the orchestration API.

  dashboard/
    Next.js App Router dashboard. Reads from the orchestrator API and SSE
    stream. It is not responsible for background work.
```

Do not put the orchestrator inside Next.js. The orchestrator is a long-running worker process that manages child processes, stdio JSON-RPC, git worktrees, timers, retries, and filesystem state. Next.js should be used for the operator UI only.

### 4.3 Packages

```text
packages/
  core/
    Domain models, scheduler state, orchestration contracts, event types.

  workflow/
    .agents/workflow.md parsing, validation, defaults, env resolution,
    and prompt rendering.

  tracker-gitlab/
    GitLab Issue, label, note, Merge Request, and pipeline adapter.

  workspace/
    Bare mirror management, git worktree lifecycle, branch preparation,
    path safety, and hooks.

  runner-codex-app-server/
    Codex app-server JSON-RPC client over stdio.

  observability/
    Event store, JSONL logs, run snapshots, pino logger wiring.

  shared-contracts/
    Types shared by orchestrator and dashboard.
```

### 4.4 Libraries

Recommended libraries:

- CLI: `commander` or `cac`
- HTTP API: Fastify or Hono inside `apps/orchestrator`
- Dashboard: Next.js App Router
- UI: Ant Design or Tailwind/shadcn, with final choice based on team preference
- Logging: `pino`
- Config validation: `zod`
- Workflow parsing: `gray-matter` plus YAML parser
- Prompt templating: `liquidjs`
- Process execution: `execa`
- GitLab API: `@gitbeaker/rest`
- Local event storage: JSON and JSONL files

Use the Git CLI through `execa` for mirror, worktree, fetch, push, and branch operations. Avoid JS git libraries for P0 because worktree behavior should match real developer tooling.

Do not use a database in P0. Use local files under `~/.issuepilot/state`.

## 5. Product Shape

P0 is a local daemon:

```bash
pnpm issuepilot run --workflow .agents/workflow.md --port 4738
```

The command starts:

- the orchestrator loop
- Codex app-server runner management
- local JSON/JSONL event storage
- a local API server
- a Next.js dashboard at `http://127.0.0.1:4738`

The dashboard is read-only in P0.

## 6. Workflow Contract

Each target repository owns its agent contract:

```text
.agents/workflow.md
```

The file uses YAML front matter for machine-readable configuration and Markdown body for the agent prompt.

Example:

```md
---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
  token_env: "GITLAB_TOKEN"
  active_labels:
    - ai-ready
    - ai-rework
  running_label: ai-running
  handoff_label: human-review
  failed_label: ai-failed
  blocked_label: ai-blocked

workspace:
  root: "~/.issuepilot/workspaces"
  strategy: worktree
  repo_cache_root: "~/.issuepilot/repos"

git:
  repo_url: "git@gitlab.example.com:group/project.git"
  base_branch: main
  branch_prefix: ai

agent:
  runner: codex-app-server
  max_concurrent_agents: 1
  max_turns: 10
  max_attempts: 2
  retry_backoff_ms: 30000

codex:
  command: "codex app-server"
  approval_policy: never
  thread_sandbox: workspace-write
  turn_timeout_ms: 3600000
  turn_sandbox_policy:
    type: workspaceWrite

hooks:
  after_create: |
    pnpm install
  before_run: |
    git fetch origin
  after_run: |
    pnpm test
---

You are the AI engineer for this repository.

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
URL: {{ issue.url }}

Description:
{{ issue.description }}

Requirements:
1. Read the relevant code before editing.
2. Keep work inside the provided workspace.
3. Implement the issue.
4. Run required validation.
5. Commit the changes.
6. Create or update a GitLab Merge Request.
7. Update the Issue with implementation notes, validation, risks, and MR URL.
8. On success, move the Issue to human-review.
9. If blocked by missing information, permissions, or secrets, mark ai-blocked.
```

Required template variables:

```text
{{ issue.id }}
{{ issue.iid }}
{{ issue.identifier }}
{{ issue.title }}
{{ issue.description }}
{{ issue.labels }}
{{ issue.url }}
{{ issue.author }}
{{ issue.assignees }}
{{ attempt }}
{{ workspace.path }}
{{ git.branch }}
```

Workflow loading rules:

- startup parse failure exits the process
- runtime reload failure keeps the last-known-good workflow
- runtime reload errors are surfaced in dashboard and logs
- env-backed secrets are resolved at runtime and never written to event logs

## 7. GitLab State Model

P0 uses GitLab labels as the workflow state machine.

Labels:

```text
ai-ready       Candidate task, available for IssuePilot.
ai-running     Claimed and currently being executed.
human-review   MR exists and human review is required.
ai-rework      Human requested changes; IssuePilot may run again.
ai-merging     Reserved for future merge automation.
ai-failed      Execution failed and human attention is needed.
ai-blocked     Execution cannot continue without external input.
```

P0 transitions:

```text
ai-ready -> ai-running -> human-review
ai-ready -> ai-running -> ai-failed
ai-ready -> ai-running -> ai-blocked
ai-rework -> ai-running -> human-review
ai-rework -> ai-running -> ai-failed
ai-rework -> ai-running -> ai-blocked
```

`ai-merging` is reserved for P1/P2. P0 never automatically merges.

Mapping to the Symphony reference:

```text
Symphony Linear state     IssuePilot GitLab label
Todo                      ai-ready
In Progress               ai-running
Human Review              human-review
Rework                    ai-rework
Merging                   ai-merging
Done/Closed/Cancelled     GitLab issue closed or terminal team label
```

Claim behavior:

1. Fetch candidate open issues with `ai-ready` or `ai-rework`.
2. Skip issues with `ai-running`, `human-review`, `ai-failed`, or `ai-blocked`.
3. Re-read the issue just before claim.
4. Replace active label with `ai-running`.
5. Re-read to confirm the claim.
6. Continue only if the issue still belongs to this run.

This gives a pragmatic optimistic concurrency strategy for local P0.

## 8. Orchestrator

The orchestrator owns scheduling state. It should not contain GitLab API details, worktree implementation details, or app-server protocol internals.

Main loop:

```text
1. Reload workflow.
2. Reconcile running issues.
3. Fetch candidate GitLab issues.
4. Sort by priority, updated_at, then iid.
5. Check available concurrency slots.
6. Claim issue.
7. Prepare workspace and branch.
8. Run hooks.
9. Start Codex app-server runner.
10. Observe events.
11. Run post-run reconciliation.
12. Transition labels and write final events.
13. Schedule retry when appropriate.
```

P0 default concurrency:

```yaml
agent:
  max_concurrent_agents: 1
```

The internal runtime state should include:

```text
running
claimed
retrying
completed
failed
blocked
last_config_reload
last_poll
```

The orchestrator state is in-memory. Restart recovery comes from GitLab labels and preserved workspaces, not from replaying all timers.

## 9. Workspace and Git Strategy

P0 default strategy is bare mirror plus git worktree.

Filesystem layout:

```text
~/.issuepilot/
  repos/
    <project-slug>.git/              # bare mirror
  workspaces/
    <project-slug>/
      <issue-iid>/                   # issue worktree
  state/
    orchestrator.json
    runs/
    events/
    logs/
```

Workspace is the orchestration concept: an isolated directory assigned to one issue. The implementation uses git worktree to make that directory efficient.

Mirror flow:

```text
ensureMirror()
  if mirror is missing:
    git clone --mirror <repo_url> <repo-cache-path>
  else:
    git --git-dir=<repo-cache-path> fetch --prune origin
```

Worktree flow:

```text
ensureWorktree(issue)
  branch = ai/<issue-iid>-<title-slug>
  git --git-dir=<mirror> worktree add <workspace> -B <branch> origin/<base_branch>
```

If the workspace already exists:

- verify it is under the configured workspace root
- verify it belongs to the expected project and branch
- fetch latest origin state
- reuse it when safe
- mark failed if the git state is not safely recoverable

Safety requirements:

- Codex cwd must be the issue worktree, never the source repository or `~/.issuepilot`
- path canonicalization must prevent symlink escape
- hooks run inside the workspace only
- branch names and paths must be sanitized
- failed workspaces are preserved for inspection

Branch naming:

```text
ai/<issue-iid>-<title-slug>
```

## 10. Codex App-Server Runner

P0 uses Codex app-server, not Codex CLI.

Runner responsibilities:

```text
1. Start `codex app-server` in the issue workspace.
2. Send initialize.
3. Send initialized.
4. Send thread/start with cwd, sandbox, approval policy, and dynamic tools.
5. Send turn/start with rendered prompt, title, cwd, and sandbox policy.
6. Read newline-delimited JSON-RPC messages from stdout/stderr stream.
7. Handle completion, failure, cancellation, timeout, and port exit.
8. Handle approval requests.
9. Execute dynamic tool calls.
10. Emit normalized events for the orchestrator and dashboard.
11. Continue turns up to max_turns while issue is still active.
```

Required app-server events:

```text
session_started
turn_started
notification
tool_call_started
tool_call_completed
tool_call_failed
unsupported_tool_call
approval_auto_approved
approval_required
turn_input_required
turn_completed
turn_failed
turn_cancelled
turn_timeout
port_exit
malformed_message
```

Approval policy:

```yaml
codex:
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
```

If app-server requests user input, P0 auto-responds with:

```text
This is a non-interactive IssuePilot run. Operator input is unavailable. If blocked, record the blocker and mark the issue ai-blocked.
```

The runner must not silently hang waiting for human input.

## 11. GitLab Dynamic Tools

P0 exposes a narrow GitLab tool allowlist to Codex app-server.

Tools:

```text
gitlab_get_issue
gitlab_update_issue_labels
gitlab_create_issue_note
gitlab_update_issue_note
gitlab_create_merge_request
gitlab_update_merge_request
gitlab_get_merge_request
gitlab_list_merge_request_notes
gitlab_get_pipeline_status
```

Do not expose arbitrary GitLab REST or GraphQL in P0.

Tool rules:

- all writes are recorded as events
- token values are never exposed to the model or logs
- tool errors return structured failure payloads
- unsupported tools fail fast and do not stall the runner
- tool schemas are explicit JSON schemas passed in `thread/start`

The GitLab tools should let the agent perform normal ticket handoff. The orchestrator still performs deterministic post-run reconciliation.

## 12. Post-Run Reconciliation

Codex app-server `turn/completed` is not sufficient to mark success.

After runner completion, the orchestrator verifies:

```text
1. Worktree has commit(s) or an intended no-code-change result.
2. Branch exists locally.
3. Branch is pushed to GitLab.
4. Merge Request exists for source branch.
5. Issue has a handoff note or updated workpad.
6. Issue labels moved from ai-running to human-review.
```

If the agent completed code changes but missed platform actions, the orchestrator attempts to fix them:

```text
agent committed but did not push       -> orchestrator pushes
branch pushed but no MR exists         -> orchestrator creates MR
MR exists but body/title is stale       -> orchestrator updates MR
no final Issue note exists             -> orchestrator writes fallback note
labels are stale                       -> orchestrator transitions labels
```

Fallback MR title:

```text
[AI] <issue title>
```

Fallback MR body includes:

```text
Issue link
Implementation summary
Validation summary
Risks
Generated by IssuePilot
```

If reconciliation fails, the run becomes `ai-failed` unless the reason is a true external blocker.

## 13. Failure and Blocked Classification

Blocked:

```text
GitLab token missing
GitLab 403 permission denied
repo clone or push permission missing
Codex auth unavailable
required secret missing
issue lacks required information and agent explicitly reports blocker
```

Failed:

```text
Codex turn failed
Codex turn timeout
app-server process exits unexpectedly
hook failure that prevents execution
tests fail after max_turns
MR creation fails after retry
workspace git state is not safely recoverable
```

Retryable:

```text
GitLab 5xx
GitLab rate limit
network timeout
transient git fetch/push failure
app-server startup failure
```

P0 retry defaults:

```yaml
agent:
  max_attempts: 2
  retry_backoff_ms: 30000
```

After retry exhaustion, write a concise Issue note and set `ai-failed`.

## 14. Dashboard

P0 dashboard uses Next.js and talks to the orchestrator API.

Default URL:

```text
http://127.0.0.1:4738
```

P0 dashboard is read-only.

Views:

```text
Service header
  service status
  workflow path
  GitLab project
  poll interval
  concurrency
  last config reload

Summary
  running
  retrying
  human-review
  failed
  blocked

Runs table
  issue iid
  title
  labels
  runner status
  turn count
  last event
  elapsed time
  branch
  MR link
  workspace path

Run detail
  timeline
  thread_id
  turn_id
  tool calls
  approval events
  token usage when available
  failure reason
  recent logs
```

No P0 dashboard controls:

```text
no start button
no stop button
no retry button
no label mutation
no workspace deletion
```

These can be added after the run loop is proven stable.

## 15. Orchestrator API

The orchestrator exposes local APIs for dashboard and debugging.

```text
GET /api/state
GET /api/runs
GET /api/runs/:runId
GET /api/events?runId=<runId>
GET /api/events/stream
```

`/api/events/stream` uses SSE for live updates.

The API binds to `127.0.0.1` by default.

## 16. Observability Storage

Use local file storage:

```text
~/.issuepilot/state/
  orchestrator.json
  runs/
    <project-slug>-<issue-iid>.json
  events/
    <project-slug>-<issue-iid>.jsonl
  logs/
    issuepilot.log
```

Event shape:

```ts
type IssuePilotEvent = {
  id: string;
  runId: string;
  issue: {
    id: string;
    iid: number;
    title: string;
    url: string;
  };
  type: string;
  message: string;
  data?: unknown;
  createdAt: string;
};
```

Logging requirements:

- every event has `runId`
- every issue event has GitLab project and issue iid
- every app-server event with session context has `threadId` and `turnId`
- secrets are redacted
- GitLab write operations are logged as structured events

## 17. Security Posture

P0 is intended for trusted local/internal environments.

Required controls:

- Codex runs only in the issue worktree
- workspace path is canonicalized and checked against configured root
- app-server turn sandbox is workspace scoped
- GitLab token is read from env
- token is never rendered into prompt, event data, dashboard, or logs
- dashboard binds to localhost by default
- GitLab dynamic tools use a narrow allowlist
- hooks run in workspace only
- automatic approvals are limited by workspace sandbox

P0 does not provide strong hostile-code sandboxing. If the company requires stronger isolation, add Docker or Kubernetes worker isolation as a later phase.

## 18. Testing Strategy

### 18.1 Unit Tests

Workflow:

- front matter parsing
- default values
- env resolution
- invalid YAML
- prompt rendering
- missing required config

GitLab adapter:

- candidate issue listing
- label claim
- label transition
- Issue note create/update
- MR create/update
- pipeline status
- 403/404/5xx classification

Workspace:

- mirror initialization
- mirror fetch
- worktree creation
- existing worktree reuse
- branch sanitize
- symlink/path escape prevention
- hook success/failure

Codex app-server runner:

- initialize/initialized
- thread/start
- turn/start
- turn/completed
- turn/failed
- turn/cancelled
- approval request auto handling
- user input auto response
- supported tool call
- unsupported tool call
- malformed line
- timeout
- port exit

Orchestrator:

- candidate selection
- duplicate claim prevention
- retry backoff
- blocked classification
- failed classification
- success reconciliation
- stale label cleanup

Dashboard/API:

- `/api/state`
- `/api/runs`
- `/api/runs/:runId`
- SSE event delivery

### 18.2 Integration Tests

Use fake GitLab and fake Codex app-server.

Scenario:

```text
1. Fake GitLab exposes one open ai-ready issue.
2. IssuePilot claims the issue.
3. Workspace creates a worktree.
4. Fake Codex emits tool calls and turn/completed.
5. IssuePilot pushes/creates MR through fake GitLab.
6. Issue ends with human-review.
7. Event store contains a complete timeline.
```

### 18.3 Real Smoke Test

Use a disposable GitLab project.

Acceptance:

```text
1. Create a small issue, such as README wording change.
2. Add ai-ready.
3. Start IssuePilot locally.
4. Verify worktree creation.
5. Verify Codex app-server run.
6. Verify branch push.
7. Verify MR creation.
8. Verify Issue note.
9. Verify label human-review.
10. Verify dashboard timeline.
```

## 19. Milestones

M1: TypeScript skeleton

- pnpm workspace
- orchestrator app
- dashboard app
- shared packages
- test tooling

M2: Workflow loader

- parse `.agents/workflow.md`
- validate config
- render prompt
- hot reload with last-known-good fallback

M3: GitLab adapter

- issue list
- label transitions
- notes
- MR creation/update
- pipeline read

M4: Workspace manager

- bare mirror
- worktree creation
- branch preparation
- path safety
- hooks

M5: Codex app-server runner

- JSON-RPC lifecycle
- approval handling
- dynamic GitLab tools
- event emission
- turn continuation

M6: Orchestrator

- poll
- claim
- dispatch
- retry
- reconciliation
- status snapshots

M7: Dashboard

- Next.js UI
- orchestrator API integration
- SSE timeline
- run detail

M8: End-to-end validation

- fake GitLab + fake Codex test
- real GitLab smoke test
- documentation for local use

## 20. MVP Definition of Done

P0 is done when:

```text
1. A GitLab Issue with ai-ready is picked up automatically.
2. IssuePilot changes the Issue to ai-running.
3. A per-issue git worktree is created under ~/.issuepilot/workspaces.
4. Codex app-server starts in that worktree.
5. The rendered workflow prompt includes issue and workspace context.
6. Codex can call allowlisted GitLab dynamic tools.
7. Code changes are committed.
8. Branch is pushed to GitLab.
9. Merge Request is created or updated.
10. Issue receives a handoff note.
11. Labels move to human-review on success.
12. Labels move to ai-failed or ai-blocked on failure/blocker.
13. Dashboard shows run timeline, app-server session details, MR link, and logs.
14. Failed runs preserve workspace and event logs for debugging.
```

## 21. Open Decisions

These should be confirmed before implementation planning:

1. Dashboard UI kit: Ant Design or Tailwind/shadcn.
2. Orchestrator HTTP server: Fastify or Hono.
3. GitLab authentication shape: personal token, project token, or bot user token.
4. MR target branch policy: always workflow `git.base_branch`, or GitLab project default branch fallback.
5. Whether IssuePilot should create a persistent workpad note or a final summary note only in P0.

## 22. Implementation Notes

Suggested command shape:

```bash
issuepilot run --workflow .agents/workflow.md --port 4738
issuepilot validate --workflow .agents/workflow.md
issuepilot doctor
```

Suggested local development commands:

```bash
pnpm dev:orchestrator
pnpm dev:dashboard
pnpm test
pnpm lint
```

The implementation plan should start with contracts and fake E2E tests before integrating real GitLab and real Codex app-server.
