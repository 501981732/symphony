# IssuePilot

[English](README.md) | [简体中文](README.zh-CN.md)

IssuePilot is an open-source local orchestrator for GitLab issue driven AI
engineering work.

It watches GitLab issues, claims work through labels, creates isolated git
worktrees, runs Codex through the app-server protocol, records an auditable event
trail, and hands the result back as a merge request for human review.

The project started as a fork of OpenAI Symphony. The current product direction
is TypeScript-first and GitLab-first; the original Symphony spec and Elixir
implementation remain in this repository as reference material.

> [!WARNING]
> IssuePilot is in active P0 development. The package APIs, CLI behavior, and
> workflow file format may change before the first stable release.

## Why IssuePilot?

Coding agents are most useful when they can work from the same units of work
that engineers already manage. IssuePilot treats an issue tracker as the control
plane:

- Engineers describe work in GitLab issues.
- Labels express state: ready, running, review, rework, failed, or blocked.
- Each run happens in its own worktree under `~/.issuepilot`.
- Codex receives a scoped prompt and a restricted workspace.
- The orchestrator writes events, logs, issue notes, branches, and merge
  requests.
- Humans review the MR instead of supervising every agent turn.

The P0 goal is a local single-machine loop, not a hosted multi-tenant service.

## Current Status

Implemented in this repository:

- TypeScript monorepo with pnpm, Turborepo, Vitest, ESLint, and Prettier.
- Workflow parsing, validation, defaulting, env checks, and prompt rendering.
- GitLab adapter boundaries for issues, labels, notes, merge requests, and
  pipelines.
- Git workspace management using real `git` commands through `execa`.
- Codex app-server JSON-RPC client pieces and dynamic GitLab tool contracts.
- Observability primitives: redaction, event bus, event store, run store, and
  logger.
- Orchestrator modules for claim, dispatch, retry, reconcile, runtime state,
  HTTP API, SSE, and CLI scaffolding.
- Read-only dashboard with overview and run detail views, SSE refresh, timeline,
  tool calls, and log tail rendering.
- End-to-end test harness (`tests/e2e`) with a stateful fake GitLab + scriptable
  fake Codex app-server, covering the happy path, retry path
  (`turn/timeout` → ai-failed after `max_attempts`), failure path
  (`turn/failed` → ai-failed + workpad failure note), permission/escalation path
  (claim 401/403 → ai-blocked + `claim_failed` event), and approval auto-approve
  path. 34 e2e cases run in ~10s.
- Real GitLab smoke runbook + `pnpm smoke` wrapper that boots the orchestrator,
  polls `/api/state` until ready, prints API + dashboard URLs, and forwards
  SIGINT/SIGTERM with a hard 5s SIGKILL escalation.

Still stabilizing:

- Public packaging and versioned releases.

## How It Works

```text
GitLab issue has ai-ready label
  -> IssuePilot claims it with ai-running
  -> IssuePilot creates or reuses an isolated worktree
  -> Codex app-server runs inside that worktree
  -> Code is committed and pushed to a branch
  -> A GitLab merge request is created or updated
  -> The issue receives a handoff note
  -> Labels move to human-review, ai-failed, or ai-blocked
```

P0 labels:

| Label | Meaning |
| --- | --- |
| `ai-ready` | Candidate issue that IssuePilot can pick up. |
| `ai-running` | Claimed issue with an active run. |
| `human-review` | MR is ready for human review. |
| `ai-rework` | Human requested another AI pass after review. |
| `ai-failed` | Run failed and needs human intervention. |
| `ai-blocked` | Missing information, permission, or secret. |

## Repository Layout

```text
apps/
  orchestrator/                  Local daemon, CLI, HTTP API, and run loop
  dashboard/                     Read-only Next.js dashboard

packages/
  core/                          Shared domain primitives
  workflow/                      .agents/workflow.md parser and renderer
  tracker-gitlab/                GitLab issue, label, note, MR, pipeline adapter
  workspace/                     Mirror, worktree, branch, hook, and cleanup logic
  runner-codex-app-server/       Codex app-server JSON-RPC integration
  observability/                 Redaction, events, run store, and logging
  shared-contracts/              Types shared by orchestrator and dashboard

docs/superpowers/
  specs/                         Product and architecture specs
  plans/                         Implementation plans

elixir/                          Original Symphony reference implementation
SPEC.md                          Original language-agnostic Symphony spec
```

## Requirements

- Node.js `>=22 <23`
- pnpm `10.x`
- Git
- A GitLab project and token for real runs
- Codex with app-server support for real runs

The root `.npmrc` enables strict engine checks.

## Development Setup

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
```

Useful commands:

```bash
pnpm build
pnpm lint
pnpm format:check
pnpm --filter @issuepilot/workflow test
pnpm --filter @issuepilot/orchestrator test
```

The CLI is still being wired for full daemon execution. After building, the
current scaffolded checks can be exercised through the orchestrator package:

```bash
pnpm build
node apps/orchestrator/dist/cli.js doctor
node apps/orchestrator/dist/cli.js validate --workflow path/to/workflow.md
```

## Workflow File

IssuePilot expects each target repository to provide an agent contract file:

```text
.agents/workflow.md
```

The file contains YAML front matter for machine-readable configuration and a
Markdown body used as the agent prompt.

Minimal shape:

```md
---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
  token_env: "GITLAB_TOKEN"
  active_labels: ["ai-ready", "ai-rework"]
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

poll_interval_ms: 10000
---

You are the AI engineer for this repository.

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
URL: {{ issue.url }}

{{ issue.description }}
```

Secrets are read from the environment variable named by `tracker.token_env`.
They must not be committed into workflow files.

## Security Model

IssuePilot is designed for trusted local development environments.

Important P0 boundaries:

- GitLab tokens are read from environment variables.
- Token-like values are redacted before being written to logs, events, stores,
  or API responses.
- Codex runs with a workflow-defined sandbox, but workflow files cannot request
  `danger-full-access` or `dangerFullAccess`.
- The Codex working directory is limited to the current issue worktree.
- Failed runs preserve workspace data and event logs for debugging.

Review generated code before merging it. IssuePilot creates reviewable merge
requests; it does not replace code review.

## Documentation

- [IssuePilot design spec](docs/superpowers/specs/2026-05-11-issuepilot-design.md)
- [IssuePilot implementation plan](docs/superpowers/plans/2026-05-11-issuepilot-implementation-plan.md)
- [Original Symphony spec](SPEC.md)
- [Elixir reference implementation](elixir/README.md)

## Contributing

Contributions are welcome while the project is still early. The most useful
contributions right now are:

- Bug reports with exact commands, logs, and environment details.
- Tests that tighten workflow, GitLab, workspace, runner, or orchestrator
  contracts.
- Documentation fixes that make local setup easier to reproduce.
- Focused PRs that keep TypeScript implementation work separate from design
  spec updates.

Before opening a PR, run the checks relevant to your change:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

For changes that affect product behavior, architecture, workflow labels, runner
behavior, or roadmap scope, update the IssuePilot design spec in the same PR.

## License

IssuePilot is licensed under the [Apache License 2.0](LICENSE).
