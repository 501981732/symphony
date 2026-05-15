---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "ci/bad"
  token_env: "ISSUEPILOT_TEST_TOKEN"
git:
  repo_url: "git@gitlab.example.com:ci/bad.git"
ci:
  enabled: true
  on_failure: ai-failed
---

prompt body
