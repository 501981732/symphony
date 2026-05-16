---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "retention/project"
  token_env: "ISSUEPILOT_TEST_TOKEN"
git:
  repo_url: "git@gitlab.example.com:retention/project.git"
retention:
  successful_run_days: 1
  failed_run_days: 60
  max_workspace_gb: 100
  cleanup_interval_ms: 120000
---

prompt body
