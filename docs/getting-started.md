# IssuePilot Getting Started

English | [简体中文](./getting-started.zh-CN.md)

This guide is for engineers running IssuePilot for the first time. It tells you **what to do after you've cloned this repo**. In ~30 minutes you should be able to:

1. Prepare the local runtime;
2. Configure `.agents/workflow.md` in your target GitLab project;
3. Start the orchestrator daemon + dashboard;
4. Label a GitLab Issue with `ai-ready` and watch IssuePilot take over end-to-end (code → branch push → merge request → issue note).

> This is the product-level "how to use it" doc. For the full end-to-end smoke validation (real GitLab + real Codex), pair this with [`docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`](./superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md) §18.3.

---

## 1. What it is

IssuePilot is a **local, single-machine** orchestrator:

- Polls GitLab and claims Issues with the `ai-ready` label;
- Creates an isolated git worktree per Issue under `~/.issuepilot/`;
- Drives Codex via the app-server JSON-RPC protocol inside that worktree;
- Pushes a branch, creates/updates a merge request, writes a handoff note;
- Communicates outcomes via labels (`ai-running` → `human-review` / `ai-failed` / `ai-blocked`);
- Ships with a read-only dashboard showing run timeline, tool calls, and recent logs.

P0 is **not** SaaS, multi-tenant, or clustered — it is a daemon on one dev machine plus a static dashboard. The goal is to let an AI engineer take the first pass on well-described Issues so humans review a merge request instead of supervising every agent turn.

---

## 2. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | `>=22 <23` | `.npmrc` enables engine-strict |
| pnpm | `10.x` | `packageManager: pnpm@10.x`; use corepack |
| Git | `>=2.40` | Real git CLI called through `execa` |
| Codex CLI | any version exposing `codex app-server` | must be logged in |
| GitLab | instance + sandbox project | Group/Project Access Token with `api`, `read_repository`, `write_repository` |
| SSH key | able to push to the target project | `repo_url` uses SSH form `git@host:group/proj.git` |

Run a one-shot environment check:

```bash
corepack enable
pnpm install
pnpm -F @issuepilot/orchestrator build
pnpm exec issuepilot doctor
```

Expect all `[OK]`: Node.js, git, codex app-server, `~/.issuepilot/state` writable.

---

## 3. Prepare the GitLab project

In the target GitLab project:

### 3.1 Create labels

Create at least these six labels (any colour):

| Label | Meaning |
|---|---|
| `ai-ready` | Candidate Issue, IssuePilot will pick it up |
| `ai-running` | Claimed and being executed |
| `human-review` | MR is ready, awaiting human review |
| `ai-rework` | Human requested another AI pass after review |
| `ai-failed` | Run failed, requires human intervention |
| `ai-blocked` | Missing info / permission / secret, parked for humans |

### 3.2 Create an access token

Settings → Access Tokens:

- Name: `issuepilot-local` (any)
- Role: `Maintainer` (needs branch push, label edits, note write, MR create)
- Scopes: `api`, `read_repository`, `write_repository`
- Copy the token — you'll set it as `GITLAB_TOKEN` below

### 3.3 SSH credentials for push

`workflow.git.repo_url` uses SSH form. IssuePilot pushes through the local `~/.ssh` setup, **not** via the token over HTTPS.

```bash
ssh -T git@gitlab.example.com  # should recognise you
```

---

## 4. Add `.agents/workflow.md` to the target project

`.agents/workflow.md` is the contract between IssuePilot and the target repository. It has two parts:

- **YAML front matter** — machine-readable configuration (tracker, workspace, git, agent, codex).
- **Markdown body** — Liquid template that gets rendered into the prompt for Codex.

Put it in the **target project's** git repo (not the IssuePilot repo) at exactly `.agents/workflow.md`.

Minimal working template:

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
  rework_label: ai-rework

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

poll_interval_ms: 10000
---

You are the AI engineer for this repository.

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
URL: {{ issue.url }}

Description:
{{ issue.description }}

Requirements:
1. Read the relevant code before editing.
2. Confine your work to the provided workspace.
3. Implement what the Issue describes.
4. Commit your changes and create/update an MR via `gitlab_create_merge_request`.
5. Post a handoff note on the Issue via `gitlab_create_issue_note` covering implementation, validation, risks, and the MR link.
6. Let the orchestrator transition the Issue to `human-review` on success.
7. If you're blocked on info/permission/secrets, call `gitlab_transition_labels` to set `ai-blocked` and explain why.
```

### 4.1 Key fields

| Field | Meaning |
|---|---|
| `tracker.token_env` | IssuePilot **does not** read this variable's value at parse time — it reads `process.env[name]` at runtime. **Never put the token in the workflow file.** |
| `tracker.active_labels` | Candidate labels. Default `["ai-ready", "ai-rework"]`. |
| `git.base_branch` | MR target branch. Falls back to the GitLab project's default branch if unset. |
| `git.branch_prefix` | Branch naming prefix. Final branch is `<prefix>/<issue-iid>-<title-slug>`. |
| `agent.max_attempts` | Total attempts per Issue. `retryable` errors retry automatically; exhaustion moves to `ai-failed`. |
| `codex.approval_policy` | `never` = orchestrator auto-approves Codex's approval requests and emits `approval_auto_approved`. Other values are described in spec §6. |
| `codex.thread_sandbox` / `codex.turn_sandbox_policy.type` | Codex sandbox levels. **`danger-full-access` / `dangerFullAccess` are rejected by the schema validator.** |
| `poll_interval_ms` | GitLab poll cadence, default `10000`. |

Push `.agents/workflow.md` to the target project's `main`:

```bash
cd /path/to/target-project
mkdir -p .agents
$EDITOR .agents/workflow.md   # paste the template, update values
git add .agents/workflow.md
git commit -m "chore(issuepilot): seed workflow.md"
git push origin main
```

---

## 5. Start IssuePilot

### 5.0 Provide credentials

IssuePilot accepts GitLab credentials from three sources, **resolved in this order of precedence**:

| Source | When to use | Token origin |
| --- | --- | --- |
| `issuepilot auth login` (recommended) | Personal dev machine; don't want to manage PATs by hand | Built-in OAuth 2.0 Device Flow, auto-refresh, stored at `~/.issuepilot/credentials` (mode `0600`) |
| `.env` + [direnv](https://direnv.net/) | Team or CI environments; already have a PAT/Group Token | `cd` into the dir auto-exports env vars, auto-unsets on exit |
| `glab auth token` bridge | Already using [glab CLI](https://gitlab.com/gitlab-org/cli) | `export GITLAB_TOKEN=$(glab auth token -h <host>)` |

> The daemon first reads the env var named in `tracker.token_env`; if unset it falls back to `~/.issuepilot/credentials`. Tokens are always redacted from events, logs, the dashboard, and prompts.

#### A. `issuepilot auth login` (recommended)

```bash
pnpm exec issuepilot auth login --hostname gitlab.example.com
# Follow the prompt to enter user_code in your browser. Token is persisted automatically.
pnpm exec issuepilot auth status   # Show login state and token expiry
pnpm exec issuepilot auth logout   # Remove local credentials
```

#### B. `.env` + direnv

```bash
brew install direnv     # macOS; other platforms: https://direnv.net/
cp .env.example .env    # Edit .env, set GITLAB_TOKEN=glpat-xxx
echo 'dotenv' > .envrc && direnv allow .
echo $GITLAB_TOKEN      # Verify it's loaded
```

> Both `.env` and `.envrc` are listed in `.gitignore` — they will not be committed.

#### C. glab CLI bridge

```bash
glab auth login --hostname gitlab.example.com   # Browser-based OAuth
export GITLAB_TOKEN=$(glab auth token --hostname gitlab.example.com)
```

> glab issues `gloas-...` OAuth tokens; these and hand-rolled `glpat-...` PATs are equivalent at the GitLab API. IssuePilot passes them straight through `@gitbeaker/rest` — no distinction needed.

---

### 5.1 Prepare the IssuePilot repo

```bash
cd /path/to/issuepilot
pnpm install
pnpm -w turbo run build
```

You **must** build before the first run — `pnpm smoke` boots `apps/orchestrator/dist/bin.js`.

### 5.2 Validate the workflow (recommended)

Run a static + GitLab-connectivity check before starting the daemon:

```bash
# Skip if §5.0 credentials are already in place; otherwise export ad-hoc:
# export GITLAB_TOKEN="<your token>"
pnpm exec issuepilot validate --workflow /path/to/target-project/.agents/workflow.md
```

Expected output:

```text
Workflow loaded: /path/to/target-project/.agents/workflow.md
GitLab project: group/project
Validation passed.
```

Common failures:

- `WorkflowConfigError: tracker` → front matter missing fields / wrong types.
- `WorkflowConfigError: tracker.token_env` → `process.env.GITLAB_TOKEN` is unset.
- `GitLabError(category="auth")` → token wrong or expired.
- `GitLabError(category="permission")` → token lacks the `api` scope or the target project is not visible to it.

### 5.3 Start the daemon

**Terminal A** (orchestrator):

```bash
# Skip if §5.0 credentials are already in place; otherwise export ad-hoc:
# export GITLAB_TOKEN="<token>"
pnpm smoke --workflow /path/to/target-project/.agents/workflow.md
```

Successful output:

```text
[smoke] starting orchestrator daemon on 127.0.0.1:4738…
======================================================
 IssuePilot daemon ready
------------------------------------------------------
 API:        http://127.0.0.1:4738
 Dashboard:  http://localhost:3000
 Workflow:   /path/to/target-project/.agents/workflow.md
 Project:    group/project
 Poll every: 10000ms
 Concurrency:1
------------------------------------------------------
 Walk through the §18.3 smoke checklist now. Press Ctrl+C to stop.
======================================================
```

`Ctrl+C` exits the daemon gracefully. If readiness probing fails, the smoke wrapper SIGTERMs and escalates to SIGKILL within 5 seconds — it will **never hang**.

> If you don't want the smoke wrapper: `node apps/orchestrator/dist/bin.js run --workflow <path> [--port 4738] [--host 127.0.0.1]`.

**Terminal B** (dashboard):

```bash
pnpm dev:dashboard
```

Open `http://localhost:3000`. You should see the ServiceHeader (status / project / concurrency / pollIntervalMs / lastPollAt), the SummaryCards (running / retrying / human-review / failed / blocked), and an empty RunsTable.

> Port collision: `pnpm smoke --workflow ... --port 4839 --dashboard-url http://localhost:3000`.

---

## 6. Run your first Issue

In the target GitLab project:

1. Create a simple Issue, e.g. "append `Hello from IssuePilot` to README.md".
2. Add the `ai-ready` label.
3. **Don't** assign yourself (IssuePilot doesn't need an assignee).

After about `poll_interval_ms` (default 10s):

- The dashboard `/` shows a new row in RunsTable, status `claimed` → `running`.
- Open `/runs/<runId>` and watch the timeline grow:
  - `run_started`
  - `claim_succeeded`
  - `workspace_ready` (worktree ready)
  - `session_started` (Codex app-server up)
  - `turn_started` → `tool_call_started` → `tool_call_completed` (Codex calling `gitlab_*` tools)
  - `gitlab_push` (branch pushed)
  - `gitlab_mr_created` (MR opened)
  - `gitlab_note_created` (handoff note posted)
  - `gitlab_labels_transitioned` (label moves from `ai-running` → `human-review`)
  - `run_completed`
- On GitLab: branch `ai/<iid>-<slug>` exists, a draft MR is open, the Issue has a handoff note from IssuePilot, the label is now `human-review`.
- Terminal A streams structured logs.

The whole flow is hands-off. Afterwards a human reviews the MR and decides to merge or request `ai-rework`.

---

## 7. What each label means for you

| Current label | Meaning | What you do |
|---|---|---|
| `ai-ready` | Candidate | Nothing — wait for IssuePilot to claim it |
| `ai-running` | Claimed | Watch the dashboard |
| `human-review` | MR awaiting review | Review the MR in GitLab; merge to complete, or relabel to `ai-rework` to ask for changes |
| `ai-rework` | Human asked for another pass | Wait for IssuePilot to pick it up again (treated like `ai-ready`) |
| `ai-failed` | Run failed | Read IssuePilot's failure note on the Issue; check dashboard timeline; fix the root cause; manually move the label back to `ai-ready` or `ai-rework` |
| `ai-blocked` | Missing info / permission / secret | Read the note for what's missing; resolve it; move label back to `ai-ready` |

> `ai-rework` is **not** an alias of `ai-ready` — it's a distinct human-driven state. IssuePilot treats both as candidate sources by default (`active_labels`).

---

## 8. Forensics for failed workspaces

Failed runs are **never deleted**.

```bash
ls ~/.issuepilot/workspaces/<project-slug>/<iid>/
# .issuepilot/failed-at-<iso>.json holds the failure context
```

Event streams persist too:

```bash
~/.issuepilot/state/events/<project-slug>-<iid>.jsonl   # full IssuePilotEvent JSONL
~/.issuepilot/state/runs/<project-slug>-<iid>.json      # latest RunRecord
~/.issuepilot/state/logs/issuepilot.log                 # daemon structured logs
```

Investigation flow:

1. On the dashboard `/runs/<runId>`, find the **first** red event in the timeline.
2. Grep `~/.issuepilot/state/logs/issuepilot.log` by `runId` for surrounding context.
3. Reproduce in the worktree: `cd ~/.issuepilot/workspaces/<project-slug>/<iid>/ && git status`.
4. Fix the root cause (token scope, prompt, workflow.md, etc.).
5. Relabel the Issue back to `ai-ready` in GitLab to retry.

---

## 9. Advanced usage

### 9.1 Workflow hot reload

Changes to `.agents/workflow.md` **do not** require restarting the daemon. The orchestrator uses `fs.watch` + `stat` polling:

- Parse succeeds → next tick uses the new config (dashboard ServiceHeader's `lastConfigReloadAt` updates).
- Parse fails → last-known-good is retained; daemon does not crash; the error lands in `~/.issuepilot/state/logs/issuepilot.log`.

### 9.2 Tuning the retry strategy

`agent.max_attempts` controls total attempts per Issue. Errors classify into:

- **blocked** (e.g. 401/403) — labels move to `ai-blocked`, **no retry**.
- **failed** (e.g. logic errors) — labels move to `ai-failed`, **no retry**.
- **retryable** (e.g. `turn/timeout`, 5xx, network) — emits `retry_scheduled`, waits `retryBackoffMs`, retries; on exhaustion converts to `failed`.

Set `max_attempts: 1` to disable retries (useful for smoke / cost control).

### 9.3 Approval policy

| Value | Meaning |
|---|---|
| `never` | Orchestrator auto-approves every Codex approval request, emitting `approval_auto_approved`. |
| `untrusted` / `on-request` | See spec §6 (P0 mostly uses `never`). |

### 9.4 Hooks

`hooks.after_create` / `hooks.before_run` / `hooks.after_run` are bash strings run via `bash -lc` from the worktree cwd. Examples:

```yaml
hooks:
  before_run: |
    git diff --cached --quiet || git commit -m "wip(issuepilot): snapshot before AI run"
  after_run: |
    test -f .agents/post-checks.sh && bash .agents/post-checks.sh
```

A non-zero exit raises `HookFailedError` and routes the run to `ai-failed`. Each of stdout/stderr is capped at 1 MB and tagged `[truncated]` beyond that.

### 9.5 Containers / remote machines

`--host` defaults to `127.0.0.1`. For containers:

```bash
pnpm smoke --workflow ... --host 0.0.0.0 --dashboard-url http://your-host:3000
```

Also set `NEXT_PUBLIC_API_BASE=http://your-host:4738` for the dashboard so the browser doesn't fall back to `127.0.0.1:4738`.

### 9.6 Concurrency

`agent.max_concurrent_agents` controls concurrent slots. Each slot gets its own worktree and Codex child process. P0 recommends starting at `1` and increasing once stable.

---

## 10. CLI cheat sheet

```bash
# Prerequisite check
pnpm exec issuepilot doctor

# Static + GitLab connectivity validation
pnpm exec issuepilot validate --workflow <path>

# Start the daemon
pnpm exec issuepilot run --workflow <path> [--port 4738] [--host 127.0.0.1]

# Recommended: smoke wrapper waits for readiness automatically
pnpm smoke --workflow <path> [--port 4738] [--host 127.0.0.1] [--dashboard-url http://localhost:3000]

# Dashboard only (dev)
pnpm dev:dashboard
```

HTTP API endpoints (default `http://127.0.0.1:4738`, see spec §15):

```text
GET /api/state                    # OrchestratorStateSnapshot
GET /api/runs?status=&limit=      # RunRecord[]
GET /api/runs/:runId              # RunRecord & { events, logsTail }
GET /api/events?runId=            # IssuePilotEvent[] (paginated)
GET /api/events/stream            # text/event-stream (SSE)
```

---

## 11. FAQ

- **`pnpm exec issuepilot doctor` says codex app-server not found.**
  `codex app-server` must be invokable. Run `which codex`, then set `command: "/Users/xxx/.local/bin/codex app-server"` in workflow.md.

- **`Could not resolve remote.origin` / git push hangs.**
  The workspace mirror is created with `git clone --mirror`, but pushes cannot run in mirror mode. This repo already fixes that in `packages/workspace/src/mirror.ts` (sets `remote.origin.mirror=false` + explicit refspec). If it still hangs, `rm -rf ~/.issuepilot/repos/<slug>` to force re-clone.

- **GitLab 401/403.**
  Most common: `GITLAB_TOKEN` wasn't exported into the daemon process; token lacks `api` scope; token has no visibility on the project. After fixing the token, **restart** the daemon.

- **Dashboard stays empty / CORS errors.**
  The dashboard talks to `http://127.0.0.1:4738` by default — must match `--host`. For containers/remote, see §9.5.

- **`pnpm smoke` hangs on readiness.**
  When readiness probing fails, the smoke wrapper SIGTERMs the daemon and escalates to SIGKILL within 5 seconds — the command always returns control (never an infinite hang).

- **How do I know which run wrote a given note?**
  Every IssuePilot note's first line is `<!-- issuepilot:run=<runId> -->`. The same run reuses the note; different runs create new ones.

- **How do I cancel a run?**
  P0 has no cancel endpoint. Relabel the Issue away from `ai-running` in GitLab (e.g. to `ai-blocked`) and the orchestrator will observe the mismatch on the next reconcile tick and stop processing it; the workspace is preserved for forensics.

---

## 12. Next steps

- Read [`docs/superpowers/specs/2026-05-11-issuepilot-design.md`](./superpowers/specs/2026-05-11-issuepilot-design.md) for the architecture and protocol details.
- Walk through [`docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`](./superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md) for a full smoke run.
- See [`CHANGELOG.md`](../CHANGELOG.md) for recent updates.
- Run a few more Issues on your sandbox, including the failed / blocked paths.

**Always human-review the MR before merging.** IssuePilot is not a replacement for code review — it just lets the AI engineer do the heavy lifting first.
