# IssuePilot 使用指南（中文）

[English](./getting-started.md) | 简体中文

本指南面向第一次使用 IssuePilot 的工程师，告诉你**装好之后该怎么用**。在 30 分钟内你应该可以：

1. 在本机准备好运行环境；
2. 在目标 GitLab 项目里配置 `.agents/workflow.md`；
3. 启动 orchestrator daemon + dashboard；
4. 给一个 Issue 打 `ai-ready` label，让 IssuePilot 自动接管，完成代码 → 推分支 → 开 MR → 回写 Issue note 的全流程。

> 本指南是产品视角的"怎么用"。如果你想做端到端 smoke 验证，请配合阅读 [`docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`](./superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md) 的 §18.3 验收清单。

---

## 1. 它是什么

IssuePilot 是一个**本地单机** orchestrator：

- 轮询 GitLab，发现带 `ai-ready` label 的 Issue 自动认领；
- 在 `~/.issuepilot/` 下为每个 Issue 创建独立的 git worktree；
- 用 Codex app-server（JSON-RPC stdio）在该 worktree 内驱动 AI 工程师完成代码；
- 推送分支、创建/更新 MR、给 Issue 写 handoff note；
- 通过 label 切换（`ai-running` → `human-review` / `ai-failed` / `ai-blocked`）表达运行结果；
- 提供只读 dashboard 展示运行时间线、工具调用、最近日志。

P0 不是 SaaS、不是多租户、不是集群 — 它是一台 dev 机器上的 daemon + 一个静态 dashboard，目标是让 AI 工程师把"已经描述清楚的 Issue"先做掉一轮，留给人 review 的是 MR 而不是 agent turn。

---

## 2. 环境要求

| 工具      | 版本                                     | 说明                                                                              |
| --------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| Node.js   | `>=22 <23`                               | `.npmrc` 启用 engine-strict                                                       |
| pnpm      | `10.x`                                   | 仓库 `packageManager: pnpm@10.x`，用 corepack 即可                                |
| Git       | `>=2.40`                                 | 真实 git CLI 通过 `execa` 调用                                                    |
| Codex CLI | 任意版本，需要 `codex app-server` 子命令 | 必须先登录                                                                        |
| GitLab    | 实例 + 一个测试项目                      | Group/Project Access Token，可访问 `api` / `read_repository` / `write_repository` |
| SSH key   | 能 push 到目标项目                       | repo_url 用 SSH 形式 `git@host:group/proj.git`                                    |

跑一次环境检查：

```bash
corepack enable
pnpm install
pnpm -F @issuepilot/orchestrator build
pnpm exec issuepilot doctor
```

期望全部 `[OK]`：Node.js、git、codex app-server、`~/.issuepilot/state` 可写。

---

## 3. 准备 GitLab 项目

在目标 GitLab 项目里：

### 3.1 创建 label

至少创建以下 6 个 label（颜色随意）：

| Label          | 含义                                   |
| -------------- | -------------------------------------- |
| `ai-ready`     | 候选 Issue，IssuePilot 会拾取它        |
| `ai-running`   | IssuePilot 已认领并正在运行            |
| `human-review` | 已生成 MR，等人 review                 |
| `ai-rework`    | 人 review 后要求再跑一轮 AI            |
| `ai-failed`    | 运行失败，需要人介入                   |
| `ai-blocked`   | 缺少信息 / 权限 / 密钥，停在这等人解锁 |

### 3.2 创建 Access Token

Settings → Access Tokens：

- 名称：`issuepilot-local`（或任意）
- 角色：`Maintainer`（需要 push 分支、改 label、写 note、开 MR）
- 权限：勾选 `api`、`read_repository`、`write_repository`
- 复制 token，下面 `GITLAB_TOKEN` 会用到

### 3.3 准备 SSH 推送凭据

`workflow.git.repo_url` 用 SSH 形式，IssuePilot 通过本机 `~/.ssh` 走 git 协议 push，**不通过 token 走 https**。

```bash
ssh -T git@gitlab.example.com  # 应该认出你是谁
```

---

## 4. 在目标项目里配置 `.agents/workflow.md`

`.agents/workflow.md` 是 IssuePilot 与目标项目的契约文件。它有两部分：

- **YAML front matter**：机器读的配置，包括 tracker、workspace、git、agent、codex 设置。
- **Markdown 正文**：作为 Liquid 模板渲染出来的 prompt，发给 Codex。

把它放进**目标项目**的 git 仓库（不是 IssuePilot 仓库），位置必须是 `.agents/workflow.md`。

最小可用模板：

```md
---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
  token_env: "GITLAB_TOKEN"
  active_labels:
    - ai-ready
    - ai-rework
  running_label: ai-running
  handoff_label: human-review
  failed_label: ai-failed
  blocked_label: ai-blocked
  rework_label: ai-rework

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

你是这个仓库的 AI 工程师。

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
URL: {{ issue.url }}

Description:
{{ issue.description }}

要求：

1. 先阅读相关代码再开始改。
2. 工作只能落在提供的 workspace 内。
3. 完成 Issue 描述里的修改。
4. 提交代码，并通过 `gitlab_create_merge_request` 创建/更新 MR。
5. 用 `gitlab_create_issue_note` 给 Issue 回写工作日志（实现、验证、风险、MR 链接）。
6. 完成后让 orchestrator 把 Issue 转到 `human-review`。
7. 缺信息/权限/密钥时调 `gitlab_transition_labels` 打 `ai-blocked` 并说明原因。
```

### 4.1 关键字段说明

| 字段                                                      | 说明                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `tracker.token_env`                                       | IssuePilot **不读** 这个变量本身，它读 `process.env[此变量名]`。**token 不能写进 workflow 文件**。         |
| `tracker.active_labels`                                   | 候选 label 列表。默认 `["ai-ready", "ai-rework"]`。                                                        |
| `git.base_branch`                                         | MR target 分支。缺省时 fallback 到 GitLab 项目的 default branch。                                          |
| `git.branch_prefix`                                       | 分支命名前缀，最终分支是 `<prefix>/<issue-iid>-<title-slug>`。                                             |
| `agent.max_attempts`                                      | 单个 Issue 总尝试次数。`retryable` 错误自动重试，达到上限切到 `ai-failed`。                                |
| `codex.approval_policy`                                   | `never` = orchestrator 自动批准 Codex 的人工审批请求并发 `approval_auto_approved` 事件；其他值见 spec §6。 |
| `codex.thread_sandbox` / `codex.turn_sandbox_policy.type` | Codex 的 sandbox 级别。**不允许** `danger-full-access` / `dangerFullAccess`，校验阶段会直接拒绝。          |
| `poll_interval_ms`                                        | 轮询 GitLab 间隔，默认 `10000`。                                                                           |

把 `.agents/workflow.md` 推到目标项目的 `main`：

```bash
cd /path/to/target-project
mkdir -p .agents
$EDITOR .agents/workflow.md   # 粘贴上面模板并改成你的实际值
git add .agents/workflow.md
git commit -m "chore(issuepilot): seed workflow.md"
git push origin main
```

---

## 5. 启动 IssuePilot

### 5.0 管理凭据

IssuePilot 支持三种方式提供 GitLab 凭据，**按从上到下的优先级**择优使用：

| 方式 | 适用场景 | token 来源 |
| --- | --- | --- |
| `issuepilot auth login`（推荐） | 个人开发机；不想手动管理 PAT | 内置 OAuth 2.0 Device Flow，token 自动 refresh，存于 `~/.issuepilot/credentials`（权限 `0600`） |
| `.env` + [direnv](https://direnv.net/) | 团队共享或 CI 环境；已有 PAT/Group Token | `cd` 进目录自动 export 环境变量，离开自动 unset |
| `glab auth token` 桥接 | 已经在用 [glab CLI](https://gitlab.com/gitlab-org/cli) | `export GITLAB_TOKEN=$(glab auth token -h <host>)` |

> daemon 启动时优先读 `tracker.token_env` 指向的环境变量；缺失时再读 `~/.issuepilot/credentials`。token 在事件、日志、dashboard、prompt 中始终被 redact。

#### A. 用 `issuepilot auth login`（推荐）

```bash
pnpm exec issuepilot auth login --hostname gitlab.example.com
# 按提示在浏览器输入 user_code 完成授权，token 自动存盘
pnpm exec issuepilot auth status   # 查看登录状态和过期时间
pnpm exec issuepilot auth logout   # 清除本地 credentials
```

#### B. `.env` + direnv

```bash
brew install direnv     # macOS；其他平台见 https://direnv.net/
cp .env.example .env    # 编辑 .env 填入 GITLAB_TOKEN=glpat-xxx
echo 'dotenv' > .envrc && direnv allow .
echo $GITLAB_TOKEN      # 验证已加载
```

> `.env` 与 `.envrc` 已在 `.gitignore` 中，不会被提交。

#### C. glab CLI 桥接

```bash
glab auth login --hostname gitlab.example.com   # 浏览器 OAuth
export GITLAB_TOKEN=$(glab auth token --hostname gitlab.example.com)
```

> glab 颁发的是 `gloas-...` OAuth token，与手写的 `glpat-...` PAT 在 GitLab API 上等效，IssuePilot 透传 `@gitbeaker/rest` 无需区分。

---

### 5.1 准备 IssuePilot 仓库

```bash
cd /path/to/issuepilot
pnpm install
pnpm -w turbo run build
```

第一次跑前**必须** build orchestrator，因为 `pnpm smoke` 会启动 `apps/orchestrator/dist/bin.js`。

### 5.2 验证 workflow（推荐）

在启动 daemon 之前用 `validate` 子命令做一次纯静态校验：

```bash
# 已按 §5.0 设置好凭据则无需再 export，否则临时执行：
# export GITLAB_TOKEN="<你刚才创建的 token>"
pnpm exec issuepilot validate --workflow /path/to/target-project/.agents/workflow.md
```

期望输出：

```text
Workflow loaded: /path/to/target-project/.agents/workflow.md
GitLab project: group/project
Validation passed.
```

如果报错：

- `WorkflowConfigError: tracker` → workflow front matter 缺字段或字段类型不对。
- `WorkflowConfigError: tracker.token_env` → `process.env.GITLAB_TOKEN` 没设置。
- `GitLabError(category="auth")` → token 错了或者过期。
- `GitLabError(category="permission")` → token 没 `api` scope，或者目标项目对该 token 不可见。

### 5.3 启动 daemon

**终端 A**（orchestrator）：

```bash
# 已按 §5.0 设置好凭据则无需再 export，否则临时执行：
# export GITLAB_TOKEN="<token>"
pnpm smoke --workflow /path/to/target-project/.agents/workflow.md
```

成功输出形如：

```text
[smoke] starting orchestrator daemon on 127.0.0.1:4738…
======================================================
 IssuePilot daemon ready
------------------------------------------------------
 API:        http://127.0.0.1:4738
 Dashboard:  http://localhost:3000
 Workflow:   /path/to/target-project/.agents/workflow.md
 Project:    group/project
 Poll every: 10000ms
 Concurrency:1
------------------------------------------------------
 Walk through the §18.3 smoke checklist now. Press Ctrl+C to stop.
======================================================
```

`Ctrl+C` 优雅退出 daemon，readiness 失败时 wrapper 会 5 秒内 SIGTERM → SIGKILL，**不会卡死**。

> 如果不想用 smoke wrapper，也可以直接：`node apps/orchestrator/dist/bin.js run --workflow <path> [--port 4738] [--host 127.0.0.1]`。

**终端 B**（dashboard）：

```bash
pnpm dev:dashboard
```

打开 `http://localhost:3000`，应能看到 ServiceHeader（status / project / concurrency / pollIntervalMs / lastPollAt 等），SummaryCards（running / retrying / human-review / failed / blocked 5 张计数卡），RunsTable（初始为空）。

> 端口冲突时：`pnpm smoke --workflow ... --port 4839 --dashboard-url http://localhost:3000`。

---

## 6. 跑你的第一个 Issue

在目标 GitLab 项目里：

1. 新建一个简单 Issue，比如「在 README 末尾加一行 `Hello from IssuePilot`」。
2. 给它打上 `ai-ready` label。
3. **不要** 把自己 assign 上去（IssuePilot 不需要 assignee）。

约 `poll_interval_ms`（默认 10 秒）后：

- Dashboard `/` 的 RunsTable 出现一行新 run，状态从 `claimed` → `running`；
- 进入 `/runs/<runId>` 看到 timeline 滚动出：
  - `run_started`
  - `claim_succeeded`
  - `workspace_ready`（worktree 已建）
  - `session_started`（Codex app-server 起来了）
  - `turn_started` → `tool_call_started` → `tool_call_completed`（Codex 在调 `gitlab_*` 工具）
  - `gitlab_push`（分支已推）
  - `gitlab_mr_created`（MR 已开）
  - `gitlab_note_created`（Issue note 已写）
  - `gitlab_labels_transitioned`（label 从 `ai-running` → `human-review`）
  - `run_completed`
- GitLab 上：分支 `ai/<iid>-<slug>` 出现，MR 自动开成 draft，Issue 评论里出现 IssuePilot 写的工作日志，label 变成 `human-review`。
- 终端 A 滚动结构化日志。

整个流程是无人值守的。完成后，人 review MR、决定合并或要求 `ai-rework`。

---

## 7. 各 label 状态对应的处理

| 当前 label     | 含义             | 你该做什么                                                                                                              |
| -------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ai-ready`     | 候选             | 什么都不用做，等 IssuePilot 拾取                                                                                        |
| `ai-running`   | 已认领           | 等待，看 dashboard                                                                                                      |
| `human-review` | 有 MR 等 review  | 去 GitLab review MR；合并 = 完成；要求改 = 把 label 改回 `ai-rework`                                                    |
| `ai-rework`    | 人主动打回       | 等 IssuePilot 重新拾取（与 `ai-ready` 一样进入候选）                                                                    |
| `ai-failed`    | 运行失败         | 查 Issue 上 IssuePilot 写的失败 note；看 dashboard timeline 找根因；修问题后人工把 label 改回 `ai-ready` 或 `ai-rework` |
| `ai-blocked`   | 缺信息/权限/密钥 | 看 note 里说缺什么；解决后把 label 改回 `ai-ready`                                                                      |

> `ai-rework` **不是** `ai-ready` 的别名 — 它是人主动打回的状态。IssuePilot 默认把这两个 label 都当成候选源（`active_labels`）。

---

## 8. 失败 workspace 的取证

失败的 run **不会** 被删除。

```bash
ls ~/.issuepilot/workspaces/<project-slug>/<iid>/
# 里面有 .issuepilot/failed-at-<iso>.json，含失败上下文
```

事件流也保留：

```bash
~/.issuepilot/state/events/<project-slug>-<iid>.jsonl   # 完整 IssuePilotEvent JSONL
~/.issuepilot/state/runs/<project-slug>-<iid>.json      # 最近一次 RunRecord
~/.issuepilot/state/logs/issuepilot.log                 # daemon 结构化日志
```

排障流程：

1. 在 dashboard `/runs/<runId>` 看 timeline，确定**第一个**红色事件。
2. 用 `runId` 在 `~/.issuepilot/state/logs/issuepilot.log` grep 上下文。
3. 进 worktree 复现：`cd ~/.issuepilot/workspaces/<project-slug>/<iid>/ && git status`。
4. 修问题（如：补 token 权限、改 prompt、修 workflow.md）。
5. 在 GitLab 上把 label 改回 `ai-ready` 重新触发。

---

## 9. 高级用法

### 9.1 Workflow Hot Reload

`.agents/workflow.md` 改了之后**不需要**重启 daemon。orchestrator 用 `fs.watch` + `stat` 轮询监测变更：

- 解析成功 → 下一次 tick 立即用新配置（dashboard ServiceHeader 的 `lastConfigReloadAt` 会更新）。
- 解析失败 → 保留 last-known-good，不会让 daemon 崩；错误进 `~/.issuepilot/state/logs/issuepilot.log`。

### 9.2 调整 retry 策略

`agent.max_attempts` 控制总尝试次数。一次失败被分类为：

- **blocked**（如 401/403） → 直接切 `ai-blocked`，**不重试**。
- **failed**（如逻辑错误） → 切 `ai-failed`，**不重试**。
- **retryable**（如 `turn/timeout`、5xx、网络） → `retry_scheduled` 事件 + `setTimeout(retryBackoffMs)` 后重新进入 dispatch；攻击到 `max_attempts` 后转 `failed`。

把 `max_attempts: 1` 可禁用重试（适合 smoke / 节省调用）。

### 9.3 Approval policy

| 取值                       | 含义                                                                             |
| -------------------------- | -------------------------------------------------------------------------------- |
| `never`                    | orchestrator 自动批准 Codex 的所有人工审批请求，发 `approval_auto_approved` 事件 |
| `untrusted` / `on-request` | 见 spec §6（P0 主要用 `never`）                                                  |

### 9.4 Hooks

`hooks.after_create` / `hooks.before_run` / `hooks.after_run` 是 bash 脚本字符串，在 worktree cwd 里 `bash -lc` 执行。常见用法：

```yaml
hooks:
  before_run: |
    git diff --cached --quiet || git commit -m "wip(issuepilot): snapshot before AI run"
  after_run: |
    test -f .agents/post-checks.sh && bash .agents/post-checks.sh
```

hook 非零退出 → `HookFailedError` → run 进入 `ai-failed` 分支。stdout/stderr 每条限制 1MB，超出截断标 `[truncated]`。

### 9.5 在容器/远程机器上跑

`--host` 默认 `127.0.0.1`，容器场景：

```bash
pnpm smoke --workflow ... --host 0.0.0.0 --dashboard-url http://your-host:3000
```

同时 dashboard 那边设置 `NEXT_PUBLIC_API_BASE=http://your-host:4738`，否则会走默认 `127.0.0.1:4738`。

### 9.6 多 Issue 并发

`agent.max_concurrent_agents` 控制并发槽位。每个 槽位独立 worktree + 独立 Codex 子进程。P0 推荐先 `1`，跑稳定后再加。

---

## 10. CLI 速查

```bash
# 系统先决条件检查
pnpm exec issuepilot doctor

# workflow 静态 + GitLab 连通性校验
pnpm exec issuepilot validate --workflow <path>

# 启动 daemon
pnpm exec issuepilot run --workflow <path> [--port 4738] [--host 127.0.0.1]

# 推荐：用 smoke wrapper 起 daemon 并自动等 ready
pnpm smoke --workflow <path> [--port 4738] [--host 127.0.0.1] [--dashboard-url http://localhost:3000]

# 单独跑 dashboard（开发用）
pnpm dev:dashboard
```

HTTP API 端点（默认 `http://127.0.0.1:4738`，见 spec §15）：

```text
GET /api/state                    # OrchestratorStateSnapshot
GET /api/runs?status=&limit=      # RunRecord[]
GET /api/runs/:runId              # RunRecord & { events, logsTail }
GET /api/events?runId=            # IssuePilotEvent[]（分页）
GET /api/events/stream            # text/event-stream（SSE）
```

---

## 11. 常见问题（FAQ）

- **`pnpm exec issuepilot doctor` 报 codex app-server not found**
  `codex app-server` 必须是可执行的子命令。`which codex` 查绝对路径，在 workflow.md 里写 `command: "/Users/xxx/.local/bin/codex app-server"`。

- **`Could not resolve remote.origin` / git push 卡住**
  workspace mirror 用 `git clone --mirror` 创建，但 push 不能走 mirror 模式。本仓库已经在 `packages/workspace/src/mirror.ts` 里修过（设 `remote.origin.mirror=false` + 显式 refspec）。如果还卡，`rm -rf ~/.issuepilot/repos/<slug>` 让 IssuePilot 重新克隆。

- **GitLab 401/403**
  最常见：`GITLAB_TOKEN` 没 export 进 daemon 进程；token 缺 `api` scope；token 对目标项目不可见。修了 token 之后**重启** daemon。

- **dashboard 一直空 / 报 CORS**
  Dashboard 默认走 `http://127.0.0.1:4738`，必须和 `--host` 一致。容器场景见 §9.5。

- **`pnpm smoke` 卡 readiness**
  readiness 探测失败时 smoke wrapper 会 SIGTERM 给 daemon 等最多 5 秒，仍未退出会 SIGKILL，命令一定会返回控制权（不会无限 hang）。

- **怎么知道 IssuePilot 写的 note 是哪个 run？**
  每条 note 第一行有 marker：`<!-- issuepilot:run=<runId> -->`。同一 run 复用、不同 run 创建新 note。

- **怎么停一个 run？**
  P0 没有 cancel 接口。直接在 GitLab 上把 label 从 `ai-running` 改回别的（如 `ai-blocked`）会让 orchestrator 在下次 tick reconcile 时观察到 label 不对、不再处理；workspace 保留供取证。

---

## 12. 下一步

- 看 [`docs/superpowers/specs/2026-05-11-issuepilot-design.md`](./superpowers/specs/2026-05-11-issuepilot-design.md) 了解架构与协议细节。
- 看 [`docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`](./superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md) 跑一次完整 smoke。
- 看 [`CHANGELOG.md`](../CHANGELOG.md) 了解最新进展。
- 在你自己的 sandbox 上多跑几个 Issue，把 failed / blocked 路径也走一遍。

合并 MR 之前**人 review**。IssuePilot 不替代 code review，它只是让 AI 工程师**先把准备工作做完**。
