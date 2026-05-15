---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "ci/enabled"
  token_env: "ISSUEPILOT_TEST_TOKEN"
git:
  repo_url: "git@gitlab.example.com:ci/enabled.git"
ci:
  enabled: true
  on_failure: human-review
  wait_for_pipeline: false
---

prompt body
