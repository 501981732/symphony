---
# ============================================================
# IssuePilot — .agents/workflow.md 示例模板
#
# 使用方法：
#   1. 把此文件复制到你的**目标项目**仓库的 .agents/workflow.md
#   2. 把所有 REPLACE_ME 占位符替换成真实值
#   3. git add .agents/workflow.md && git commit && git push
#   4. 回到 IssuePilot 仓库，运行：
#        export GITLAB_TOKEN="<your-token>"
#        pnpm exec issuepilot validate --workflow /path/to/target/.agents/workflow.md
#
# 注意：token 绝不能写进此文件，通过 token_env 指定的环境变量传入。
# ============================================================

tracker:
  kind: gitlab
  # GitLab 实例地址，SaaS 填 https://gitlab.com，私有部署填内网地址
  base_url: "https://gitlab.example.com" # REPLACE_ME
  # 项目路径，格式 "group/project" 或 "group/subgroup/project"
  project_id: "group/project" # REPLACE_ME
  # 存放 GitLab token 的环境变量名（不是 token 本身）
  token_env: "GITLAB_TOKEN"
  # IssuePilot 会认领带这些 label 的 Issue
  active_labels:
    - ai-ready
    - ai-rework
  # 认领后自动打上此 label
  running_label: ai-running
  # 完成后切换到此 label（人工 review 阶段）
  handoff_label: human-review
  # 运行失败时切换到此 label
  failed_label: ai-failed
  # 缺少信息/权限时切换到此 label
  blocked_label: ai-blocked
  # 人主动打回重跑的 label（与 ai-ready 同为候选源）
  rework_label: ai-rework

workspace:
  # IssuePilot worktree 的本地根目录
  root: "~/.issuepilot/workspaces"
  strategy: worktree
  # bare mirror 缓存目录（加速 clone）
  repo_cache_root: "~/.issuepilot/repos"

git:
  # 目标仓库的 SSH clone URL（push 走 SSH，不走 HTTPS token）
  repo_url: "git@gitlab.example.com:group/project.git" # REPLACE_ME
  # MR 的 target branch
  base_branch: main
  # worktree 分支命名前缀，最终分支为 <prefix>/<iid>-<title-slug>
  branch_prefix: ai

agent:
  runner: codex-app-server
  # 同时处理的 Issue 数量，P0 先用 1，跑稳后再加
  max_concurrent_agents: 1
  # 单次 run 最大 turn 数（超出后视为 retryable 错误）
  max_turns: 10
  # 单个 Issue 总尝试次数（retryable 错误自动重试至上限）
  max_attempts: 2
  # 重试等待时间（毫秒）
  retry_backoff_ms: 30000

codex:
  # Codex 可执行文件路径（PATH 里有 codex 时直接写子命令即可）
  # 路径含空格时请用引号：command: '"/Users/My Name/.local/bin/codex" app-server'
  command: "codex app-server"
  # never = orchestrator 自动批准 Codex 的人工审批请求
  approval_policy: never
  # sandbox 级别，禁止使用 danger-full-access / dangerFullAccess
  thread_sandbox: workspace-write
  # 单次 turn 超时（毫秒），默认 1 小时
  turn_timeout_ms: 3600000
  turn_sandbox_policy:
    type: workspaceWrite

# GitLab 轮询间隔（毫秒），默认 10 秒
poll_interval_ms: 10000

# ============================================================
# 可选：hooks（bash 脚本字符串，在 worktree cwd 里执行）
# 非零退出 → HookFailedError → ai-failed
# ============================================================
# hooks:
#   # worktree 创建后、AI 运行前执行（适合安装依赖、配置环境）
#   before_run: |
#     [ -f package.json ] && npm ci --prefer-offline || true
#   # AI 运行完毕后执行（适合跑静态检查、lint）
#   after_run: |
#     test -f .agents/post-checks.sh && bash .agents/post-checks.sh || true
---

你是这个仓库的 AI 工程师。请按照以下 Issue 的描述完成开发任务。

## 当前任务

- **Issue**：{{ issue.identifier }}
- **标题**：{{ issue.title }}
- **链接**：{{ issue.url }}

## 描述

{{ issue.description }}

## 工作规范

1. 先阅读相关代码再开始修改，不要猜测现有接口的行为。
2. 所有改动只能落在当前提供的 workspace 目录内，不能访问其他路径。
3. 按 Issue 描述完成代码修改，保持改动最小、聚焦。
4. 完成后提交代码，并用 `gitlab_create_merge_request` 创建或更新 MR：
   - MR title 格式：`fix/feat: <简短描述>（close #{{ issue.iid }}）`
   - MR description 说明：做了什么、怎么验证、有什么风险。
5. 用 `gitlab_create_issue_note` 给 Issue 写一条工作日志，包含：
   - 实现摘要（改了哪些文件、为什么这样改）
   - 验证方式（测试命令、截图等）
   - MR 链接
   - 已知风险或待确认事项（如有）
6. 最后让 orchestrator 把 Issue label 切换到 `human-review`。
7. 如果缺少必要信息、权限或密钥，立即调用 `gitlab_transition_labels` 打 `ai-blocked`，
   并在 Issue note 里说明缺少什么，然后停止。不要猜测或绕过安全边界。
