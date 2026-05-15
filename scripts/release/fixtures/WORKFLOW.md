---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"

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
  max_turns: 3
  max_attempts: 1
  retry_backoff_ms: 1000

codex:
  command: "codex app-server"
  approval_policy: never
  thread_sandbox: workspace-write
  turn_timeout_ms: 60000
  turn_sandbox_policy:
    type: workspaceWrite

poll_interval_ms: 10000
---

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
URL: {{ issue.url }}

{{ issue.description }}
