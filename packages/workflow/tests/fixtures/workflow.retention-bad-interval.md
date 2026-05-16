---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "retention/bad-interval"
  token_env: "ISSUEPILOT_TEST_TOKEN"
git:
  repo_url: "git@gitlab.example.com:retention/bad-interval.git"
retention:
  cleanup_interval_ms: 5000
---

prompt body
