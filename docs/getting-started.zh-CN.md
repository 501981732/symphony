# IssuePilot 快速上手

[English](./getting-started.md) | 简体中文

本指南面向第一次使用 IssuePilot 的工程师。目标是把一个 GitLab Issue 自动跑成一条分支、一个 Merge Request 和一条 Issue 回写说明。

最快路径只需要记住两件事：

- **IssuePilot 仓库**：你在这里构建或获取本地安装包。
- **目标项目仓库**：真正要被 AI 修改的业务仓库，里面需要放 `WORKFLOW.md`。

```text
/path/to/issuepilot
  构建安装包：pnpm release:pack

/path/to/target-project
  存放：WORKFLOW.md
  被 IssuePilot 创建 worktree 后修改

安装后的 CLI
  运行：issuepilot doctor / issuepilot run / issuepilot dashboard
```

> **本指南覆盖的版本**：V1 单项目本地闭环（默认入口 `issuepilot run --workflow ...`）
> **以及** V2 团队可运营版本 Phase 1-5 已合入 `main` 的能力：多项目 team config、
> dashboard retry/stop/archive、CI 失败自动回流 `ai-rework`、review feedback sweep、
> workspace retention 自动清理。V2 团队模式入口、操作与限制集中在 §13 团队模式。
>
> 想看视觉版本：
>
> - 架构图：[`docs/superpowers/diagrams/v2-architecture.svg`](./superpowers/diagrams/v2-architecture.svg)
> - 端到端流程图：[`docs/superpowers/diagrams/v2-flow.svg`](./superpowers/diagrams/v2-flow.svg)

---

## 1. IssuePilot 做什么

IssuePilot 是本地单机 orchestrator。它会：

1. 轮询 GitLab，找到带 `ai-ready` label 的 Issue。
2. 为每个 Issue 在 `~/.issuepilot` 下创建独立 git worktree。
3. 在 worktree 里启动 `codex app-server`，让 Codex 完成代码修改。
4. 推送分支，创建或更新 MR，给 Issue 写 handoff note。
5. 把 Issue label 从 `ai-running` 切到 `human-review`、`ai-failed` 或 `ai-blocked`。
6. 在 `human-review` 阶段周期性扫 MR pipeline、扫 reviewer 评论、按 retention policy
   清理过期 worktree（V2 已交付，详见 §13）。

V1 是本地单项目工具，V2 在不破坏 V1 入口的前提下追加团队共享机器场景。两者都不
是 SaaS、不是集群、不会自动合并 MR。MR 合并前必须人工 review。稳定本地路径是安装后
的 `issuepilot` CLI；source-checkout 命令继续保留给贡献者开发和紧急回滚。

---

## 2. 安装 IssuePilot

在 **IssuePilot 仓库**里执行：

```bash
corepack enable
pnpm install
pnpm release:pack
npm install -g ./dist/release/issuepilot-0.1.0.tgz
issuepilot doctor
```

期望 `doctor` 输出里 Node.js、Git、Codex app-server、`~/.issuepilot/state` 都是 `[OK]`。

需要的工具：

| 工具      | 要求                                     |
| --------- | ---------------------------------------- |
| Node.js   | `>=22 <23`                               |
| pnpm      | `10.x`，通过 corepack 使用               |
| Git       | `>=2.40`                                 |
| Codex CLI | 需要能执行 `codex app-server`，且已登录  |
| GitLab    | 一个测试项目，支持 API、label、Issue、MR |
| SSH key   | 能 push 到目标项目                       |

贡献者开发兜底：

```bash
pnpm build
pnpm exec issuepilot doctor
```

---

## 3. 准备目标 GitLab 项目

以下步骤在 **目标项目**对应的 GitLab project 里完成。

### 3.1 创建 workflow labels

至少创建这些 label：

| Label          | 含义                          |
| -------------- | ----------------------------- |
| `ai-ready`     | 候选 Issue，IssuePilot 会拾取 |
| `ai-running`   | IssuePilot 已认领并正在运行   |
| `human-review` | MR 已生成，等待人工 review    |
| `ai-rework`    | 人工 review 后要求 AI 再跑    |
| `ai-failed`    | 运行失败，需要人工排障        |
| `ai-blocked`   | 缺信息、权限或密钥            |

### 3.2 确认 SSH 能 push

`workflow.git.repo_url` 推荐使用 SSH 地址。IssuePilot 的 Git push 走本机 SSH key，不走 GitLab API token。

```bash
ssh -T git@gitlab.example.com
```

如果你们公司有两套 GitLab，需要分别确认：

```bash
ssh -T git@gitlab.chehejia.com
ssh -T git@gitlabee.chehejia.com
```

---

## 4. 配置 `WORKFLOW.md`

在 **目标项目仓库**根目录创建 `WORKFLOW.md`，并提交到目标项目默认分支。
这里只放配置，不在目标项目里启动 IssuePilot。

`WORKFLOW.md` 是默认 workflow 路径。迁移期仍可通过显式 `--workflow`
传入旧的 `.agents/workflow.md`，新项目应使用根目录文件。

```bash
cd /path/to/target-project
$EDITOR WORKFLOW.md
```

创建后拿到它的绝对路径，并复制这条路径。后续在 IssuePilot 仓库启动 daemon 时，`--workflow` 需要传这个路径：

```bash
WORKFLOW_PATH="$(pwd)/WORKFLOW.md"
echo "$WORKFLOW_PATH"

# macOS：复制到剪贴板，方便粘到后面的命令里
printf "%s" "$WORKFLOW_PATH" | pbcopy
```

最小模板：

```md
---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
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
4. 提交代码，并通过 `gitlab_create_merge_request` 创建或更新 MR。
5. 用 `gitlab_create_issue_note` 给 Issue 回写实现、验证、风险和 MR 链接。
6. 完成后让 orchestrator 把 Issue 转到 `human-review`。
7. 缺信息、权限或密钥时，调 `gitlab_transition_labels` 打 `ai-blocked` 并说明原因。
```

提交 workflow：

```bash
git add WORKFLOW.md
git commit -m "chore(issuepilot): add workflow"
git push origin main
```

关键字段：

| 字段                          | 怎么填                                                         |
| ----------------------------- | -------------------------------------------------------------- |
| `tracker.kind`                | 固定写 `gitlab`，不要写 `gitlabee`                             |
| `tracker.base_url`            | GitLab 实例地址，如 `https://gitlab.chehejia.com`              |
| `tracker.project_id`          | GitLab 项目路径或数字 ID，如 `group/project`                   |
| `tracker.token_env`           | 可选。只有使用环境变量 token 时才写；值是变量名，不是 token 值 |
| `git.repo_url`                | 目标项目 SSH clone 地址                                        |
| `git.base_branch`             | MR target branch，通常是 `main` 或 `master`                    |
| `agent.max_concurrent_agents` | 建议先用 `1`，稳定后再调大                                     |
| `codex.approval_policy`       | P0 推荐 `never`                                                |

多 GitLab 实例也用同一个 `kind: gitlab`，通过 `base_url` 区分：

```yaml
# gitlab.chehejia.com
tracker:
  kind: gitlab
  base_url: "https://gitlab.chehejia.com"
  project_id: "group/project"

# gitlabee.chehejia.com
tracker:
  kind: gitlab
  base_url: "https://gitlabee.chehejia.com"
  project_id: "group/project"
```

---

## 5. 配置 GitLab 凭据

IssuePilot 支持两条常用路径。个人开发机推荐 OAuth；CI 或团队共享环境推荐环境变量 token。

### 5.1 方式 A：OAuth 登录（推荐）

前置条件：每个 GitLab 实例需要先注册一个 OAuth Application。

管理员在 GitLab 上创建 Application：

- 入口：`https://<gitlab-host>/admin/applications`
- Name：`IssuePilot`
- Confidential：不勾选，必须是 public application
- Scopes：`api`、`read_repository`、`write_repository`
- 如果有 Device Authorization Grant 开关，需要勾选
- 保存后复制 **Application ID**，它就是 `--client-id`

然后使用安装后的 CLI 登录：

```bash
issuepilot auth login --hostname gitlab.example.com --client-id <oauth-application-id>
issuepilot auth status --hostname gitlab.example.com
```

`--client-id` 是 OAuth Application 的公开 Application ID，不是 Application Secret，也不是 Access Token。

如果你同时使用两套公司 GitLab，需要分别登录：

```bash
issuepilot auth login --hostname gitlab.chehejia.com --client-id <oauth-application-id>
issuepilot auth login --hostname gitlabee.chehejia.com --client-id <oauth-application-id>
```

登录成功后，token 会保存到 `~/.issuepilot/credentials`，文件权限为 `0600`。如果你使用 OAuth 登录，workflow 里不要写 `tracker.token_env`；一旦写了 `tracker.token_env`，daemon 会要求对应环境变量必须存在。

### 5.2 方式 B：环境变量 token

如果你已经有 GitLab PAT、Group Access Token、Project Access Token 或 `glab auth token`，可以直接用环境变量。

```bash
export GITLAB_TOKEN="<token>"
```

如果选择这条路径，需要在 workflow 的 `tracker` 段额外加 `token_env`。这不是默认模板，只适用于环境变量 token：

```yaml
tracker:
  base_url: "https://gitlab.chehejia.com"
  token_env: "GITLAB_TOKEN"

tracker:
  base_url: "https://gitlabee.chehejia.com"
  token_env: "GITLABEE_TOKEN"
```

对应启动前：

```bash
export GITLAB_TOKEN="<gitlab.chehejia.com token>"
export GITLABEE_TOKEN="<gitlabee.chehejia.com token>"
```

不要把 token 写进 `WORKFLOW.md`、Issue、prompt 或日志。

---

## 6. 验证 workflow

安装 CLI 后，在任意 shell 执行：

```bash
# 如果这是新终端，把第 4 节复制的绝对路径重新放进变量
export WORKFLOW_PATH="/path/to/target-project/WORKFLOW.md"
issuepilot validate --workflow "$WORKFLOW_PATH"
```

成功时应该看到：

```text
Workflow loaded: /path/to/target-project/WORKFLOW.md
GitLab project: group/project
Validation passed.
```

常见失败：

| 错误                                     | 处理方式                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `WorkflowConfigError: tracker`           | 检查 workflow front matter 字段名和缩进                                                                             |
| `WorkflowConfigError: tracker.token_env` | workflow 写了 `token_env`，但启动 daemon 的 shell 没有对应环境变量；export 它，或删掉 `token_env` 并使用 OAuth 登录 |
| `GitLabError(category="auth")`           | token 错误、过期，或 OAuth credentials 不存在                                                                       |
| `GitLabError(category="permission")`     | token 缺 `api` scope，或无目标项目权限                                                                              |

---

## 7. 启动 IssuePilot

需要两个终端。

### 7.1 终端 A：启动 orchestrator

```bash
export WORKFLOW_PATH="/path/to/target-project/WORKFLOW.md"
issuepilot run --workflow "$WORKFLOW_PATH" --port 4738 --host 127.0.0.1
```

贡献者 source-checkout 兜底：

```bash
cd /path/to/issuepilot
export WORKFLOW_PATH="/path/to/target-project/WORKFLOW.md"
pnpm exec issuepilot run --workflow "$WORKFLOW_PATH" --port 4738 --host 127.0.0.1
```

ready 后会看到 API 地址，默认是：

```text
API: http://127.0.0.1:4738
```

### 7.2 终端 B：启动 dashboard

```bash
issuepilot dashboard
```

打开：

```text
http://localhost:3000
```

dashboard 默认连接 `http://127.0.0.1:4738`。如果 orchestrator 用了其他端口，启动 dashboard 时指定：

```bash
issuepilot dashboard --api-url http://127.0.0.1:4839
```

如果页面显示 `IssuePilot orchestrator unreachable` / `fetch failed`，先确认终端 A 里的 orchestrator 还在运行，并且 dashboard 连接的是同一个端口。

---

## 8. 跑第一个 Issue

在目标 GitLab 项目里：

1. 新建一个简单 Issue，例如「在 README 末尾添加一行 `Hello from IssuePilot`」。
2. 给 Issue 打 `ai-ready` label。
3. 不需要 assign 给自己。

约 10 秒后，IssuePilot 应该会：

1. 把 Issue label 切到 `ai-running`。
2. 在 dashboard 里出现一条 run。
3. 创建 worktree 并启动 Codex。
4. 推送 `ai/<iid>-<slug>` 分支。
5. 创建 draft MR。
6. 给 Issue 写 handoff note。
7. 把 Issue 切到 `human-review`。

人类随后 review MR。要让 AI 再改一轮，把 label 改成 `ai-rework`。

---

## 9. 状态怎么处理

| 当前 label     | 你该做什么                                    |
| -------------- | --------------------------------------------- |
| `ai-ready`     | 等 IssuePilot 拾取                            |
| `ai-running`   | 看 dashboard 等结果                           |
| `human-review` | 去 GitLab review MR                           |
| `ai-rework`    | 等 IssuePilot 再跑一轮                        |
| `ai-failed`    | 看失败 note 和 dashboard timeline，修复后重试 |
| `ai-blocked`   | 补信息、权限或密钥，解决后改回 `ai-ready`     |

失败 run 不会删除。排障时看：

```bash
~/.issuepilot/state/logs/issuepilot.log
~/.issuepilot/state/events/<project-slug>-<iid>.jsonl
~/.issuepilot/state/runs/<project-slug>-<iid>.json
~/.issuepilot/workspaces/<project-slug>/<iid>/
```

---

## 10. 常用命令

```bash
# 环境检查
export WORKFLOW_PATH="/path/to/target-project/WORKFLOW.md"
issuepilot doctor

# OAuth 登录
issuepilot auth login --hostname <gitlab-host> --client-id <oauth-application-id>
issuepilot auth status --hostname <gitlab-host>
issuepilot auth logout --hostname <gitlab-host>

# 校验 workflow
issuepilot validate --workflow "$WORKFLOW_PATH"

# 启动 orchestrator
issuepilot run --workflow "$WORKFLOW_PATH"

# 启动 dashboard
issuepilot dashboard
```

---

## 11. FAQ

**`codex app-server not found`**

确认 Codex CLI 已安装并登录：

```bash
which codex
codex app-server --help
```

如果 Codex 不在 PATH 里，在 workflow 里把 `codex.command` 改成绝对路径。

**`auth login failed ... category=invalid_client`**

GitLab 上没有注册匹配的 OAuth Application，或没有启用 Device Authorization Grant。重新注册 Application，复制 Application ID，再执行：

```bash
issuepilot auth login --hostname <host> --client-id <oauth-application-id>
```

**GitLab 401 / 403**

检查 token 是否 export 到启动 daemon 的同一个 shell、是否有 `api` scope、是否能访问目标项目。修复后重启 orchestrator。

**dashboard 显示 `orchestrator unreachable`**

dashboard 只是前端。必须另开一个终端启动 orchestrator：

```bash
export WORKFLOW_PATH="/path/to/target-project/WORKFLOW.md"
issuepilot run --workflow "$WORKFLOW_PATH"
```

如果 orchestrator 不在 `4738`，用 `NEXT_PUBLIC_API_BASE` 指定地址。

**怎么知道 IssuePilot 写的 note 对应哪个 run？**

Issue note 第一行有 marker：

```text
<!-- issuepilot:run:<runId> -->
```

最终 handoff note 会以 `## IssuePilot handoff` 开头，并包含 branch、MR、
实现摘要、验证结果、风险 / 后续事项，以及给人工 reviewer 的下一步动作。

---

## 12. 下一步

- V2 架构图与流程图：[`docs/superpowers/diagrams/`](./superpowers/diagrams/)
- 架构细节：[`docs/superpowers/specs/2026-05-11-issuepilot-design.md`](./superpowers/specs/2026-05-11-issuepilot-design.md)
- V2 总设计与 Phase 1-5 进度：[`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`](./superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md)
- Workspace cleanup runbook：[`docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md`](./superpowers/runbooks/2026-05-15-workspace-cleanup.md)
- 完整 smoke runbook：[`docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`](./superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md)
- 更新记录：[`CHANGELOG.md`](../CHANGELOG.md)

---

## 13. V2 团队模式：在一台共享机器上管多个项目

V2 在不破坏 V1 `--workflow` 单项目入口的前提下，新增 `--config` 团队模式入口和
四组与之配套的能力：dashboard 操作、CI 失败回流、review feedback sweep、workspace
retention 自动清理。本节集中说明它们怎么用、有什么限制。

### 13.1 入口对比

| 用法 | 适用 | 命令 |
| --- | --- | --- |
| V1 单项目 | 个人开发机；一台 daemon 只服务一个项目 | `issuepilot run --workflow /path/to/WORKFLOW.md` |
| V2 团队模式 | 共享机器；一台 daemon 管多个 GitLab 项目；带 lease 防重复 claim | `issuepilot run --config /path/to/issuepilot.team.yaml` |

`--workflow` 与 `--config` 互斥；同时传会直接报错退出。

### 13.2 team config 最小模板

```yaml
version: 1

server:
  host: 127.0.0.1
  port: 4738

scheduler:
  max_concurrent_runs: 2
  max_concurrent_runs_per_project: 1
  lease_ttl_ms: 900000
  poll_interval_ms: 10000

projects:
  - id: platform-web
    name: Platform Web
    workflow: /srv/repos/platform-web/WORKFLOW.md
    enabled: true
  - id: infra-tools
    name: Infra Tools
    workflow: /srv/repos/infra-tools/WORKFLOW.md
    enabled: true

# 可选：team 级 CI 默认值；project 内可再覆盖
ci:
  enabled: true
  on_failure: ai-rework        # 或 human-review
  wait_for_pipeline: true

# 可选：team 级 workspace retention 默认值
retention:
  successful_run_days: 7
  failed_run_days: 30
  max_workspace_gb: 50
  cleanup_interval_ms: 3600000
```

字段约束（违反会启动失败并报具体 dotted path）：

- `version` 固定 `1`。
- `scheduler.max_concurrent_runs`：1..5；超过会拒绝启动。
- `scheduler.lease_ttl_ms`：不小于 `60_000`。
- `projects[].id`：小写字母数字 + 中划线；同一 config 内不能重复。
- 相对 `workflow` 路径会基于 config 文件目录解析为绝对路径。

每个 `projects[].workflow` 必须指向一份合法的 `WORKFLOW.md`。team config **不复制**
workflow 的 GitLab labels / prompt / hooks，这些仍由各 project 自己的 `WORKFLOW.md` 决定。

### 13.3 启动与校验

```bash
# 启动前校验（不连 GitLab、不启动 daemon）
issuepilot validate --config /path/to/issuepilot.team.yaml

# 启动 team daemon
issuepilot run --config /path/to/issuepilot.team.yaml
```

`validate --config` 走与 daemon 启动同一条 `loadTeamConfig` 管道，YAML 错误和 zod
schema 错误都会按 dotted path 报出来（例如 `scheduler.lease_ttl_ms`）。

dashboard 启动方式与 V1 一致；连接同一个 `--api-url` 即可：

```bash
issuepilot dashboard --api-url http://127.0.0.1:4738
```

V2 模式下 dashboard 顶部 `Projects` 区会按 team config 顺序列出每个项目，
`enabled: false` 的项目会显示中性 `disabled` badge；workflow 加载失败的项目
显示红色 `load error` + 错误摘要。

### 13.4 Phase 2：dashboard retry / stop / archive

dashboard 在 run 列表与 detail 页提供三个按钮，所有操作都会写
`operator_action_*` 事件到 event store，可在 detail 页时间线和
`/api/events?runId=<runId>` 查到。

| 操作 | 适用 run 状态 | 行为 | 备注 |
| --- | --- | --- | --- |
| Retry | `ai-failed`、`ai-blocked`、`ai-rework`、archived failed run | 把 issue label 翻到 `ai-rework`，dashboard run 状态置 `claimed` | V2 team daemon 暂未装配，调用返回 `503 actions_unavailable`；V1 入口可用 |
| Stop | active `ai-running` run | 通过 Codex `turn/interrupt` 真实取消 turn；5s 超时升级 `stopping` 中间态，最终走 `turnTimeoutMs` 收敛 | 不直接动 GitLab labels；失败时 emit `operator_action_failed { code: cancel_timeout / cancel_threw / not_registered }` |
| Archive | terminal run（`completed` / `failed` / `blocked`） | 在 run record 写 `archivedAt`，dashboard 默认隐藏 | 列表上方有 `Show archived` toggle 可显示历史 |

操作者身份默认走 server 端 `"system"` 兜底；HTTP `x-issuepilot-operator` header 留作
V3 RBAC 接入口。

### 13.5 Phase 3：CI 状态回流

把 `WORKFLOW.md` 或 team config 的 `ci.enabled` 打开，orchestrator 在 `human-review`
阶段会按 `poll_interval_ms` 节奏读 MR 最新 pipeline 状态：

```yaml
ci:
  enabled: true
  on_failure: ai-rework         # 或 human-review
  wait_for_pipeline: true
```

行为矩阵：

| pipeline 状态 | `on_failure` | 行为 |
| --- | --- | --- |
| `success` | — | 保持 `human-review`，dashboard 标记可 review |
| `failed` | `ai-rework` | label 翻到 `ai-rework` + 写带 `<!-- issuepilot:ci-feedback:<runId> -->` marker 的 note |
| `failed` | `human-review` | 不动 labels，仅写一条 marker note + emit `ci_status_observed { action: "noop" }` |
| `running` / `pending` / `unknown` | — | 保持 `human-review`，等下一轮 poll，不写 note |
| `canceled` / `skipped` | — | 写一条提示人工 review 的 marker note + emit `ci_status_observed { action: "manual" }` |

约束：

- scanner 是在 daemon 启动时一次性接到 main loop 上的；**修改 `ci.enabled` 必须
  重启 `issuepilot run`** 才会生效。
- precedence：`projects[].ci` > team `ci` > workflow `ci`，要 override 必须三个键
  齐发，不支持半 override。
- 自动 merge 仍不在 V2 范围内。

### 13.6 Phase 4：review feedback sweep

每轮 poll 在 `human-review` 阶段，orchestrator 会扫对应 MR 的人类评论（自动跳过
GitLab system note 与自己写的 marker note），结构化为 `ReviewFeedbackSummary` 写回
run record。

- dashboard run detail 页底部新增 `Latest review feedback` 面板：展示 MR 链接、
  最近 sweep 时间、每条评论的 author / time / resolved badge / 截断 body，并附跳回
  MR note 的深链接。
- issue 被人工打回 `ai-rework` 后，下一轮 dispatch 会把 summary 拼成标准化的
  `## Review feedback` markdown 块注入到 prompt 之前；reviewer 的内容会用
  `<<<REVIEWER_BODY id=N>>> ... <<<END_REVIEWER_BODY>>>` envelope 包起来防止
  prompt injection。
- 始终开启；没有 MR 或没有评论时是 no-op，不需要 workflow 开关。
- 不会触发自动 merge，也不会替代 Phase 3 CI 回流。

### 13.7 Phase 5：workspace retention 自动清理

默认 retention policy（可在 workflow 或 team config 顶层 `retention` 节覆盖）：

| Run 状态 | 默认保留 |
| --- | --- |
| active / running / stopping / claimed / retrying | 永不自动清理 |
| successful / closed | 7 天 |
| failed / blocked | 30 天 |
| archived terminal | 按原终态保留期计算 |

约束：

- 总 workspace 超过 `max_workspace_gb`（默认 50）时**只允许**清理已过期的 terminal
  run；容量压力不会成为删除 active 或未过期失败现场的理由。
- 失败 worktree 会在清理时保留 `.issuepilot/failed-at-*` marker；marker 默认不被删。
- cleanup 三段式事件：`workspace_cleanup_planned` → `workspace_cleanup_completed`
  / `workspace_cleanup_failed`，落到 sentinel `runId=workspace-cleanup`，可通过
  `/api/events?runId=workspace-cleanup` 或 dashboard timeline 查到。
- **限制：V2 team daemon 目前只会解析 `retention` schema、不会自动跑 cleanup loop。**
  团队场景下若想启用 cleanup，目前的做法是：用 V1 入口 `issuepilot run --workflow ...`
  逐个项目启动 daemon；team-mode wiring 列在 Phase 5 follow-up。

#### dry-run 预览

不启动 daemon 也可以预览将被清理的目录：

```bash
issuepilot doctor --workspace --workflow /path/to/target-project/WORKFLOW.md
```

输出示例（无 daemon 时 run state 不可读，所有目录默认 `unknown`，planner 拒删；
真实预览应 tail `workspace_cleanup_planned` 事件）：

```text
Workspace cleanup dry-run
  workspace root: ~/.issuepilot/workspaces
  entries: 14
  total usage: 2.471 GB (cap 50 GB)
  will delete: 0
  keep failure markers: 3
```

#### 操作 runbook

误删 / 失败诊断 / 临时禁用 cleanup 等场景，参见：
[`docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md`](./superpowers/runbooks/2026-05-15-workspace-cleanup.md)。

### 13.8 V2 边界

V2 主体已完成，但以下条目**显式不在 V2 范围**，会在 V3 / V4 处理：

- 多用户 RBAC、token / 预算 / 配额。
- 远程 worker、Docker / K8s sandbox。
- 自动 merge、跨 issue 依赖规划、auto-decomposition。
- Postgres / SQLite 作为强依赖的长期 run history。
- 多 tracker 插件化、GitLab 之外的 issue tracker。
- 远端 `ai/*` 分支清理与 MR 自动归档。
