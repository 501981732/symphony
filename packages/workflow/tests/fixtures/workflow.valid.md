---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
  token_env: "ISSUEPILOT_TEST_TOKEN"
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
