# IssuePilot Agent 指南

本仓库现在作为公司内部 IssuePilot 的工作区使用。它最初是 OpenAI Symphony 的 fork，但内部产品方向是基于 TypeScript 的 IssuePilot。

## 回复语言

- 后续 agent 在本仓库内工作时，默认使用中文回答。
- 代码、命令、配置项、日志字段、API 名称和文件路径保持原文，不强行翻译。
- 如果用户明确要求英文或中英双语，再按用户要求调整。

## 事实来源

- 在规划或实现 IssuePilot 相关工作前，先阅读 `docs/superpowers/specs/2026-05-11-issuepilot-design.md`。
- `SPEC.md` 和 `elixir/` 是 Symphony 的协议和参考实现材料，不是内部生产架构的直接复制对象。
- 如果修改产品行为、架构、workflow labels、runner 行为或路线图范围，必须在同一变更中更新 IssuePilot 设计 spec。

## 项目方向

IssuePilot P0 是：

- GitLab Issue 驱动。
- 基于 label 表达状态：`ai-ready`、`ai-running`、`human-review`、`ai-rework`、`ai-failed`、`ai-blocked`。
- 第一版就使用 Codex app-server。
- 使用 TypeScript 实现，orchestrator 是独立 Node daemon，dashboard 使用 Next.js。
- 使用 `~/.issuepilot` 下的 git worktree workspace。

除非用户明确要求 prototype 工作，否则不要通过扩展 Elixir prototype 来实现内部产品。

## 仓库边界

- 根目录规则适用于整个仓库。
- `elixir/AGENTS.md` 适用于 `elixir/` 内部变更，修改 Symphony Elixir 参考实现时必须遵守。
- 新的 IssuePilot 实现代码应遵循设计 spec 中的目录规划：
  - `apps/orchestrator`
  - `apps/dashboard`
  - `packages/core`
  - `packages/workflow`
  - `packages/tracker-gitlab`
  - `packages/workspace`
  - `packages/runner-codex-app-server`
  - `packages/observability`
  - `packages/shared-contracts`

## 实现规则

- P0 聚焦本地单机闭环，不提前扩展团队服务能力。
- orchestrator 必须独立于 Next.js。Next.js 只负责 dashboard。
- orchestrator HTTP API 使用 Fastify。
- dashboard UI 使用 Tailwind/shadcn。
- GitLab 凭据从 `tracker.token_env` 配置的环境变量读取；不要把 token 写入 workflow 文件、日志、dashboard 数据或 prompt。
- mirror、worktree、branch、fetch、push 等 Git 操作优先通过 `execa` 调用真实 Git CLI。
- Codex 的 cwd 和 sandbox 必须限制在当前 issue worktree。
- 失败运行需要保留 workspace 和 event logs，便于排障。

## 验证要求

文档类变更至少运行：

```bash
git diff --check
```

后续 TypeScript 实现变更需要为触达的 package 添加并运行针对性测试。项目脚本建立后，交付前优先运行相关完整本地检查。

## Git 规范

- 不要触碰无关的未跟踪文件或用户改动。
- 除非用户明确要求，不要 rewrite history，也不要 reset worktree。
- commit 保持边界清晰：设计/spec 更新和实现代码分开提交。
