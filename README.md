# IssuePilot

[English](README.md) | [简体中文](README.zh-CN.md)

> Engineering project management today still means babysitting coding agents:
> tracking task progress, chasing PRs, checking CI, and manually shepherding
> validation back and forth — coordination is sliced up across "what is the
> agent doing right now?".
>
> **IssuePilot turns project work into isolated, autonomous implementation
> runs, so teams can manage the work instead of supervising the coding
> agent.** Every GitLab issue becomes a bounded run: its own worktree, its
> own prompt, its own event stream, and an auditable trail of work — handed
> back as a merge request for human review instead of asking engineers to sit
> in every agent turn.

IssuePilot is an open-source local orchestrator for GitLab issue driven AI
engineering work.

It watches GitLab issues, claims work through labels, creates isolated git
worktrees, runs Codex through the app-server protocol, records an auditable event
trail, and hands the result back as a merge request for human review.

### Highlights

- **Issue-driven work claim** — watches a GitLab issue board and auto-claims
  issues labelled `ai-ready` into isolated runs, instead of hand-dispatching
  tasks to agents.
- **Full proof of work** — every run produces a CI status, an MR description
  with review links, a reconciliation event trail, a JSONL event store, and a
  live dashboard timeline.
- **Trustworthy handoff boundary** — failures and blocks fall back to
  `ai-failed` / `ai-blocked` while the workspace and logs are preserved for
  forensics; secrets never leak into logs, events, API responses, or prompts.
- **Local single-machine loop** — `~/.issuepilot` keeps the worktrees, JSONL
  event store, and run records on disk; the daemon recovers reconciliation on
  restart without requiring an external database.
- **Complements harness engineering** — designed for mature repos that already
  ship an agent harness; IssuePilot focuses on scheduling and isolation while
  `.agents/workflow.md` in your repo owns the prompt and policy.
- **Open SPEC + reference implementation** — `SPEC.md` and the Symphony Elixir
  reference implementation remain in the repository, so teams can build their
  own variants in other languages from the same contract.

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

## How IssuePilot Compares to OpenAI Symphony

IssuePilot started as a fork of OpenAI Symphony, so the **overall architecture
is shared lineage**: both treat the issue tracker as the control plane, isolate
each agent run in a per-issue workspace, drive Codex through the app-server
protocol, version the workflow policy as a repo-owned file, and recover on
restart through tracker + filesystem signals instead of an external database.

The differences live in **what we are optimizing for** and **how we implement
it**:

| Dimension       | OpenAI Symphony (reference, Elixir)                             | IssuePilot (the direction in this repo)                                                            |
| --------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Positioning     | Public prototype; recommended to fork and harden internally     | Internal P0 product direction; targeting day-to-day use by an engineering team                     |
| Issue tracker   | Linear                                                          | GitLab (SaaS and self-managed, Group Access Token or Personal Token)                               |
| State machine   | Linear issue **status** (state-based)                           | GitLab **labels** (`ai-ready` / `ai-running` / `human-review` / …)                                 |
| Workflow file   | `WORKFLOW.md` at the repo root                                  | `.agents/workflow.md` (YAML front matter + Markdown prompt)                                        |
| Language        | Elixir / OTP                                                    | TypeScript / Node.js 22 LTS                                                                        |
| Runtime         | Single Elixir service + optional status surface                 | Orchestrator daemon (Fastify) + read-only Next.js dashboard (Tailwind/shadcn)                      |
| Workspace       | Per-issue workspace                                             | Bare mirror + git worktree under `~/.issuepilot/{repos,workspaces,state}`                          |
| Events / logs   | Structured logs + optional status surface                       | JSONL event store + atomic run records + SSE live stream + pino structured logging                 |
| MR / PR writes  | Performed by the agent through workflow-defined tools           | Adapter pushes / opens MRs directly, with orchestrator post-run reconciliation as a fallback       |
| Restart recovery | Tracker + filesystem driven                                    | Driven by labels + workpad note marker (`<!-- issuepilot:run=<runId> -->`)                         |
| Security stance | Each implementation declares its own trust posture              | Rejects `danger-full-access` sandboxes, redacts tokens end-to-end, pins Codex cwd to the worktree  |
| Open SPEC       | `SPEC.md` v1 (language-agnostic)                                | `SPEC.md` retained as reference; product spec lives in `docs/superpowers/specs/`                   |
| Status          | Evaluation-only prototype; harden before production use         | P0 active development; fake E2E green and real GitLab smoke passing                                |

If you want the Linear + Elixir reference implementation, jump straight to
[`elixir/`](elixir/README.md) and [`SPEC.md`](SPEC.md). If you want the
GitLab + TypeScript variant and plan to pilot it inside a team, the IssuePilot
implementation at the root of this repository is the version you're looking
for.

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

## Roadmap

The IssuePilot roadmap lives in
[`docs/superpowers/specs/2026-05-11-issuepilot-design.md`](docs/superpowers/specs/2026-05-11-issuepilot-design.md)
§20 — the section below is a summary so you can quickly see what's usable today
and where the project is heading.

### V1 / P0 — Local single-machine loop (current)

In active development; large parts are already usable in this repository:

- ✅ Local daemon (orchestrator) with a Fastify HTTP API + SSE.
- ✅ GitLab issue label state machine (`ai-ready` → `ai-running` →
  `human-review` / `ai-failed` / `ai-blocked` / `ai-rework`).
- ✅ Codex app-server runner (thread/turn lifecycle + 14 normalized event
  types).
- ✅ Bare mirror + git worktree workspace; failed runs preserved in place.
- ✅ Automatic MR create/update + persistent workpad note + fallback note.
- ✅ Read-only Next.js dashboard (overview + run detail + SSE timeline).
- ✅ Fake GitLab + fake Codex end-to-end harness + real GitLab smoke runbook.
- 🚧 Public packaging, versioned releases, install/upgrade paths.

### V2 — Team-operable release

Goal: graduate from "single machine" to "shared team machine" so a team can
run IssuePilot on its day-to-day work.

- Deployable to a shared team box or intranet service (multi-user friendly).
- Multi-project workflow configuration in a single daemon.
- Concurrency lifted from 1 to 2–5, with slot scheduling and lease policy.
- Dashboard gains `retry`, `stop`, and `archive run` actions.
- CI status ingestion + automatic flip of CI failures back to `ai-rework`.
- MR / PR review feedback sweep (feed human review comments back into the
  next agent turn).
- Richer run reports: diff summary, test results, risk callouts, timing
  breakdown.
- Workspace cleanup and retention policy (by age / size / status).

### V3 — Productionized execution platform

Goal: become an internal "AI engineering execution platform" with proper
permissions, budgets, and observability.

- Pluggable workers: local, SSH worker, and container worker.
- Docker / Kubernetes sandboxes (replacing the single-host sandbox model).
- Token / time / concurrency / cost budgets.
- Permission model: project, team, and admin scopes.
- Webhook + poll hybrid scheduling to cut polling latency.
- Stronger GitLab audit + end-to-end secret redaction.
- Postgres / SQLite run history (replacing single-host JSONL storage).
- OpenTelemetry / Loki / Grafana, or your internal observability stack.

### V4 — Intelligent engineering workbench

Goal: go beyond "one issue, one run" and become a workbench for engineering
processes.

- Auto-decomposition of large issues into orchestrated sub-tasks.
- Cross-issue dependency and blocker analysis.
- Multi-agent collaboration with a dedicated reviewer agent.
- Auto-generated acceptance evidence: screenshots, recordings, Playwright
  walkthrough videos.
- Quality metrics: agent success rate, rework rate, CI pass rate, review hit
  rate.
- Workflow / skills recommendation and continuous-improvement loop.
- More runners, e.g. Claude Code or your internal coding agent.

> The roadmap evolves with the project. Every meaningful change is reflected
> in the design spec and `CHANGELOG.md` in the same PR — treat the design
> spec as the source of truth.

## Documentation

- **[Getting Started (English)](docs/getting-started.md)** — First time running IssuePilot? Start here. Walks you from clone to your first end-to-end run in ~30 minutes.
- [使用指南（中文）](docs/getting-started.zh-CN.md) — Chinese getting-started guide.
- [IssuePilot real GitLab smoke runbook](docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md) — Real GitLab + Codex end-to-end acceptance checklist.
- [IssuePilot design spec](docs/superpowers/specs/2026-05-11-issuepilot-design.md) — Architecture, protocols, state machine.
- [IssuePilot implementation plan](docs/superpowers/plans/2026-05-11-issuepilot-implementation-plan.md) — The 8-phase implementation plan and task breakdown.
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
