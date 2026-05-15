# IssuePilot

[English](README.md) | [简体中文](README.zh-CN.md)

> 开发项目管理常常需要监督编码代理：盯任务进度、催 PR、查 CI 状态、来回手动
> 协调验收，效率被切碎在一次次"代理报告进度"上。
>
> **IssuePilot 把项目工作转化为隔离的自主实现 run，让团队回到管理工作本身，
> 而不是监督编码代理。** 每个 GitLab Issue 都会被转成一次有边界的 run：独立
> worktree、独立 prompt、独立事件流、可审计的工作证明，最终以 Merge Request
> 的形式交付给人工 Review，而不是让工程师在每一轮 agent 对话里轮值。

IssuePilot 是一个开源的本地 AI 工程调度器，用 GitLab Issue 驱动 Codex
实现工作。

它会监听 GitLab Issue，通过 label 认领任务，创建隔离的 git worktree，
通过 app-server 协议运行 Codex，记录可审计事件轨迹，并把结果以 Merge
Request 的形式交给人工 Review；人工 merge 该 MR 后，IssuePilot 会自动关闭
对应的 GitLab Issue。

### 核心亮点

- **Issue 驱动的工作认领**：监听 GitLab Issue 看板，自动认领带 `ai-ready`
  label 的 Issue 并生成隔离 run，工程师无需逐条派发。
- **完整的工作证明**：每次 run 输出 CI 状态、MR 描述与 review 链接、reconciliation
  事件流、JSONL event store 与 dashboard timeline，关键节点可追溯、可回放。
- **可信交付边界**：失败 / 阻塞自动落到 `ai-failed` / `ai-blocked`，workspace
  与日志原地保留供取证；secret 不会泄露到日志、事件、API 响应或 prompt。
- **人工 Review 后自动收尾**：IssuePilot 不自动 merge 代码；人类 merge 生成的
  MR 后，daemon 会写 final note、移除 `human-review`，并关闭 GitLab Issue。
- **零手工 token 维护**：内置 `issuepilot auth login` 走 GitLab OAuth 2.0
  Device Flow，token 加密存放在 `~/.issuepilot/credentials`（`0600`）并自动
  refresh；遇到 401 daemon 静默换发新 token 并重试一次。仍兼容 PAT/Group Token
  via `tracker.token_env` 的环境变量路径。
- **本地单机闭环**:`~/.issuepilot` 下落盘的 worktree + JSONL + run record，
  daemon 重启可恢复 reconciliation，不依赖外部数据库。
- **与 harness engineering 互补**：面向已经做好 agent harness 的成熟项目使用
  ——IssuePilot 负责调度与隔离，仓库内 `WORKFLOW.md` 描述提示词与策略。
- **公开 SPEC + 参考实现**:`SPEC.md` 与 Symphony Elixir 参考实现保留在仓库
  内，便于团队按需要自建其他语言版本。

本项目起源于 OpenAI Symphony 的 fork。当前产品方向是 TypeScript 优先、
GitLab 优先；原 Symphony spec 和 Elixir 实现仍保留在仓库中，作为参考材料。

> [!WARNING]
> IssuePilot 已闭合 P0 本地闭环，当前处于 V1 本地试点加固阶段。本地 tarball
> 安装路径已经可用，但 release tag、真实 smoke evidence 归档，以及本地 API /
> CLI 的稳定兼容窗口仍在锁定中。

## 为什么需要 IssuePilot？

Coding agent 最适合从工程师已经在管理的工作单元开始执行。IssuePilot 把
Issue Tracker 当作控制平面：

- 工程师在 GitLab Issue 中描述工作。
- label 表达状态：ready、running、review、rework、failed、blocked。
- 每次运行都发生在 `~/.issuepilot` 下独立的 worktree 中。
- Codex 收到有边界的 prompt，并被限制在当前 workspace 内。
- orchestrator 写入事件、日志、Issue note、分支和 Merge Request。
- 人类 Review MR，而不是盯着每一轮 agent 会话。
- MR 被人工 merge 后，IssuePilot 会把 GitLab Issue reconcile 到 closed 终态。

P0 的目标是跑通本地单机闭环，不是提供托管的多租户服务。

## 与 OpenAI Symphony 的异同

IssuePilot 起源于 OpenAI Symphony 的 fork，因此 **整体架构思路是一脉相承
的**：都把 Issue Tracker 当作控制平面、都用 per-issue workspace 隔离 agent、
都通过 Codex app-server 协议执行实现工作、都把工作流策略以仓库内文件的形式
做版本化、都通过 ticket / 文件系统驱动重启恢复，而不是依赖外部数据库。

差异主要发生在**目标场景**与**实现选择**：

| 维度          | OpenAI Symphony（参考实现，Elixir）              | IssuePilot（本仓库的产品方向）                                                  |
| ------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| 定位          | 公开的 prototype，鼓励 fork 自建加固版           | 公司内部的 P0 生产方向，目标是落地到内部工程团队日常使用                        |
| Issue Tracker | Linear                                           | GitLab（Group Access Token / Personal Token，本地 SaaS / Self-managed 都支持）  |
| 状态机表达    | 基于 Linear issue **status**（state-based）      | 基于 GitLab **label**（`ai-ready` / `ai-running` / `human-review` / …）         |
| 工作流契约    | `WORKFLOW.md`（仓库根）                          | `WORKFLOW.md`（YAML front matter + Markdown prompt）                            |
| 实现语言      | Elixir / OTP                                     | TypeScript / Node.js 22 LTS                                                     |
| 运行形态      | 单进程 Elixir 服务 + 可选 status surface         | orchestrator（Fastify daemon）+ 只读 Next.js dashboard（Tailwind/shadcn）       |
| 工作区策略    | 每 Issue 独立 workspace                          | bare mirror + git worktree（`~/.issuepilot/{repos,workspaces,state}`）          |
| 事件 / 日志   | 结构化日志 + 可选 status surface                 | JSONL event store + 原子 run record + SSE 实时流 + pino structured logging      |
| MR/PR 处理    | 由 agent 通过 workflow 内的 tools 自行 push / 写 | adapter 直接 push / 创建 MR，并提供 orchestrator post-run reconciliation 兜底   |
| 重启恢复      | tracker + 文件系统驱动                           | label 状态 + handoff note marker（`<!-- issuepilot:run:<runId> -->`）驱动       |
| 安全姿态      | 实现自行声明 trust posture                       | 拒绝 `danger-full-access` sandbox、token 全链路 redact、Codex cwd 限定 worktree |
| 公开 SPEC     | `SPEC.md` v1 (language-agnostic)                 | `SPEC.md` 保留为参考；产品 spec 见 `docs/superpowers/specs/`                    |
| 当前状态      | 评估用 prototype，建议自行加固后使用             | V1 本地试点可用，release lock 仍待 evidence / tag 归档                         |

如果你需要的是 Linear + Elixir 路线的参考实现，请直接看
[`elixir/`](elixir/README.md) 与 [`SPEC.md`](SPEC.md)。如果你需要的是
GitLab + TypeScript 路线、并打算在内部团队范围内试运行，那么本仓库根目录
的 IssuePilot 实现就是你要的版本。

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
- human-review reconciliation：MR 仍 open 时保持 Review，MR merged 后关闭
  Issue，MR closed 但未 merge 时回流到配置的 rework label。
- 只读 dashboard：overview、run detail、SSE 刷新、timeline、tool calls 和 log tail
  展示。
- 端到端测试 harness（`tests/e2e`）：内置带状态的 fake GitLab + 可脚本化的 fake
  Codex app-server，覆盖 happy path、retry 路径（`turn/timeout` → ai-failed
  耗尽 `max_attempts`）、failure 路径（`turn/failed` → ai-failed + 结构化
  failure note）、permission/escalation 路径（claim 401/403 → ai-blocked +
  结构化 blocked note + `claim_failed` 事件）和 approval 自动批准路径。
  happy path 同时覆盖人工 merge MR 后写入结构化 closing note 并自动关闭 Issue。
- 真实 GitLab smoke runbook + `pnpm smoke` wrapper：拉起 orchestrator、轮询
  `/api/state` 至 ready、打印 API + dashboard URL、转发 SIGINT/SIGTERM 并在 5s
  内升级 SIGKILL 兜底。

当前 V1 进度：

- V1 本地 CLI 打包已经可通过 `pnpm release:pack` 生成；生成的 tarball 会安装
  `issuepilot` 可执行命令，供本地试点使用。
- `pnpm release:check` 已通过，覆盖 format、lint、typecheck、build、unit
  tests、fake E2E、安装态 smoke、smoke runner 和 `git diff --check`。
- 安装态 `issuepilot --version`、`issuepilot doctor`、`issuepilot validate`、
  `issuepilot run` 与 `issuepilot dashboard` 已完成本机验证。
- 真实 GitLab smoke 已由操作者确认通过；Issue / MR / dashboard evidence 链接待归档。
- 当前仍是本地 tarball release，还不是发布到 npm registry 的公开包。

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
  -> 人工 Review 并手动 merge MR
  -> IssuePilot 写 closing note，移除 human-review，并关闭 Issue
```

P0 labels：

| Label          | 含义                                                     |
| -------------- | -------------------------------------------------------- |
| `ai-ready`     | IssuePilot 可以拾取的候选 Issue。                        |
| `ai-running`   | 已认领，并且有活跃 run。                                 |
| `human-review` | MR 已准备好等待人工 Review。                             |
| `ai-rework`    | 人工 Review 后要求 AI 再跑一轮，或 MR 被关闭但未 merge。 |
| `ai-failed`    | 运行失败，需要人工介入。                                 |
| `ai-blocked`   | 缺少信息、权限或 secret。                                |

## 仓库结构

```text
apps/
  orchestrator/                  本地 daemon、CLI、HTTP API 和 run loop
  dashboard/                     只读 Next.js dashboard

packages/
  core/                          共享领域基础类型
  workflow/                      WORKFLOW.md parser 和 renderer
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

## 快速开始

> 详细步骤见 **[使用指南（中文）](docs/getting-started.zh-CN.md)**，以下是最短路径。

**第一步：构建并安装本地 V1 包**

```bash
corepack enable
pnpm install
pnpm release:pack
npm install -g ./dist/release/issuepilot-0.1.0.tgz
```

**第二步：检查本机环境**

```bash
issuepilot doctor
```

期望全部 `[OK]`：Node.js ≥22、git、codex app-server、`~/.issuepilot/state` 可写。

**第三步：在目标项目里创建 `WORKFLOW.md`**

拷贝 [`.agents/workflow.example.md`](.agents/workflow.example.md) 到目标项目的 `WORKFLOW.md`，把 `gitlab.example.com`、`group/project` 等占位符替换成实际值，并 commit 推送。

**第四步：验证 workflow 配置**

```bash
export GITLAB_TOKEN="<your-token>"
issuepilot validate --workflow /path/to/target-project/WORKFLOW.md
```

**第五步：启动 daemon + dashboard**

```bash
# 终端 A — 启动 orchestrator（自动等 ready 后打印 API / Dashboard URL）
issuepilot run --workflow /path/to/target-project/WORKFLOW.md

# 终端 B — 启动 dashboard
issuepilot dashboard
```

打开 `http://localhost:3000`，给目标项目的某个 Issue 打上 `ai-ready` label，IssuePilot 即自动接管。

---

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
pnpm release:check
pnpm --filter @issuepilot/workflow test
pnpm --filter @issuepilot/orchestrator test
```

贡献者开发时，也可以继续从 workspace 根目录运行 CLI：

```bash
pnpm build
pnpm exec issuepilot doctor
pnpm exec issuepilot validate --workflow path/to/workflow.md
```

## Workflow 文件

IssuePilot 期望每个目标仓库提供一个 agent 契约文件：

```text
WORKFLOW.md
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

## Roadmap

下面是 IssuePilot 的版本路线图。完整内容以
[`docs/superpowers/specs/2026-05-11-issuepilot-design.md`](docs/superpowers/specs/2026-05-11-issuepilot-design.md)
§20 为准；本节只做摘要，便于先快速判断"现在能用到什么、未来会扩到哪里"。

### P0 — 本地单机闭环（已闭合）

已完成本地单机闭环：

- ✅ 本地 daemon（orchestrator）+ Fastify HTTP API + SSE。
- ✅ GitLab Issue label 驱动的状态机（`ai-ready` → `ai-running` →
  `human-review` / `ai-failed` / `ai-blocked` / `ai-rework`）。
- ✅ Codex app-server runner（thread/turn 生命周期 + 14 类标准化事件）。
- ✅ bare mirror + git worktree workspace，失败 run 现场保留。
- ✅ MR 自动创建/更新 + 带 marker 的结构化 handoff note 恢复机制。
- ✅ 结构化 failure / blocked note：包含状态、run、branch、原因和下一步动作。
- ✅ human-review 自动收尾：人工 merge MR 后关闭 GitLab Issue；MR closed 但
  未 merge 时回流到配置的 rework label。
- ✅ 结构化 closing note：IssuePilot 移除 `human-review` 并关闭 Issue 时写入。
- ✅ 只读 Next.js dashboard（overview + run detail + SSE timeline）。
- ✅ fake GitLab + fake Codex 全闭环 E2E + 真实 GitLab smoke runbook。
- ✅ 可安装本地 CLI tarball，支持安装态 `issuepilot run` 与
  `issuepilot dashboard` 启动路径。
- ✅ `pnpm release:check` 作为 release evidence 门禁。
- ✅ 真实 GitLab smoke 已由操作者确认通过，固定 evidence 链接待归档。
- ✅ source-checkout 方式继续作为贡献者开发和紧急回滚路径保留。

### V1 — 稳定本地发布

目标：不改变单机执行模型，把当前闭环变成可安装、可重复、适合内部试点团队使用
的稳定版本。

- ✅ 通过 npm-compatible package tooling 提供可安装 CLI 分发，安装后暴露
  `issuepilot` 可执行命令。
- ✅ 安装后的本地启动路径：`issuepilot run --workflow ...` 启动 daemon/API，并提供
  已安装的 dashboard 启动命令。
- ✅ release gate 组合单测、fake E2E、smoke wrapper、安装态 CLI smoke 和
  `git diff --check`。
- ✅ 安装态 daemon / dashboard 启动路径和真实 GitLab smoke 已通过本地试点验证。
- ✅ auth refresh、token rotation、日志脱敏、failed / blocked run 排障的运维文档。
- 🚧 版本化 tag，包含 release notes、回滚说明和本地闭环兼容性预期。
- 🚧 本地闭环所需的 workflow schema、event contract、CLI 命令和 dashboard API
  稳定下来。
- ✅ source-checkout 继续作为贡献者开发和紧急回滚路径保留。

### V2 — 团队可运营版本

目标：从"个人单机"升级到"团队共享"，能在内网或团队机器上跑日常工作。

- 🚧 Phase 1 foundation：实验性 `issuepilot run --config
  /path/to/issuepilot.team.yaml` team mode，用于多项目加载、lease-backed
  调度和 project-aware dashboard state。
- 部署到团队共享机器或内网服务（multi-user 友好）。
- 单 daemon 支持多项目 workflow 配置。
- 并发从 1 扩展到 2–5，配套槽位调度与租约策略。
- ✅ dashboard 基础操作 `retry` / `stop` / `archive run` 已交付（V2 Phase 2，stop 走真实 `turn/interrupt`）。
- CI 状态读取 + CI 失败自动回流到 `ai-rework`。
- PR / MR review feedback sweep（把人工 review 评论喂回下一轮 agent）。
- review 工作流打磨：在 dashboard 和生成报告中直接展示结构化 handoff /
  failure / closing note 字段。
- 可选自动 merge 策略（满足 CI / approval 后）。P0 默认仍由人类控制 merge。
- 更完整的运行报告：diff summary、测试结果、风险点、耗时分解。
- workspace 清理与保留策略（按时间 / 大小 / 状态分级）。

### V3 — 生产化执行平台

目标：可以作为内部"AI 工程执行平台"运行，具备权限、预算、可观测性。

- 多 worker 支持：本机、SSH worker、容器 worker 可插拔。
- Docker / Kubernetes sandbox（替代单机 sandbox 模型）。
- token / 时长 / 并发 / 成本预算控制。
- 权限模型：项目级、团队级、管理员级。
- Webhook + poll 混合调度，减少轮询延迟。
- 更强的 GitLab 审计 + 全链路 secret redaction。
- Postgres / SQLite 持久化 run history（替代 JSONL 单机存储）。
- OpenTelemetry / Loki / Grafana 或内部观测平台集成。

### V4 — 智能研发工作台

目标：超越"单 Issue 单 run"的模型，做面向研发流程的智能工作台。

- 自动拆分大 Issue 为子任务，子任务之间编排执行。
- 跨 Issue 的依赖与 blocker 分析。
- 多 agent 协作 + 独立 reviewer agent。
- 自动生成验收材料：截图、录屏、Playwright walkthrough video。
- agent 成功率、返工率、CI 通过率、review 命中率等质量指标。
- workflow / skills 推荐与持续改进闭环。
- 支持更多执行器，例如 Claude Code 或内部 coding agent。

> Roadmap 内容会随实际进展调整，每次较大变更都会同步更新 design spec 和
> `CHANGELOG.md`，请以 spec 为准。

## 文档

- **[使用指南（中文）](docs/getting-started.zh-CN.md)** — 第一次跑 IssuePilot？从这里开始。30 分钟内跑通你第一个 ai-ready Issue 的端到端流程。
- [Getting Started (English)](docs/getting-started.md) — 英文版使用指南。
- [IssuePilot 真实 Smoke Runbook](docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md) — 真实 GitLab + Codex 的端到端验证清单。
- [IssuePilot design spec](docs/superpowers/specs/2026-05-11-issuepilot-design.md) — 架构、协议、状态机细节。
- [IssuePilot implementation plan](docs/superpowers/plans/2026-05-11-issuepilot-implementation-plan.md) — 8 Phase 实施计划与 Task 清单。
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
