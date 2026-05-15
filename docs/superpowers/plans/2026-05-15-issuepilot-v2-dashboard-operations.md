# IssuePilot V2 Dashboard Operations 实施计划

> **给执行 agent：** 执行本计划时必须使用子技能 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。步骤使用 checkbox（`- [ ]`）追踪。

**目标：** 给 dashboard 提供受 orchestrator 管控的 `retry` / `stop` / `archive run` 三个操作，每个操作都产生 `operator_action` 审计事件，并在 UI 里按 run 状态展示可用按钮。

**架构：** 在 orchestrator 中新增 operator action 路由（Fastify POST endpoints），调用现有 lease store / runtime state / GitLab adapter 完成状态机迁移。新增 `RunRecord.archivedAt` 字段、新增 `operator_action_*` 事件类型，dashboard runs-table 和 detail page 增加 `Actions` 列。

**前置：** Phase 1 已合入（lease store / team daemon / project-aware state 可用）。

**技术栈：** TypeScript、Node.js 22、Fastify、Vitest、Next.js App Router、Tailwind、`@issuepilot/shared-contracts`。

---

## 范围检查

V2 设计 §8 把 dashboard operations 定义为「retry / stop / archive run」三件套。本计划覆盖以下能力：

- 三个 POST 操作 API。
- `operator_action_requested` / `operator_action_succeeded` / `operator_action_failed` 事件。
- archived run 在 `/api/runs` 默认列表中隐藏。
- dashboard runs-table 和 run-detail 页面渲染对应按钮。

本计划明确不做：

- CI 状态读取（Phase 3）。
- review feedback sweep（Phase 4）。
- workspace cleanup（Phase 5）。
- RBAC / 多用户身份（V3 范围）。
- 操作审批二次确认弹窗以外的访问控制（V2 仍使用本机用户名）。

## 文件结构

- 修改：`packages/shared-contracts/src/events.ts`：在 `EVENT_TYPE_VALUES` 追加 `operator_action_requested`、`operator_action_succeeded`、`operator_action_failed`。
- 修改：`packages/shared-contracts/src/__tests__/events.test.ts`：覆盖三个新事件类型。
- 修改：`packages/shared-contracts/src/run.ts`：给 `RunRecord` 增加可选 `archivedAt: string`。
- 修改：`packages/shared-contracts/src/__tests__/run.test.ts`：补 `archivedAt` 字段断言。
- 新建：`apps/orchestrator/src/operations/actions.ts`：实现 `retryRun` / `stopRun` / `archiveRun` 三个 pure-ish service 函数，输入 `{ runId, operator, deps }`。
- 新建：`apps/orchestrator/src/operations/__tests__/actions.test.ts`：每个动作至少覆盖成功 / 状态非法 / 失败回滚三种路径。
- 修改：`apps/orchestrator/src/server/index.ts`：增加 POST `/api/runs/:runId/retry|stop|archive`，注入 `deps.operatorActions`。
- 修改：`apps/orchestrator/src/server/__tests__/server.test.ts`：覆盖三个新路由的 200 / 409 / 404 行为，并断言 redact / event 写入。
- 修改：`apps/orchestrator/src/daemon.ts` 和 `apps/orchestrator/src/team/daemon.ts`：把 `operatorActions` 装配后传给 `createServer`。
- 修改：`apps/dashboard/lib/api.ts`：新增 `retryRun`、`stopRun`、`archiveRun` client 函数（POST + 错误处理 + 携带 `X-IssuePilot-Operator`）。
- 修改：`apps/dashboard/lib/api.test.ts`：覆盖三个 client 函数。
- 新建：`apps/dashboard/components/overview/run-actions.tsx`：根据 run 状态渲染可用按钮，点击调用 client 函数，乐观刷新。
- 新建：`apps/dashboard/components/overview/run-actions.test.tsx`：断言按钮显隐与点击调用。
- 修改：`apps/dashboard/components/overview/runs-table.tsx`：表格新增 `Actions` 列。
- 修改：`apps/dashboard/components/overview/runs-table.test.tsx`：覆盖 actions 列的渲染。
- 修改：`apps/dashboard/components/detail/run-detail-page.tsx`：在头部按钮区放置 `RunActions`。
- 修改：`apps/dashboard/components/detail/run-detail-page.test.tsx`：覆盖 detail page 中的操作按钮。
- 修改：`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`：在 Phase 2 节尾追加本计划链接。
- 修改：`README.md` 和 `README.zh-CN.md`：把 V2 列表中的 `retry/stop/archive` 改成「✅ shipped (experimental)」。

## 任务 1：扩展 shared contracts

**文件：**
- 修改：`packages/shared-contracts/src/events.ts`
- 修改：`packages/shared-contracts/src/__tests__/events.test.ts`
- 修改：`packages/shared-contracts/src/run.ts`
- 修改：`packages/shared-contracts/src/__tests__/run.test.ts`

- [ ] **步骤 1：写失败测试**

在 events 测试里断言三个新值都出现在 `EVENT_TYPE_VALUES` 中且 `isEventType` narrowing 通过。在 run 测试里断言 `RunRecord.archivedAt` 可选 string。

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @issuepilot/shared-contracts test -- src/__tests__/events.test.ts src/__tests__/run.test.ts
```

期望：失败，错误指向 `operator_action_requested` 缺失或 `archivedAt` 字段未定义。

- [ ] **步骤 3：实现**

在 `EVENT_TYPE_VALUES` 末尾追加：

```ts
  // Dashboard operator actions
  "operator_action_requested",
  "operator_action_succeeded",
  "operator_action_failed",
```

给 `RunRecord` 加：

```ts
  /** ISO-8601 timestamp set when an operator archives this run. */
  archivedAt?: string;
```

- [ ] **步骤 4：运行 focused 测试**

```bash
pnpm --filter @issuepilot/shared-contracts test
pnpm --filter @issuepilot/shared-contracts typecheck
pnpm --filter @issuepilot/shared-contracts build
```

期望：全部 PASS。`build` 是为了让下游的 declaration 立即可见。

- [ ] **步骤 5：提交**

```bash
git add packages/shared-contracts
git commit -m "feat(contracts): add operator action events and archive flag"
```

## 任务 2：实现 operator action services

**文件：**
- 新建：`apps/orchestrator/src/operations/actions.ts`
- 新建：`apps/orchestrator/src/operations/__tests__/actions.test.ts`

- [ ] **步骤 1：写失败测试**

在 actions 测试里覆盖：

- `retryRun`：run 处于 `failed` 时成功，重新写 attempt+1 的 `claimed` run、发出 `retry_scheduled` 和 `operator_action_succeeded`。
- `retryRun`：run 处于 `running` 时返回 `{ ok: false, code: "invalid_status" }`，不动 GitLab。
- `stopRun`：run 处于 `running` 时调用 runner 的 `cancel`，转入 `stopping`，最终标 `failed`，写 stop note；如果 cancel 抛错，标记 stopping 并写 `operator_action_failed`。
- `archiveRun`：terminal run 设置 `archivedAt`，写 `operator_action_succeeded`；非 terminal run 返回 `invalid_status`。

测试通过 fake `runtimeState` / `eventBus` / `gitlab` / `runnerCancel` / `leaseStore` 注入。

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/operations/__tests__/actions.test.ts
```

期望：失败，`apps/orchestrator/src/operations/actions.ts` 不存在。

- [ ] **步骤 3：实现**

`actions.ts` 导出：

```ts
export interface OperatorActionDeps {
  state: RuntimeState;
  eventBus: EventBus<IssuePilotEvent>;
  gitlab: Pick<GitLabAdapter, "transitionLabels" | "createIssueNote">;
  leaseStore?: LeaseStore;
  runnerCancel?: (runId: string) => Promise<void>;
  now?: () => Date;
  workflow: Pick<WorkflowConfig, "tracker">;
}

export interface OperatorActionResult {
  ok: boolean;
  code?: "invalid_status" | "not_found" | "cancel_failed";
  message?: string;
}

export async function retryRun(
  input: { runId: string; operator: string },
  deps: OperatorActionDeps,
): Promise<OperatorActionResult>;
export async function stopRun(
  input: { runId: string; operator: string },
  deps: OperatorActionDeps,
): Promise<OperatorActionResult>;
export async function archiveRun(
  input: { runId: string; operator: string },
  deps: OperatorActionDeps,
): Promise<OperatorActionResult>;
```

实现要求：

- 每次进入函数先 emit `operator_action_requested`，包含 `action`、`runId`、`operator`、`createdAt`。
- 成功路径 emit `operator_action_succeeded`，包含 `transitions`；失败路径 emit `operator_action_failed`，包含 `code`、`message`。
- `retryRun`：把目标 run 复位为 `claimed`，attempt+1；如果 issue 有 active lease 先 release；GitLab labels 切到 `reworkLabel`（来自 workflow）。
- `stopRun`：仅当 status === `running`；调 `runnerCancel(runId)`（如有），异常进 `cancel_failed`；成功后写 GitLab note 标注操作者，labels 切到 `failedLabel`，state 转 `failed`，lease release。
- `archiveRun`：仅当 status ∈ `{failed, blocked, completed}`；设置 `archivedAt = now()`，不动 GitLab。
- 所有 GitLab 调用失败时回滚 state 改动，并 emit `operator_action_failed`。

- [ ] **步骤 4：运行测试**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/operations/__tests__/actions.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

期望：PASS。

- [ ] **步骤 5：提交**

```bash
git add apps/orchestrator/src/operations
git commit -m "feat(orchestrator): add operator action services"
```

## 任务 3：暴露 HTTP 路由

**文件：**
- 修改：`apps/orchestrator/src/server/index.ts`
- 修改：`apps/orchestrator/src/server/__tests__/server.test.ts`

- [ ] **步骤 1：写失败测试**

补三个测试：

- POST `/api/runs/:runId/retry` 返回 200，并触发 `deps.operatorActions.retry`，event log 中出现 `operator_action_succeeded`。
- POST `/api/runs/:runId/stop` 当 run 不在 `running` 时返回 409 `{ error: "invalid_status" }`。
- POST `/api/runs/:runId/archive` 404 for unknown run。
- 三个请求都需要解析 `x-issuepilot-operator` header，缺失时使用 `system`。

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/server/__tests__/server.test.ts
```

- [ ] **步骤 3：实现**

在 `ServerDeps` 加：

```ts
  operatorActions?: {
    retry(input: { runId: string; operator: string }): Promise<OperatorActionResult>;
    stop(input: { runId: string; operator: string }): Promise<OperatorActionResult>;
    archive(input: { runId: string; operator: string }): Promise<OperatorActionResult>;
  };
```

注册三个路由，路由内：

1. 校验 run 存在（404 否则）。
2. `operator = request.headers["x-issuepilot-operator"]?.toString() ?? "system"`。
3. 调对应 action，映射 result：`ok=true` → 200 `{ ok: true }`；`code=invalid_status` → 409；其他 → 500。
4. body 走默认 redact hook。

`/api/runs` 默认过滤 `archivedAt == null`；query `?includeArchived=true` 时返回全量。

- [ ] **步骤 4：运行测试**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/server/__tests__/server.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

- [ ] **步骤 5：提交**

```bash
git add apps/orchestrator/src/server
git commit -m "feat(server): expose operator action routes"
```

## 任务 4：把 actions 装配进 daemon

**文件：**
- 修改：`apps/orchestrator/src/daemon.ts`
- 修改：`apps/orchestrator/src/team/daemon.ts`
- 修改：`apps/orchestrator/src/__tests__/daemon.test.ts`
- 修改：`apps/orchestrator/src/team/__tests__/daemon.test.ts`

- [ ] **步骤 1：写失败测试**

断言 daemon 启动后 `createServer` 收到的 `operatorActions` 不为 undefined，并且 `operatorActions.retry({ runId: "x", operator: "test" })` 调用会落到 `apps/orchestrator/src/operations/actions.ts` 的 `retryRun`（用 spy 验证）。

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/__tests__/daemon.test.ts src/team/__tests__/daemon.test.ts
```

- [ ] **步骤 3：实现**

在两个 daemon 启动函数里构建 `operatorActions`，把 lease store、runtime state、event bus、GitLab adapter（team mode 单项目 → 单 adapter；V1 mode 直接传 V1 adapter）、workflow 引用注入。`runnerCancel` 暂用 `() => Promise.reject(new Error("not_implemented"))`，后续 Phase 接 runner cancel API。

- [ ] **步骤 4：运行测试**

```bash
pnpm --filter @issuepilot/orchestrator test
pnpm --filter @issuepilot/orchestrator typecheck
```

- [ ] **步骤 5：提交**

```bash
git add apps/orchestrator/src/daemon.ts apps/orchestrator/src/team/daemon.ts apps/orchestrator/src/__tests__/daemon.test.ts apps/orchestrator/src/team/__tests__/daemon.test.ts
git commit -m "feat(orchestrator): wire operator actions into daemons"
```

## 任务 5：dashboard API client + 按钮组件

**文件：**
- 修改：`apps/dashboard/lib/api.ts`
- 修改：`apps/dashboard/lib/api.test.ts`
- 新建：`apps/dashboard/components/overview/run-actions.tsx`
- 新建：`apps/dashboard/components/overview/run-actions.test.tsx`

- [ ] **步骤 1：写失败测试**

API client：

- `retryRun("r1", { operator: "alice" })` 发 `POST /api/runs/r1/retry`，请求头 `X-IssuePilot-Operator: alice`；返回 `{ ok: true }`。
- 409 时抛 `ApiError` with `status: 409`。

`RunActions` 组件：

- run.status === `failed` → 显示 `Retry` 和 `Archive`。
- run.status === `running` → 显示 `Stop`。
- run.status === `completed` 且未 archived → 显示 `Archive`。
- run.archivedAt 已设置 → 不显示任何按钮。
- 点击 Retry → 调用 mock `onRetry`。

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @issuepilot/dashboard test -- lib/api.test.ts components/overview/run-actions.test.tsx
```

- [ ] **步骤 3：实现**

`apps/dashboard/lib/api.ts` 增加三个 `apiPost` helper 实现，操作者从 `process.env.NEXT_PUBLIC_OPERATOR_DISPLAY_NAME ?? "operator"` 读取（V2 简化，下一阶段接登录态）。

`run-actions.tsx` 是 client component，使用 shadcn `Button`。`pending` 状态用 useTransition 阻塞二次点击。

- [ ] **步骤 4：运行测试**

```bash
pnpm --filter @issuepilot/dashboard test -- lib/api.test.ts components/overview/run-actions.test.tsx
pnpm --filter @issuepilot/dashboard typecheck
```

- [ ] **步骤 5：提交**

```bash
git add apps/dashboard/lib/api.ts apps/dashboard/lib/api.test.ts apps/dashboard/components/overview/run-actions.tsx apps/dashboard/components/overview/run-actions.test.tsx
git commit -m "feat(dashboard): add run action client + buttons"
```

## 任务 6：接入 runs-table 和 detail 页

**文件：**
- 修改：`apps/dashboard/components/overview/runs-table.tsx`
- 修改：`apps/dashboard/components/overview/runs-table.test.tsx`
- 修改：`apps/dashboard/components/detail/run-detail-page.tsx`
- 修改：`apps/dashboard/components/detail/run-detail-page.test.tsx`

- [ ] **步骤 1：补失败测试**

`runs-table.test.tsx` 断言 archived run 默认隐藏、`Show archived` toggle 后出现；每行 `Actions` 列含 `RunActions` 容器。

`run-detail-page.test.tsx` 断言 header 区域含 `Retry` 按钮（针对 failed run），点击触发 refetch（mock）。

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @issuepilot/dashboard test -- components/overview/runs-table.test.tsx components/detail/run-detail-page.test.tsx
```

- [ ] **步骤 3：实现**

在 runs-table 头部增加 `Show archived` 复选框（state 走 useState，未持久化），渲染时按 toggle 过滤。`Actions` 列宽 100px。

run-detail page 在 header 区域用 `RunActions` 渲染按钮，回调内调 `props.refetch`。

- [ ] **步骤 4：运行 dashboard 全量测试**

```bash
pnpm --filter @issuepilot/dashboard test
pnpm --filter @issuepilot/dashboard typecheck
```

- [ ] **步骤 5：提交**

```bash
git add apps/dashboard/components/overview/runs-table.tsx apps/dashboard/components/overview/runs-table.test.tsx apps/dashboard/components/detail/run-detail-page.tsx apps/dashboard/components/detail/run-detail-page.test.tsx
git commit -m "feat(dashboard): surface operator actions in tables"
```

## 任务 7：focused e2e

**文件：**
- 新建：`tests/e2e/operator-actions.test.ts`

- [ ] **步骤 1：写 e2e（依赖现有 fake GitLab + fake codex harness）**

覆盖两个场景：

- A：启动 daemon → seed 一个 failed run → POST `/retry` → fake GitLab 把 issue 切回 `ai-rework` → 下一次 poll 重新 claim 成功。
- B：seed 一个 running run → POST `/stop` → fake runner cancel 触发 turn_cancelled → run 进入 `failed` 且 lease 释放。

- [ ] **步骤 2：跑 e2e**

```bash
pnpm --filter @issuepilot/tests-e2e test -- operator-actions
```

期望：PASS。

- [ ] **步骤 3：提交**

```bash
git add tests/e2e/operator-actions.test.ts
git commit -m "test(e2e): cover operator retry and stop flows"
```

## 任务 8：文档、CHANGELOG 与 release safety

**文件：**
- 修改：`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`
- 修改：`README.md` / `README.zh-CN.md`
- 修改：`CHANGELOG.md`

- [ ] **步骤 1：补文档**

spec Phase 2 节末追加：

```md
实施计划：

- `docs/superpowers/plans/2026-05-15-issuepilot-v2-dashboard-operations.md`
```

README 把 V2 列表里 `retry/stop/archive run` 项前置 ✅，去掉 V1 fallback 文案中已经过期的说明。

- [ ] **步骤 2：CHANGELOG**

新增 `Unreleased` Added 一条，列出：新事件类型、新 API、新 dashboard 组件、新 e2e。

- [ ] **步骤 3：运行 release safety**

```bash
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

期望：全部 PASS。

- [ ] **步骤 4：提交**

```bash
git add docs/superpowers/specs README.md README.zh-CN.md CHANGELOG.md
git commit -m "docs(v2): document dashboard operations phase"
```

## 自审

Spec 覆盖：

- V2 §8 retry/stop/archive：Task 2、3、5、6 覆盖。
- V2 §12 OperatorActionEvent：Task 1 覆盖。
- V2 §13 operator_action_failed 分类：Task 2 覆盖。
- V2 §14 dashboard actions 测试：Task 3、6 覆盖。

刻意延后：

- 真正的 runner cancel API（runner 包暂未提供 cancel 命令）：本计划使用 `runnerCancel` 占位，stopRun 在 cancel 失败时仍能把 run 标 `stopping`/`failed`。runner 侧的 cancel command 等 Phase 3 或独立 spec。
- RBAC、操作者审计登录态：V3 范围。
- 批量 retry / 批量 archive：本计划不引入。

类型一致性：

- `RunRecord.archivedAt` / 新 event types 在 contracts 任务中先于 server / dashboard 使用前定义。
- `operatorActions` deps 注入路径在 server task 之前由 daemon 装配。

占位扫描：本计划不含 `TBD` / `TODO`。每个代码改动步骤都给出具体文件、命令和可验证预期。
