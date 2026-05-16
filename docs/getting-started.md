# IssuePilot Quick Start

English | [简体中文](./getting-started.zh-CN.md)

This guide is for engineers running IssuePilot for the first time. The goal is to turn one GitLab Issue into a branch, a Merge Request, and an Issue handoff note.

Keep two repos separate:

- **IssuePilot repo**: where you build or download the local package.
- **Target project repo**: the product repo Codex will modify. This repo needs `WORKFLOW.md`.

```text
/path/to/issuepilot
  build package: pnpm release:pack

/path/to/target-project
  stores: WORKFLOW.md
  gets modified through IssuePilot-created worktrees

installed CLI
  run: issuepilot doctor / issuepilot run / issuepilot dashboard
```

> **What this guide covers**: the V1 single-project local loop (default entrypoint
> `issuepilot run --workflow ...`) **and** the V2 team-operable release whose
> Phases 1-5 are already merged into `main`: multi-project team config, dashboard
> retry / stop / archive, automatic CI-failure flip back to `ai-rework`, review
> feedback sweep, and workspace retention with automatic cleanup. V2 team-mode
> entrypoint, actions and constraints are concentrated in §13 Team mode.
>
> Prefer a visual version?
>
> - Architecture: [`docs/superpowers/diagrams/v2-architecture.svg`](./superpowers/diagrams/v2-architecture.svg)
> - End-to-end lifecycle: [`docs/superpowers/diagrams/v2-flow.svg`](./superpowers/diagrams/v2-flow.svg)

---

## 1. What IssuePilot Does

IssuePilot is a local, single-machine orchestrator. It:

1. Polls GitLab for Issues labeled `ai-ready`.
2. Creates one isolated git worktree per Issue under `~/.issuepilot`.
3. Starts `codex app-server` inside that worktree and lets Codex implement the Issue.
4. Pushes a branch, creates or updates an MR, and writes an Issue handoff note.
5. Moves the Issue from `ai-running` to `human-review`, `ai-failed`, or `ai-blocked`.
6. During `human-review` it periodically scans MR pipelines, sweeps reviewer
   comments, and prunes expired worktrees per retention policy (V2, see §13).

V1 is a single-project local developer tool. V2 adds a shared-team-machine
scenario on top of V1 without breaking the V1 entrypoint. Neither is SaaS, a
worker cluster, or an auto-merge system. Humans still review MRs before merging.
The stable local path is the installed `issuepilot` CLI. Source-checkout commands
remain available for contributors and emergency rollback.

---

## 2. Install IssuePilot

Run this in the **IssuePilot repo**:

```bash
corepack enable
pnpm install
pnpm release:pack
npm install -g ./dist/release/issuepilot-0.1.0.tgz
issuepilot doctor
```

Expected: `doctor` reports `[OK]` for Node.js, Git, Codex app-server, and `~/.issuepilot/state`.

Required tools:

| Tool      | Requirement                                          |
| --------- | ---------------------------------------------------- |
| Node.js   | `>=22 <23`                                           |
| pnpm      | `10.x`, preferably through corepack                  |
| Git       | `>=2.40`                                             |
| Codex CLI | must run `codex app-server` and already be logged in |
| GitLab    | a test project with API, label, Issue, and MR access |
| SSH key   | can push to the target project                       |

Contributor fallback:

```bash
pnpm build
pnpm exec issuepilot doctor
```

---

## 3. Prepare the Target GitLab Project

Do these steps in the GitLab project that IssuePilot will work on.

### 3.1 Create Workflow Labels

Create these labels:

| Label          | Meaning                                  |
| -------------- | ---------------------------------------- |
| `ai-ready`     | Candidate Issue; IssuePilot will pick it |
| `ai-running`   | Claimed and currently running            |
| `human-review` | MR is ready for human review             |
| `ai-rework`    | Human requested another AI pass          |
| `ai-failed`    | Run failed and needs investigation       |
| `ai-blocked`   | Missing info, permission, or secret      |

### 3.2 Confirm SSH Push Access

`workflow.git.repo_url` should normally use SSH. Git pushes use your local SSH key, not the GitLab API token.

```bash
ssh -T git@gitlab.example.com
```

If your company has multiple GitLab instances, check each one:

```bash
ssh -T git@gitlab.chehejia.com
ssh -T git@gitlabee.chehejia.com
```

---

## 4. Add `WORKFLOW.md`

Create `WORKFLOW.md` at the root of the **target project repo**, then commit it to the target project's default branch.
This step only creates the target project's config; do not start IssuePilot from the target project repo.

`WORKFLOW.md` is the default workflow path. Legacy `.agents/workflow.md` can still be passed explicitly with `--workflow`, but new projects should use the root file.

```bash
cd /path/to/target-project
$EDITOR WORKFLOW.md
```

After creating it, get its absolute path and copy that path. Later, when starting the daemon from the IssuePilot repo, `--workflow` receives this path:

```bash
WORKFLOW_PATH="$(pwd)/WORKFLOW.md"
echo "$WORKFLOW_PATH"

# macOS: copy to clipboard so you can paste it into later commands
printf "%s" "$WORKFLOW_PATH" | pbcopy
```

Minimal template:

```md
---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
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
2. Keep all work inside the provided workspace.
3. Implement the requested Issue changes.
4. Commit the changes and call `gitlab_create_merge_request` to create or update the MR.
5. Call `gitlab_create_issue_note` with implementation, validation, risks, and MR link.
6. Let the orchestrator move the Issue to `human-review` after success.
7. If blocked by missing info, permission, or secrets, call `gitlab_transition_labels` to set `ai-blocked` and explain why.
```

Commit the workflow:

```bash
git add WORKFLOW.md
git commit -m "chore(issuepilot): add workflow"
git push origin main
```

Key fields:

| Field                         | How to set it                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `tracker.kind`                | Always `gitlab`; do not use `gitlabee`                                                               |
| `tracker.base_url`            | GitLab instance URL, e.g. `https://gitlab.chehejia.com`                                              |
| `tracker.project_id`          | GitLab project path or numeric ID, e.g. `group/project`                                              |
| `tracker.token_env`           | Optional. Only set it when using an environment token; the value is the variable name, not the token |
| `git.repo_url`                | target project SSH clone URL                                                                         |
| `git.base_branch`             | MR target branch, usually `main` or `master`                                                         |
| `agent.max_concurrent_agents` | start with `1`; increase after the flow is stable                                                    |
| `codex.approval_policy`       | use `never` for P0                                                                                   |

Multiple GitLab instances still use the same `kind: gitlab`; distinguish them with `base_url`:

```yaml
# gitlab.chehejia.com
tracker:
  kind: gitlab
  base_url: "https://gitlab.chehejia.com"
  project_id: "group/project"

# gitlabee.chehejia.com
tracker:
  kind: gitlab
  base_url: "https://gitlabee.chehejia.com"
  project_id: "group/project"
```

---

## 5. Configure GitLab Credentials

IssuePilot supports two common paths. Use OAuth on personal dev machines. Use environment tokens for CI or shared team environments.

### 5.1 Option A: OAuth Login (Recommended)

Prerequisite: each GitLab instance needs an OAuth Application.

A GitLab admin creates the application:

- URL: `https://<gitlab-host>/admin/applications`
- Name: `IssuePilot`
- Confidential: unchecked; it must be a public application
- Scopes: `api`, `read_repository`, `write_repository`
- Enable Device Authorization Grant if GitLab shows that option
- Save and copy the **Application ID**. That is the `--client-id`

Then log in with the installed CLI:

```bash
issuepilot auth login --hostname gitlab.example.com --client-id <oauth-application-id>
issuepilot auth status --hostname gitlab.example.com
```

`--client-id` is the OAuth Application's public Application ID. It is not the Application Secret and not an Access Token.

If you use two company GitLab instances, log in to both hostnames:

```bash
issuepilot auth login --hostname gitlab.chehejia.com --client-id <oauth-application-id>
issuepilot auth login --hostname gitlabee.chehejia.com --client-id <oauth-application-id>
```

After login, tokens are stored in `~/.issuepilot/credentials` with mode `0600`. If you use OAuth login, do not set `tracker.token_env` in the workflow. Once `tracker.token_env` is present, the daemon requires that environment variable to exist.

### 5.2 Option B: Environment Token

If you already have a GitLab PAT, Group Access Token, Project Access Token, or `glab auth token`, export it before starting the daemon.

```bash
export GITLAB_TOKEN="<token>"
```

If you choose this path, add `token_env` to the workflow's `tracker` section. This is not part of the default template; it only applies to environment-token setups:

```yaml
tracker:
  base_url: "https://gitlab.chehejia.com"
  token_env: "GITLAB_TOKEN"

tracker:
  base_url: "https://gitlabee.chehejia.com"
  token_env: "GITLABEE_TOKEN"
```

Before starting the daemon:

```bash
export GITLAB_TOKEN="<gitlab.chehejia.com token>"
export GITLABEE_TOKEN="<gitlabee.chehejia.com token>"
```

Never put tokens in `WORKFLOW.md`, Issues, prompts, or logs.

---

## 6. Validate the Workflow

Run this from any shell after installing the CLI:

```bash
# If this is a new terminal, put the copied absolute path back into the variable.
export WORKFLOW_PATH="/path/to/target-project/WORKFLOW.md"
issuepilot validate --workflow "$WORKFLOW_PATH"
```

Successful output:

```text
Workflow loaded: /path/to/target-project/WORKFLOW.md
GitLab project: group/project
Validation passed.
```

Common failures:

| Error                                    | What to check                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowConfigError: tracker`           | front matter field names and YAML indentation                                                                                    |
| `WorkflowConfigError: tracker.token_env` | workflow sets `token_env`, but the daemon shell does not have that env var; export it, or remove `token_env` and use OAuth login |
| `GitLabError(category="auth")`           | token is wrong, expired, or OAuth credentials are missing                                                                        |
| `GitLabError(category="permission")`     | token lacks `api` scope or project access                                                                                        |

---

## 7. Start IssuePilot

Use two terminals.

### 7.1 Terminal A: Start the Orchestrator

```bash
export WORKFLOW_PATH="/path/to/target-project/WORKFLOW.md"
issuepilot run --workflow "$WORKFLOW_PATH" --port 4738 --host 127.0.0.1
```

Contributor source-checkout fallback:

```bash
cd /path/to/issuepilot
export WORKFLOW_PATH="/path/to/target-project/WORKFLOW.md"
pnpm exec issuepilot run --workflow "$WORKFLOW_PATH" --port 4738 --host 127.0.0.1
```

When ready, it prints the API URL. The default is:

```text
API: http://127.0.0.1:4738
```

### 7.2 Terminal B: Start the Dashboard

```bash
issuepilot dashboard
```

Open:

```text
http://localhost:3000
```

The dashboard defaults to `http://127.0.0.1:4738`. If the orchestrator uses another port, set:

```bash
issuepilot dashboard --api-url http://127.0.0.1:4839
```

If the page shows `IssuePilot orchestrator unreachable` / `fetch failed`, confirm Terminal A is still running and that the dashboard points at the same port.

---

## 8. Run the First Issue

In the target GitLab project:

1. Create a simple Issue, for example: “append `Hello from IssuePilot` to README”.
2. Add the `ai-ready` label.
3. Do not assign it to yourself; IssuePilot does not need an assignee.

After about 10 seconds, IssuePilot should:

1. Move the Issue to `ai-running`.
2. Show a new run in the dashboard.
3. Create a worktree and start Codex.
4. Push an `ai/<iid>-<slug>` branch.
5. Create a draft MR.
6. Write an Issue handoff note.
7. Move the Issue to `human-review`.

A human reviews the MR. To ask AI for another pass, move the Issue label to `ai-rework`.

---

## 9. How to Handle States

| Current label  | What you do                                                                |
| -------------- | -------------------------------------------------------------------------- |
| `ai-ready`     | wait for IssuePilot to pick it up                                          |
| `ai-running`   | watch the dashboard                                                        |
| `human-review` | review the MR in GitLab                                                    |
| `ai-rework`    | wait for IssuePilot to run another pass                                    |
| `ai-failed`    | read the failure note and dashboard timeline, then retry                   |
| `ai-blocked`   | provide missing info, permission, or secrets; then move back to `ai-ready` |

Failed runs are preserved. Forensics live at:

```bash
~/.issuepilot/state/logs/issuepilot.log
~/.issuepilot/state/events/<project-slug>-<iid>.jsonl
~/.issuepilot/state/runs/<project-slug>-<iid>.json
~/.issuepilot/workspaces/<project-slug>/<iid>/
```

---

## 10. Command Cheat Sheet

```bash
# Environment check
export WORKFLOW_PATH="/path/to/target-project/WORKFLOW.md"
issuepilot doctor

# OAuth login
issuepilot auth login --hostname <gitlab-host> --client-id <oauth-application-id>
issuepilot auth status --hostname <gitlab-host>
issuepilot auth logout --hostname <gitlab-host>

# Validate workflow
issuepilot validate --workflow "$WORKFLOW_PATH"

# Start orchestrator
issuepilot run --workflow "$WORKFLOW_PATH"

# Start dashboard
issuepilot dashboard
```

---

## 11. FAQ

**`codex app-server not found`**

Confirm Codex CLI is installed and logged in:

```bash
which codex
codex app-server --help
```

If Codex is not on PATH, set `codex.command` in the workflow to an absolute path.

**`auth login failed ... category=invalid_client`**

The GitLab instance has no matching OAuth Application, or Device Authorization Grant is disabled. Register the application, copy the Application ID, then run:

```bash
issuepilot auth login --hostname <host> --client-id <oauth-application-id>
```

**GitLab 401 / 403**

Check that the token is exported in the same shell that starts the daemon, has the `api` scope, and can access the target project. Restart the orchestrator after fixing it.

**Dashboard shows `orchestrator unreachable`**

The dashboard is only the frontend. Start the orchestrator in another terminal:

```bash
export WORKFLOW_PATH="/path/to/target-project/WORKFLOW.md"
issuepilot run --workflow "$WORKFLOW_PATH"
```

If the orchestrator is not on `4738`, set `NEXT_PUBLIC_API_BASE`.

**How do I know which run wrote an Issue note?**

The first line of the note contains:

```text
<!-- issuepilot:run:<runId> -->
```

The final handoff note starts with `## IssuePilot handoff` and includes the
branch, MR, implementation summary, validation, risks / follow-ups, and the
next action for the human reviewer.

---

## 12. Next Steps

- V2 architecture & flow diagrams: [`docs/superpowers/diagrams/`](./superpowers/diagrams/)
- Architecture details: [`docs/superpowers/specs/2026-05-11-issuepilot-design.md`](./superpowers/specs/2026-05-11-issuepilot-design.md)
- V2 master spec & Phase 1-5 progress: [`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`](./superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md)
- Workspace cleanup runbook: [`docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md`](./superpowers/runbooks/2026-05-15-workspace-cleanup.md)
- Full smoke runbook: [`docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`](./superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md)
- Recent changes: [`CHANGELOG.md`](../CHANGELOG.md)

---

## 13. V2 Team Mode: Multiple Projects on One Shared Machine

V2 keeps the V1 `--workflow` single-project entrypoint intact and adds a
`--config` team-mode entrypoint plus four capabilities wired to it: dashboard
actions, CI-failure flip-back, review feedback sweep, and workspace retention
with automatic cleanup. This section concentrates the entrypoint, what each
capability does, and where its limits live.

### 13.1 Entrypoint Comparison

| Use case | When | Command |
| --- | --- | --- |
| V1 single project | Personal workstation; one daemon serves one project | `issuepilot run --workflow /path/to/WORKFLOW.md` |
| V2 team mode | Shared box; one daemon manages several GitLab projects; lease-protected against double-claim | `issuepilot run --config /path/to/issuepilot.team.yaml` |

`--workflow` and `--config` are mutually exclusive — passing both prints an
error and exits.

### 13.2 Minimal Team Config

```yaml
version: 1

server:
  host: 127.0.0.1
  port: 4738

scheduler:
  max_concurrent_runs: 2
  max_concurrent_runs_per_project: 1
  lease_ttl_ms: 900000
  poll_interval_ms: 10000

projects:
  - id: platform-web
    name: Platform Web
    workflow: /srv/repos/platform-web/WORKFLOW.md
    enabled: true
  - id: infra-tools
    name: Infra Tools
    workflow: /srv/repos/infra-tools/WORKFLOW.md
    enabled: true

# Optional: team-level CI defaults; per-project ci can override
ci:
  enabled: true
  on_failure: ai-rework        # or human-review
  wait_for_pipeline: true

# Optional: team-level workspace retention defaults
retention:
  successful_run_days: 7
  failed_run_days: 30
  max_workspace_gb: 50
  cleanup_interval_ms: 3600000
```

Constraints (violations fail startup and surface the exact dotted path):

- `version` is fixed to `1`.
- `scheduler.max_concurrent_runs`: 1..5; anything higher refuses to start.
- `scheduler.lease_ttl_ms`: at least `60_000`.
- `projects[].id`: lowercase letters, digits, hyphens; must be unique within
  the file.
- Relative `workflow` paths resolve against the directory containing the
  config file.

Each `projects[].workflow` must point at a valid `WORKFLOW.md`. The team
config **does not** copy GitLab labels / prompt / hooks from any workflow;
those still come from each project's own `WORKFLOW.md`.

### 13.3 Validate and Start

```bash
# Validate before launching (no GitLab calls, no daemon start)
issuepilot validate --config /path/to/issuepilot.team.yaml

# Start the team daemon
issuepilot run --config /path/to/issuepilot.team.yaml
```

`validate --config` runs the same `loadTeamConfig` pipeline as daemon
startup; YAML and zod errors are reported by dotted path (for example
`scheduler.lease_ttl_ms`).

The dashboard starts the same way as in V1; point it at the same
`--api-url`:

```bash
issuepilot dashboard --api-url http://127.0.0.1:4738
```

In V2 mode the dashboard shows a top-level `Projects` section listing each
project in team-config order. Disabled projects (`enabled: false`) show a
neutral `disabled` badge; projects whose workflow failed to load show a red
`load error` badge with a short summary.

### 13.4 Phase 2: Dashboard Retry / Stop / Archive

The dashboard exposes three buttons on the runs list and detail page. Every
action writes an `operator_action_*` event to the event store, visible in
the detail timeline and via `/api/events?runId=<runId>`.

| Action | Allowed run states | Behaviour | Notes |
| --- | --- | --- | --- |
| Retry | `ai-failed`, `ai-blocked`, `ai-rework`, archived failed run | Flips the issue label back to `ai-rework`; the dashboard run goes back to `claimed` | The V2 team daemon does not wire this yet — the route returns `503 actions_unavailable`. Use the V1 entrypoint to exercise retry today |
| Stop | active `ai-running` run | Cancels the Codex turn via `turn/interrupt`; after a 5s timeout the run flips to the `stopping` middle state and eventually converges through `turnTimeoutMs` | Does not touch GitLab labels directly; failures emit `operator_action_failed { code: cancel_timeout / cancel_threw / not_registered }` |
| Archive | terminal run (`completed` / `failed` / `blocked`) | Stamps `archivedAt` on the run record so the dashboard hides it from the default list | A `Show archived` toggle reveals history |

Operator identity defaults to the server-side fallback `"system"`; the HTTP
`x-issuepilot-operator` header is reserved for the V3 RBAC integration.

### 13.5 Phase 3: CI Status Flip-Back

Set `ci.enabled` in `WORKFLOW.md` or in the team config and the orchestrator
will poll the MR pipeline status on each `poll_interval_ms` tick while the
run is in `human-review`:

```yaml
ci:
  enabled: true
  on_failure: ai-rework         # or human-review
  wait_for_pipeline: true
```

Status matrix:

| Pipeline | `on_failure` | Behaviour |
| --- | --- | --- |
| `success` | — | Stays in `human-review`; dashboard marks ready for review |
| `failed` | `ai-rework` | Flips label to `ai-rework` and writes a note tagged `<!-- issuepilot:ci-feedback:<runId> -->` |
| `failed` | `human-review` | Keeps labels; only writes a marker note and emits `ci_status_observed { action: "noop" }` |
| `running` / `pending` / `unknown` | — | Stays in `human-review`, waits for the next poll, does not write a note |
| `canceled` / `skipped` | — | Writes a marker note prompting human review and emits `ci_status_observed { action: "manual" }` |

Constraints:

- The scanner is wired into the main loop only at daemon start;
  **changing `ci.enabled` requires restarting `issuepilot run`** for the
  change to take effect.
- Precedence: `projects[].ci` > team `ci` > workflow `ci`. Override must
  set all three keys together — partial overrides are not supported.
- Automatic merging remains out of V2 scope.

### 13.6 Phase 4: Review Feedback Sweep

On each poll while the issue is in `human-review`, the orchestrator scans
the MR for human comments (auto-skipping GitLab system notes and its own
marker notes), structures them into a `ReviewFeedbackSummary`, and writes
that back onto the run record.

- The dashboard run detail view adds a `Latest review feedback` panel
  showing the MR link, last sweep time, each comment's author / time /
  resolved badge / truncated body, plus deep links back to the MR note.
- When a human flips the issue to `ai-rework`, the next dispatch prepends
  a standardised `## Review feedback` markdown block to the prompt; each
  reviewer body is wrapped in
  `<<<REVIEWER_BODY id=N>>> ... <<<END_REVIEWER_BODY>>>` envelopes to
  defang prompt injection.
- Always on; runs without an MR or comments are no-ops and need no
  workflow toggle.
- Does not trigger auto-merge and does not replace Phase 3 CI flip-back.

### 13.7 Phase 5: Workspace Retention with Auto Cleanup

Default retention policy (overridable under the workflow or team config
top-level `retention` block):

| Run state | Default retention |
| --- | --- |
| active / running / stopping / claimed / retrying | Never auto-cleaned |
| successful / closed | 7 days |
| failed / blocked | 30 days |
| archived terminal | Counts by the original terminal-state retention |

Constraints:

- When total workspace exceeds `max_workspace_gb` (default 50) **only**
  already-expired terminal runs may be cleaned; capacity pressure cannot
  delete active runs or unexpired failure scenes.
- Failed worktrees keep their `.issuepilot/failed-at-*` markers; markers
  are kept by default.
- Cleanup is a three-stage event sequence:
  `workspace_cleanup_planned` → `workspace_cleanup_completed`
  / `workspace_cleanup_failed`, scoped to the sentinel
  `runId=workspace-cleanup`. Inspect via
  `/api/events?runId=workspace-cleanup` or the dashboard timeline.
- **Limitation: the V2 team daemon parses the `retention` schema but does
  not run the cleanup loop yet.** To get auto cleanup in team-machine
  scenarios today, launch each project through the V1 entrypoint
  (`issuepilot run --workflow ...`); the team-mode wiring is tracked as a
  Phase 5 follow-up.

#### Dry-run preview

You can preview what would be cleaned without starting a daemon:

```bash
issuepilot doctor --workspace --workflow /path/to/target-project/WORKFLOW.md
```

Example output (without a daemon the run state is unreadable, so all
directories default to `unknown` and the planner refuses to delete; real
previews should tail `workspace_cleanup_planned` events):

```text
Workspace cleanup dry-run
  workspace root: ~/.issuepilot/workspaces
  entries: 14
  total usage: 2.471 GB (cap 50 GB)
  will delete: 0
  keep failure markers: 3
```

#### Runbook

For incident scenarios (accidental delete, cleanup failure triage,
temporary cleanup disable), see:
[`docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md`](./superpowers/runbooks/2026-05-15-workspace-cleanup.md).

### 13.8 V2 Boundaries

The V2 trunk is done, but the following items are **explicitly out of
V2 scope** and live in V3 / V4:

- Multi-user RBAC, token / budget / quota policy.
- Remote workers, Docker / K8s sandboxes.
- Auto-merge, cross-issue dependency planning, auto-decomposition.
- Postgres / SQLite as a hard dependency for long-term run history.
- Pluggable trackers; non-GitLab issue trackers.
- Remote `ai/*` branch cleanup and automatic MR archival.
