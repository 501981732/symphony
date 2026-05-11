# Changelog

本仓库的所有显著变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Added

- 2026-05-11 — **IssuePilot P0 Phase 1（M1 Skeleton）完成。** 落地 pnpm workspace + Turborepo + TypeScript 项目引用，并把跨包公共契约前置到 `@issuepilot/shared-contracts`。验证：`pnpm -w turbo run build test typecheck lint` 36/36 全绿、`pnpm test:smoke` 11/11 全绿、`pnpm --filter @issuepilot/shared-contracts test` 20/20 全绿。包含 4 个 Task：
  - **Task 1.1（commit 1228596）** `chore: bootstrap pnpm workspace with turborepo` — 根 `package.json` 锁定 `pnpm@10.33.2` + Node 22；新增 `pnpm-workspace.yaml`、`turbo.json`、`tsconfig.base.json`（strict + NodeNext + ES2023 + composite）、`.npmrc`（engine-strict）、`.gitignore`、`tests/integration/scaffold.smoke.test.ts`。
  - **Task 1.2（commit e403384）** `chore: scaffold workspace packages and apps` — 为 7 个 library package（`@issuepilot/core`、`workflow`、`tracker-gitlab`、`workspace`、`runner-codex-app-server`、`observability`、`shared-contracts`）和 2 个 app（`@issuepilot/orchestrator` 占位 + `@issuepilot/dashboard` Next.js 14 + React 18 最小可 build 应用）创建 stub。每个 workspace 都接入 turbo `build/test/typecheck/lint` 调度。
  - **Task 1.3（commit 6548e94）** `chore: configure eslint, prettier, tsconfig project references` — 接入 ESLint v9 flat config（`typescript-eslint` recommended + `eslint-plugin-import`，测试与 dashboard 上下文有针对性 override）、Prettier（80 列、双引号、`trailingComma: all`）、`.editorconfig`，根 `tsconfig.json` 聚合 8 个 emitting workspace 的 `references`；每个包 `lint` script 由占位 echo 改为 `eslint --max-warnings 0`。新增 `tests/integration/lint.smoke.test.ts` 把契约纳入 CI。
  - **Task 1.4（commit 26cdd3b）** `feat(shared-contracts): define run/event/state interfaces` — 在 `@issuepilot/shared-contracts` 落地 5 个子模块：`issue.ts`（`IssueRef`）、`run.ts`（`RUN_STATUS_VALUES` + `RunStatus` + `isRunStatus` + `RunRecord`）、`events.ts`（覆盖 spec §10 全部 33 个 event type 的 `EVENT_TYPE_VALUES` + `EventType` + `isEventType` + `IssuePilotEvent`）、`state.ts`（`SERVICE_STATUS_VALUES` + `OrchestratorStateSnapshot`）、`api.ts`（`ListRunsQuery` / `RunsListResponse` / `RunDetailResponse` / `EventsQuery` / `EventsListResponse`）。每个值 + 类型对都用 `expectTypeOf` 配套测试防止漂移。
- 2026-05-11 — 新增 IssuePilot P0 实现计划：`docs/superpowers/plans/2026-05-11-issuepilot-implementation-plan.md`。计划基于 `docs/superpowers/specs/2026-05-11-issuepilot-design.md`，按 spec §19 的里程碑拆分为 8 个 Phase（M1 skeleton → M8 E2E + smoke），细化到 ≈ 40 个 Task，每个 Task 给出 Files / TDD 5 步 / 验收。包含跨包接口契约（`@issuepilot/shared-contracts`、`@issuepilot/workflow`、`@issuepilot/tracker-gitlab`、`@issuepilot/workspace`、`@issuepilot/runner-codex-app-server`、`@issuepilot/observability`）、文件结构总图、风险与回退、以及与 spec §21 MVP DoD 14 条逐项对齐的验证矩阵。
