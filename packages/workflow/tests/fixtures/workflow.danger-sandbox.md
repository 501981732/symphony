---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
  token_env: "ISSUEPILOT_TEST_TOKEN"
git:
  repo_url: "git@gitlab.example.com:group/project.git"
codex:
  thread_sandbox: danger-full-access
  turn_sandbox_policy:
    type: dangerFullAccess
---

danger prompt
