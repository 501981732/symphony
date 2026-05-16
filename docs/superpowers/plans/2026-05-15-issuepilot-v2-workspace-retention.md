# IssuePilot V2 Workspace Retention 实施计划

Phase：V2 Phase 5
状态：待实施
对应 spec：`docs/superpowers/specs/2026-05-16-issuepilot-v2-phase5-workspace-retention-design.md`
上级 spec：`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`
上一步：V2 Phase 4 Review Feedback Sweep

> **给执行 agent：** 执行本计划时必须使用子技能 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。步骤使用 checkbox（`- [ ]`）追踪。

**目标：** 给 `~/.issuepilot` 下的 workspace 增加基于 retention policy 的自动清理：成功 7 天、失败 30 天、active run 永不清理；总容量超过上限时只清理已过期的 terminal run；失败现场默认保留，且清理可被 dry-run 预览。

**架构：** 新增 `packages/workspace/src/retention.ts` 作为纯函数 planner（输入 workspace 列表 + retention config + 当前时间 → 输出 `CleanupPlan`），新增 `apps/orchestrator/src/maintenance/workspace-cleanup.ts` 作为 executor，由 main loop 按 `cleanup_interval_ms` 定时调用。新增 `workspace_cleanup_planned` / `workspace_cleanup_completed` / `workspace_cleanup_failed` 事件。`issuepilot doctor --workspace` CLI 命令打印 plan dry-run。

**前置：** Phase 1 已合入。可独立于 Phase 2/3/4 实施。

**技术栈：** TypeScript、Node.js 22、Vitest、`@issuepilot/workspace`、`@issuepilot/observability`。

---

## 范围检查

V2 设计 §11 把 workspace retention 限定为：成功 7 天、失败 30 天、active 永不清理、超出总容量时只清掉已过期的 terminal run、失败现场默认保留、可被审计。本计划覆盖：

- retention config 节进入 team config + workflow（workflow 节是 V1 单项目 fallback）。
- planner：根据 run state + workspace mtime + 容量预算输出 `CleanupPlan`。
- executor：执行 plan，写事件，遇错单条 fail-soft。
- `issuepilot doctor --workspace` dry-run 命令。
- dashboard 在 service header 区显示 `workspace usage GB` 与下一次 cleanup window。

本计划明确不做：

- 远端 git branch 清理（GitLab 上的 ai/* 分支）：V2 §11 显式划到后续。
- workspace export / archive 到 S3 类外部存储。
- 多 host 共享 workspace 的清理协议（V3 多 worker 范围）。

## 文件结构

- 修改：`apps/orchestrator/src/team/config.ts` + 测试：`retention.successful_run_days` / `failed_run_days` / `max_workspace_gb` / `cleanup_interval_ms`，并解析进 `TeamConfig.retention`（Phase 1 已有，但未消费）。
- 修改：`packages/workflow/src/types.ts` + parse + 测试：单项目 workflow 也支持 `retention` 节（fallback for `--workflow` 入口）。
- 修改：`packages/shared-contracts/src/events.ts` + 测试：追加 `workspace_cleanup_planned`、`workspace_cleanup_completed`、`workspace_cleanup_failed`。
- 修改：`packages/shared-contracts/src/state.ts` + 测试：`OrchestratorStateSnapshot.service` 增加可选 `workspaceUsageGb`、`nextCleanupAt`。
- 新建：`packages/workspace/src/retention.ts`：导出 `planWorkspaceCleanup`、`enumerateWorkspaceEntries` 等纯函数。
- 新建：`packages/workspace/src/__tests__/retention.test.ts`：覆盖 6 种边界（active run、未到期、已到期、容量超限、失败保留期、读取失败）。
- 新建：`apps/orchestrator/src/maintenance/workspace-cleanup.ts`：导出 `runWorkspaceCleanupOnce`。
- 新建：`apps/orchestrator/src/maintenance/__tests__/workspace-cleanup.test.ts`：覆盖 plan → execute 全流程 + 单条删除失败不阻塞。
- 修改：`apps/orchestrator/src/orchestrator/loop.ts` + 测试：按 `cleanup_interval_ms`（默认 1 小时）调用 cleanup once。
- 修改：`apps/orchestrator/src/cli.ts` + 测试：新增 `doctor --workspace` 模式，调 planner 输出 dry-run 表格。
- 修改：`apps/dashboard/components/overview/service-header.tsx` + 测试：渲染 workspaceUsageGb 与 nextCleanupAt。
- 新建：`docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md`：操作员 runbook + rollback 步骤。
- 修改：spec / README / CHANGELOG。

## 任务 1：扩展配置 schema

**文件：**
- 修改：`apps/orchestrator/src/team/config.ts` + 测试
- 修改：`packages/workflow/src/types.ts` + parse + 测试

- [ ] **步骤 1：写失败测试**

team config 测试：

- 未配置 `retention` → 默认 `{ successfulRunDays: 7, failedRunDays: 30, maxWorkspaceGb: 50, cleanupIntervalMs: 3_600_000 }`（Phase 1 已经定义部分，本任务把 `maxWorkspaceGb` 调到 50，并新增 `cleanupIntervalMs`，向后兼容旧字段名）。
- 自定义值覆盖。

workflow parser 测试：单项目 workflow 增加同样 retention schema。

- [ ] **步骤 2 → 5：标准 TDD + commit**

调整默认值与字段命名，确保 Phase 1 的字段语义未漂移；如 `failedRunDays` 默认从 14 调到 30，注意更新 Phase 1 plan 留下的 default（在 CHANGELOG 中注明，避免破坏现有 user 的隐式期望）。

```bash
git add apps/orchestrator/src/team/config.ts apps/orchestrator/src/team/__tests__/config.test.ts packages/workflow
git commit -m "feat(config): wire retention policy schema"
```

## 任务 2：扩展共享 events 与 state snapshot

**文件：**
- 修改：`packages/shared-contracts/src/events.ts` + 测试
- 修改：`packages/shared-contracts/src/state.ts` + 测试

- [ ] **步骤 1-5：TDD 闭环**

events 追加三个 `workspace_cleanup_*`；`OrchestratorStateSnapshot.service`：

```ts
  /** Approximate disk usage under workspace root, computed at planner time. */
  workspaceUsageGb?: number;
  /** ISO-8601 ETA of the next cleanup window. */
  nextCleanupAt?: string;
```

```bash
pnpm --filter @issuepilot/shared-contracts test
pnpm --filter @issuepilot/shared-contracts build
git add packages/shared-contracts
git commit -m "feat(contracts): add workspace cleanup events and usage fields"
```

## 任务 3：实现 retention planner

**文件：**
- 新建：`packages/workspace/src/retention.ts`
- 新建：`packages/workspace/src/__tests__/retention.test.ts`

- [ ] **步骤 1：写失败测试**

覆盖：

- active run 的 workspace 永不出现在 plan.delete 列表。
- 成功 run、mtime 在 6 天 → 不删除；在 8 天 → 删除。
- 失败 run、mtime 在 25 天 → 不删除；在 32 天 → 删除。
- 总容量超过 `maxWorkspaceGb`，且 plan.delete 中有 5 个 candidate → 按 mtime 最旧优先删除直到容量 < 阈值；任何未过期 candidate 不被强删（spec §11）。
- 失败现场（含 `.issuepilot/failed-at-*` 标记）即使到期也保留（如果用户在 retention 中 `keepFailureMarkers: true`，本计划默认 true）。
- `du` / readdir 失败时返回 plan with `errors[]`，不抛。

- [ ] **步骤 2 → 5：标准 TDD + commit**

```ts
export interface WorkspaceEntry {
  workspacePath: string;
  runId: string;
  projectId: string;
  status: "active" | "successful" | "failed" | "blocked" | "completed" | "unknown";
  endedAt?: string;
  bytes: number;
}

export interface CleanupPlan {
  retainBytes: number;
  totalBytes: number;
  delete: Array<{ workspacePath: string; reason: "successful-expired" | "failed-expired" | "over-capacity" }>;
  keepFailureMarkers: string[];
  errors: Array<{ workspacePath: string; reason: string }>;
}

export interface PlanWorkspaceCleanupInput {
  entries: WorkspaceEntry[];
  retention: RetentionConfig;
  now: Date;
}

export function planWorkspaceCleanup(
  input: PlanWorkspaceCleanupInput,
): CleanupPlan;
```

`enumerateWorkspaceEntries(workspaceRoot, runs)` 在 executor 任务中实现并接 planner。

```bash
git add packages/workspace/src/retention.ts packages/workspace/src/__tests__/retention.test.ts
git commit -m "feat(workspace): add retention planner"
```

## 任务 4：实现 cleanup executor

**文件：**
- 新建：`apps/orchestrator/src/maintenance/workspace-cleanup.ts`
- 新建：`apps/orchestrator/src/maintenance/__tests__/workspace-cleanup.test.ts`

- [ ] **步骤 1-5：标准 TDD 闭环**

```ts
export interface RunWorkspaceCleanupInput {
  workspaceRoot: string;
  state: RuntimeState;
  retention: RetentionConfig;
  eventBus: EventBus<IssuePilotEvent>;
  now?: () => Date;
  fs?: Pick<typeof fsPromises, "rm" | "stat" | "readdir">;
}

export async function runWorkspaceCleanupOnce(
  input: RunWorkspaceCleanupInput,
): Promise<CleanupPlan>;
```

实现要求：

- 调 `enumerateWorkspaceEntries` 收集所有 workspace；按 `state.allRuns()` 标记 active。
- emit `workspace_cleanup_planned` with plan summary（数量 + 容量）。
- 对每个 `plan.delete` 项调 `fs.rm(workspacePath, { recursive: true, force: true })`；成功 emit `workspace_cleanup_completed` with `workspacePath` + `reason`；失败 emit `workspace_cleanup_failed` + 保留目录。
- 不删除 `.issuepilot/` 标记下的 marker 备份（保留失败现场最近一份元数据）。

```bash
git add apps/orchestrator/src/maintenance
git commit -m "feat(orchestrator): run workspace cleanup periodically"
```

## 任务 5：main loop 接入 + CLI dry-run + dashboard 显示

**文件：**
- 修改：`apps/orchestrator/src/orchestrator/loop.ts` + 测试
- 修改：`apps/orchestrator/src/cli.ts` + 测试
- 修改：`apps/dashboard/components/overview/service-header.tsx` + 测试

- [ ] **步骤 1：写失败测试**

loop 测试：cleanup interval 到了才调用 `runWorkspaceCleanupOnce`；未到 interval 时不调。

CLI 测试：`issuepilot doctor --workspace --workflow ./WORKFLOW.md` 调 planner，打印一段「N entries / X GB / will delete M / will keep failure markers K」摘要后退出 0。

service-header 测试：`snapshot.service.workspaceUsageGb` 存在时显示 `Workspace: 12.4 GB`；`nextCleanupAt` 存在时显示 relative time。

- [ ] **步骤 2 → 5：TDD 闭环 + commit**

loop 持有 `lastCleanupAt` 计时器；超过 interval 时调一次后更新 `state.setNextCleanupAt`。

```bash
git add apps/orchestrator apps/dashboard/components/overview/service-header.tsx apps/dashboard/components/overview/service-header.test.tsx
git commit -m "feat(orchestrator): integrate cleanup into loop + cli + dashboard"
```

## 任务 6：focused e2e + runbook

**文件：**
- 新建：`tests/e2e/workspace-cleanup.test.ts`
- 新建：`docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md`

- [ ] **步骤 1：实现 e2e**

- A：seed 一个 successful run，workspace mtime 推到 8 天前 → cleanup 后目录消失，event log 有 `workspace_cleanup_completed`。
- B：seed 一个 active run，mtime 推到 60 天前 → cleanup 不删除该目录。
- C：seed 5 个失败 run，让总容量超过 maxWorkspaceGb，但都在保留期内 → cleanup 不删除任何目录，event log 有 `workspace_cleanup_planned` 标记 `over-capacity` 但 plan.delete 为空。

- [ ] **步骤 2：runbook 写操作员 SOP**

包含：

- 「准备清理 vs 强制清理」决策树。
- `issuepilot doctor --workspace` dry-run 用法。
- 出现 `workspace_cleanup_failed` 时的诊断步骤（权限、忙占用、子目录残留）。
- rollback：如果用户误删，从备份 mirror 重建 workspace 的步骤。

- [ ] **步骤 3：跑 e2e + commit**

```bash
pnpm --filter @issuepilot/tests-e2e test -- workspace-cleanup
git add tests/e2e/workspace-cleanup.test.ts docs/superpowers/runbooks
git commit -m "test(e2e): cover workspace retention boundaries"
```

## 任务 7：文档、CHANGELOG 与 release safety

- [ ] **步骤 1-5：spec 链接 + README ✅ + CHANGELOG + release safety + commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && git diff --check
git add docs README.md README.zh-CN.md CHANGELOG.md
git commit -m "docs(v2): document workspace retention phase"
```

## 自审

Spec 覆盖：

- V2 §11 retention 默认策略：Task 1 + Task 3 覆盖。
- V2 §11 失败现场默认保留：Task 3 / Task 4 通过 `keepFailureMarkers` 实现。
- V2 §12 WorkspaceCleanupEvent：Task 2 覆盖。
- V2 §13 cleanup_failed 分类：Task 4 覆盖。
- V2 §14 retention 测试：Task 3、4、6 覆盖。

刻意延后：

- 远端 git branch 清理：spec §11 明确划到后续 release 管理任务。
- workspace export / archive：本计划不引入。
- 多 host 共享 workspace 协议：V3 多 worker 范围。

类型一致性：

- `RetentionConfig`、`CleanupPlan`、新事件类型在 contracts / workspace 任务中先于 executor / dashboard 使用前定义。

占位扫描：无 `TBD` / `TODO`。
