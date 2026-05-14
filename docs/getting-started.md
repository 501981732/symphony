# IssuePilot Quick Start

English | [简体中文](./getting-started.zh-CN.md)

This guide is for engineers running IssuePilot for the first time. The goal is to turn one GitLab Issue into a branch, a Merge Request, and an Issue handoff note.

Keep two repos separate:

- **IssuePilot repo**: where you install, authenticate, and run the orchestrator + dashboard.
- **Target project repo**: the product repo Codex will modify. This repo needs `.agents/workflow.md`.

```text
/path/to/issuepilot
  run: pnpm smoke / pnpm dev:dashboard / pnpm exec issuepilot ...

/path/to/target-project
  stores: .agents/workflow.md
  gets modified through IssuePilot-created worktrees
```

---

## 1. What IssuePilot Does

IssuePilot is a local, single-machine orchestrator. It:

1. Polls GitLab for Issues labeled `ai-ready`.
2. Creates one isolated git worktree per Issue under `~/.issuepilot`.
3. Starts `codex app-server` inside that worktree and lets Codex implement the Issue.
4. Pushes a branch, creates or updates an MR, and writes an Issue handoff note.
5. Moves the Issue from `ai-running` to `human-review`, `ai-failed`, or `ai-blocked`.

P0 is a local developer tool. It is not SaaS, not a worker cluster, and not an auto-merge system. Humans still review MRs before merging.

---

## 2. Prepare Your Machine

Run this in the **IssuePilot repo**:

```bash
corepack enable
pnpm install
pnpm -F @issuepilot/orchestrator build
pnpm exec issuepilot doctor
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

## 4. Add `.agents/workflow.md`

Create `.agents/workflow.md` at the root of the **target project repo**, then commit it to the target project's default branch.
This step only creates the target project's config; do not start IssuePilot from the target project repo.

```bash
cd /path/to/target-project
mkdir -p .agents
$EDITOR .agents/workflow.md
```

After creating it, get its absolute path and copy that path. Later, when starting the daemon from the IssuePilot repo, `--workflow` receives this path:

```bash
WORKFLOW_PATH="$(pwd)/.agents/workflow.md"
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
git add .agents/workflow.md
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

Then log in from the **IssuePilot repo**:

```bash
pnpm exec issuepilot auth login --hostname gitlab.example.com --client-id <oauth-application-id>
pnpm exec issuepilot auth status --hostname gitlab.example.com
```

`--client-id` is the OAuth Application's public Application ID. It is not the Application Secret and not an Access Token.

If you use two company GitLab instances, log in to both hostnames:

```bash
pnpm exec issuepilot auth login --hostname gitlab.chehejia.com --client-id <oauth-application-id>
pnpm exec issuepilot auth login --hostname gitlabee.chehejia.com --client-id <oauth-application-id>
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

Never put tokens in `.agents/workflow.md`, Issues, prompts, or logs.

---

## 6. Validate the Workflow

Run this in the **IssuePilot repo**:

```bash
cd /path/to/issuepilot
# If this is a new terminal, put the copied absolute path back into the variable.
export WORKFLOW_PATH="/path/to/target-project/.agents/workflow.md"
pnpm exec issuepilot validate --workflow "$WORKFLOW_PATH"
```

Successful output:

```text
Workflow loaded: /path/to/target-project/.agents/workflow.md
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

Recommended: use the smoke wrapper, which waits until the daemon is ready.

```bash
cd /path/to/issuepilot
export WORKFLOW_PATH="/path/to/target-project/.agents/workflow.md"
pnpm smoke --workflow "$WORKFLOW_PATH"
```

Direct start also works:

```bash
cd /path/to/issuepilot
export WORKFLOW_PATH="/path/to/target-project/.agents/workflow.md"
pnpm exec issuepilot run --workflow "$WORKFLOW_PATH" --port 4738 --host 127.0.0.1
```

When ready, it prints the API URL. The default is:

```text
API: http://127.0.0.1:4738
```

### 7.2 Terminal B: Start the Dashboard

```bash
cd /path/to/issuepilot
pnpm dev:dashboard
```

Open:

```text
http://localhost:3000
```

The dashboard defaults to `http://127.0.0.1:4738`. If the orchestrator uses another port, set:

```bash
NEXT_PUBLIC_API_BASE=http://127.0.0.1:4839 pnpm dev:dashboard
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
cd /path/to/issuepilot
export WORKFLOW_PATH="/path/to/target-project/.agents/workflow.md"
pnpm exec issuepilot doctor

# OAuth login
pnpm exec issuepilot auth login --hostname <gitlab-host> --client-id <oauth-application-id>
pnpm exec issuepilot auth status --hostname <gitlab-host>
pnpm exec issuepilot auth logout --hostname <gitlab-host>

# Validate workflow
pnpm exec issuepilot validate --workflow "$WORKFLOW_PATH"

# Start orchestrator
pnpm smoke --workflow "$WORKFLOW_PATH"
pnpm exec issuepilot run --workflow "$WORKFLOW_PATH"

# Start dashboard
pnpm dev:dashboard
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
pnpm exec issuepilot auth login --hostname <host> --client-id <oauth-application-id>
```

**GitLab 401 / 403**

Check that the token is exported in the same shell that starts the daemon, has the `api` scope, and can access the target project. Restart the orchestrator after fixing it.

**Dashboard shows `orchestrator unreachable`**

The dashboard is only the frontend. Start the orchestrator in another terminal:

```bash
cd /path/to/issuepilot
export WORKFLOW_PATH="/path/to/target-project/.agents/workflow.md"
pnpm smoke --workflow "$WORKFLOW_PATH"
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

- Architecture details: [`docs/superpowers/specs/2026-05-11-issuepilot-design.md`](./superpowers/specs/2026-05-11-issuepilot-design.md)
- Full smoke runbook: [`docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`](./superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md)
- Recent changes: [`CHANGELOG.md`](../CHANGELOG.md)
