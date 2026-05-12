# IssuePilot

[English](README.md) | [简体中文](README.zh-CN.md)

IssuePilot 是一个开源的本地 AI 工程调度器，用 GitLab Issue 驱动 Codex
实现工作。

它会监听 GitLab Issue，通过 label 认领任务，创建隔离的 git worktree，
通过 app-server 协议运行 Codex，记录可审计事件轨迹，并把结果以 Merge
Request 的形式交给人工 Review。

本项目起源于 OpenAI Symphony 的 fork。当前产品方向是 TypeScript 优先、
GitLab 优先；原 Symphony spec 和 Elixir 实现仍保留在仓库中，作为参考材料。

> [!WARNING]
> IssuePilot 仍处于 P0 活跃开发阶段。首个稳定版本发布前，package API、CLI
> 行为和 workflow 文件格式都可能调整。

## 为什么需要 IssuePilot？

Coding agent 最适合从工程师已经在管理的工作单元开始执行。IssuePilot 把
Issue Tracker 当作控制平面：

- 工程师在 GitLab Issue 中描述工作。
- label 表达状态：ready、running、review、rework、failed、blocked。
- 每次运行都发生在 `~/.issuepilot` 下独立的 worktree 中。
- Codex 收到有边界的 prompt，并被限制在当前 workspace 内。
- orchestrator 写入事件、日志、Issue note、分支和 Merge Request。
- 人类 Review MR，而不是盯着每一轮 agent 会话。

P0 的目标是跑通本地单机闭环，不是提供托管的多租户服务。

## 当前状态

本仓库已经实现：

- 基于 pnpm、Turborepo、Vitest、ESLint、Prettier 的 TypeScript monorepo。
- workflow 解析、校验、默认值、环境变量检查和 prompt 渲染。
- GitLab issue、label、note、Merge Request、pipeline adapter 边界。
- 通过 `execa` 调用真实 `git` 命令的 workspace 管理。
- Codex app-server JSON-RPC client 组件和动态 GitLab tool 契约。
- observability 基础能力：redaction、event bus、event store、run store、logger。
- orchestrator 模块：claim、dispatch、retry、reconcile、runtime state、HTTP API、
  SSE、CLI scaffold。
- dashboard skeleton。

仍在稳定中：

- 端到端 daemon bootstrap。
- 完整只读 dashboard。
- 真实 GitLab + 真实 Codex smoke 文档。
- 公开 package 与版本化 release。

## 工作方式

```text
GitLab issue 带 ai-ready label
  -> IssuePilot 用 ai-running 认领
  -> IssuePilot 创建或复用隔离 worktree
  -> Codex app-server 在该 worktree 内运行
  -> 代码被 commit 并 push 到分支
  -> GitLab Merge Request 被创建或更新
  -> Issue 收到 handoff note
  -> label 切换到 human-review、ai-failed 或 ai-blocked
```

P0 labels：

| Label          | 含义                              |
| -------------- | --------------------------------- |
| `ai-ready`     | IssuePilot 可以拾取的候选 Issue。 |
| `ai-running`   | 已认领，并且有活跃 run。          |
| `human-review` | MR 已准备好等待人工 Review。      |
| `ai-rework`    | 人工 Review 后要求 AI 再跑一轮。  |
| `ai-failed`    | 运行失败，需要人工介入。          |
| `ai-blocked`   | 缺少信息、权限或 secret。         |

## 仓库结构

```text
apps/
  orchestrator/                  本地 daemon、CLI、HTTP API 和 run loop
  dashboard/                     只读 Next.js dashboard

packages/
  core/                          共享领域基础类型
  workflow/                      .agents/workflow.md parser 和 renderer
  tracker-gitlab/                GitLab issue、label、note、MR、pipeline adapter
  workspace/                     mirror、worktree、branch、hook、cleanup 逻辑
  runner-codex-app-server/       Codex app-server JSON-RPC 集成
  observability/                 redaction、events、run store、logging
  shared-contracts/              orchestrator 和 dashboard 共享类型

docs/superpowers/
  specs/                         产品和架构 spec
  plans/                         实现计划

elixir/                          原 Symphony 参考实现
SPEC.md                          原 Symphony 语言无关 spec
```

## 环境要求

- Node.js `>=22 <23`
- pnpm `10.x`
- Git
- 真实运行需要 GitLab project 和 token
- 真实运行需要支持 app-server 的 Codex

根目录 `.npmrc` 开启了严格 engine 检查。

## 开发设置

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
```

常用命令：

```bash
pnpm build
pnpm lint
pnpm format:check
pnpm --filter @issuepilot/workflow test
pnpm --filter @issuepilot/orchestrator test
```

CLI 的完整 daemon 执行仍在接线中。构建后，可以通过 orchestrator package
运行当前 scaffolded checks：

```bash
pnpm build
node apps/orchestrator/dist/cli.js doctor
node apps/orchestrator/dist/cli.js validate --workflow path/to/workflow.md
```

## Workflow 文件

IssuePilot 期望每个目标仓库提供一个 agent 契约文件：

```text
.agents/workflow.md
```

该文件由两部分组成：YAML front matter 作为机器可读配置，Markdown body
作为传给 agent 的 prompt。

最小结构：

```md
---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
  token_env: "GITLAB_TOKEN"
  active_labels: ["ai-ready", "ai-rework"]
  running_label: ai-running
  handoff_label: human-review
  failed_label: ai-failed
  blocked_label: ai-blocked

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

You are the AI engineer for this repository.

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
URL: {{ issue.url }}

{{ issue.description }}
```

secret 从 `tracker.token_env` 指定的环境变量读取，不能提交到 workflow 文件中。

## 安全模型

IssuePilot 面向可信本地开发环境。

P0 的重要边界：

- GitLab token 从环境变量读取。
- 类 token 值在写入日志、事件、store 或 API response 前会被 redacted。
- Codex 使用 workflow 定义的 sandbox，但 workflow 文件不能请求
  `danger-full-access` 或 `dangerFullAccess`。
- Codex 的工作目录限制在当前 Issue worktree 内。
- 失败 run 会保留 workspace 数据和 event logs，便于排障。

合并前仍然需要 Review 生成的代码。IssuePilot 创建的是可 Review 的 Merge
Request，不替代代码审查。

## 文档

- [IssuePilot design spec](docs/superpowers/specs/2026-05-11-issuepilot-design.md)
- [IssuePilot implementation plan](docs/superpowers/plans/2026-05-11-issuepilot-implementation-plan.md)
- [Original Symphony spec](SPEC.md)
- [Elixir reference implementation](elixir/README.md)

## 贡献

项目仍处于早期，欢迎贡献。当前最有价值的贡献包括：

- 带有明确命令、日志和环境信息的 bug report。
- 收紧 workflow、GitLab、workspace、runner 或 orchestrator 契约的测试。
- 让本地设置更容易复现的文档修正。
- 聚焦的 PR，并且将 TypeScript 实现改动和设计 spec 更新保持清晰边界。

提交 PR 前，请运行与变更相关的检查：

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

如果变更影响产品行为、架构、workflow labels、runner 行为或 roadmap 范围，
请在同一个 PR 中更新 IssuePilot design spec。

## License

IssuePilot 使用 [Apache License 2.0](LICENSE) 授权。
