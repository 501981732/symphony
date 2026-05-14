# IssuePilot 快速上手

[English](./getting-started.md) | 简体中文

本指南面向第一次使用 IssuePilot 的工程师。目标是把一个 GitLab Issue 自动跑成一条分支、一个 Merge Request 和一条 Issue 回写说明。

最快路径只需要记住两件事：

- **IssuePilot 仓库**：你在这里安装、登录、启动 orchestrator 和 dashboard。
- **目标项目仓库**：真正要被 AI 修改的业务仓库，里面需要放 `.agents/workflow.md`。

```text
/path/to/issuepilot
  运行：pnpm smoke / pnpm dev:dashboard / pnpm exec issuepilot ...

/path/to/target-project
  存放：.agents/workflow.md
  被 IssuePilot 创建 worktree 后修改
```

---

## 1. IssuePilot 做什么

IssuePilot 是本地单机 orchestrator。它会：

1. 轮询 GitLab，找到带 `ai-ready` label 的 Issue。
2. 为每个 Issue 在 `~/.issuepilot` 下创建独立 git worktree。
3. 在 worktree 里启动 `codex app-server`，让 Codex 完成代码修改。
4. 推送分支，创建或更新 MR，给 Issue 写 handoff note。
5. 把 Issue label 从 `ai-running` 切到 `human-review`、`ai-failed` 或 `ai-blocked`。

P0 是本地开发工具，不是 SaaS、集群或自动合并系统。MR 合并前必须人工 review。

---

## 2. 准备环境

在 **IssuePilot 仓库**里执行：

```bash
corepack enable
pnpm install
pnpm -F @issuepilot/orchestrator build
pnpm exec issuepilot doctor
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

## 4. 配置 `.agents/workflow.md`

在 **目标项目仓库**根目录创建 `.agents/workflow.md`，并提交到目标项目默认分支。
这里只放配置，不在目标项目里启动 IssuePilot。

```bash
cd /path/to/target-project
mkdir -p .agents
$EDITOR .agents/workflow.md
```

创建后拿到它的绝对路径，并复制这条路径。后续在 IssuePilot 仓库启动 daemon 时，`--workflow` 需要传这个路径：

```bash
WORKFLOW_PATH="$(pwd)/.agents/workflow.md"
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
git add .agents/workflow.md
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

然后在 **IssuePilot 仓库**里登录：

```bash
pnpm exec issuepilot auth login --hostname gitlab.example.com --client-id <oauth-application-id>
pnpm exec issuepilot auth status --hostname gitlab.example.com
```

`--client-id` 是 OAuth Application 的公开 Application ID，不是 Application Secret，也不是 Access Token。

如果你同时使用两套公司 GitLab，需要分别登录：

```bash
pnpm exec issuepilot auth login --hostname gitlab.chehejia.com --client-id <oauth-application-id>
pnpm exec issuepilot auth login --hostname gitlabee.chehejia.com --client-id <oauth-application-id>
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

不要把 token 写进 `.agents/workflow.md`、Issue、prompt 或日志。

---

## 6. 验证 workflow

在 **IssuePilot 仓库**里执行：

```bash
cd /path/to/issuepilot
# 如果这是新终端，把第 4 节复制的绝对路径重新放进变量
export WORKFLOW_PATH="/path/to/target-project/.agents/workflow.md"
pnpm exec issuepilot validate --workflow "$WORKFLOW_PATH"
```

成功时应该看到：

```text
Workflow loaded: /path/to/target-project/.agents/workflow.md
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

推荐用 smoke wrapper，它会等待 daemon ready：

```bash
cd /path/to/issuepilot
export WORKFLOW_PATH="/path/to/target-project/.agents/workflow.md"
pnpm smoke --workflow "$WORKFLOW_PATH"
```

也可以直接启动：

```bash
cd /path/to/issuepilot
export WORKFLOW_PATH="/path/to/target-project/.agents/workflow.md"
pnpm exec issuepilot run --workflow "$WORKFLOW_PATH" --port 4738 --host 127.0.0.1
```

ready 后会看到 API 地址，默认是：

```text
API: http://127.0.0.1:4738
```

### 7.2 终端 B：启动 dashboard

```bash
cd /path/to/issuepilot
pnpm dev:dashboard
```

打开：

```text
http://localhost:3000
```

dashboard 默认连接 `http://127.0.0.1:4738`。如果 orchestrator 用了其他端口，启动 dashboard 时指定：

```bash
NEXT_PUBLIC_API_BASE=http://127.0.0.1:4839 pnpm dev:dashboard
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
cd /path/to/issuepilot
export WORKFLOW_PATH="/path/to/target-project/.agents/workflow.md"
pnpm exec issuepilot doctor

# OAuth 登录
pnpm exec issuepilot auth login --hostname <gitlab-host> --client-id <oauth-application-id>
pnpm exec issuepilot auth status --hostname <gitlab-host>
pnpm exec issuepilot auth logout --hostname <gitlab-host>

# 校验 workflow
pnpm exec issuepilot validate --workflow "$WORKFLOW_PATH"

# 启动 orchestrator
pnpm smoke --workflow "$WORKFLOW_PATH"
pnpm exec issuepilot run --workflow "$WORKFLOW_PATH"

# 启动 dashboard
pnpm dev:dashboard
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
pnpm exec issuepilot auth login --hostname <host> --client-id <oauth-application-id>
```

**GitLab 401 / 403**

检查 token 是否 export 到启动 daemon 的同一个 shell、是否有 `api` scope、是否能访问目标项目。修复后重启 orchestrator。

**dashboard 显示 `orchestrator unreachable`**

dashboard 只是前端。必须另开一个终端启动 orchestrator：

```bash
cd /path/to/issuepilot
export WORKFLOW_PATH="/path/to/target-project/.agents/workflow.md"
pnpm smoke --workflow "$WORKFLOW_PATH"
```

如果 orchestrator 不在 `4738`，用 `NEXT_PUBLIC_API_BASE` 指定地址。

**怎么知道 IssuePilot 写的 note 对应哪个 run？**

Issue note 第一行有 marker：

```text
<!-- issuepilot:run:<runId> -->
```

---

## 12. 下一步

- 架构细节：[`docs/superpowers/specs/2026-05-11-issuepilot-design.md`](./superpowers/specs/2026-05-11-issuepilot-design.md)
- 完整 smoke runbook：[`docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`](./superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md)
- 更新记录：[`CHANGELOG.md`](../CHANGELOG.md)
