# IssuePilot V2 CI 回流实施计划

Phase：V2 Phase 3
状态：已完成，已合入 `main`
对应 spec：`docs/superpowers/specs/2026-05-16-issuepilot-v2-phase3-ci-feedback-design.md`
上级 spec：`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`
上一步：V2 Phase 2 Dashboard Operations
下一步：V2 Phase 4 Review Feedback Sweep

> **给执行 agent：** 执行本计划时必须使用子技能 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。步骤使用 checkbox（`- [ ]`）追踪。

**目标：** 在 `human-review` 状态下读取该 issue 关联 MR 的 pipeline 状态：success 保持 review，failed 默认回流到 `ai-rework` 并写 structured note，其他状态保持 review 并提示人工。

**架构：** 复用 `@issuepilot/tracker-gitlab` 现有 `getPipelineStatus` 和 `listMergeRequestNotes`。新增 `apps/orchestrator/src/orchestrator/ci-feedback.ts` 作为 review 阶段的扫描器，由 main loop 定时调用；新增 `ci_status_observed`、`ci_status_rework_triggered` 事件；workflow / team config 增加 `ci.enabled` / `ci.on_failure` / `ci.wait_for_pipeline` 字段。

**前置：** Phase 1 已合入（lease 和 team daemon 可用）。可独立于 Phase 2 实施。

**技术栈：** TypeScript、Node.js 22、Vitest、`@issuepilot/tracker-gitlab`、`@issuepilot/workflow`、`@issuepilot/observability`。

---

## 范围检查

V2 设计 §9 把 CI 回流定义为：基于 MR pipeline 状态，决定是否把 issue 自动打回 `ai-rework`。本计划覆盖：

- workflow schema 新增 `ci` 节，含默认值。
- ci-feedback 扫描器：识别 human-review 下的 issue → 找到对应 MR → 查 pipeline 状态 → 按策略 transition labels + 写 note。
- 事件：`ci_status_observed`、`ci_status_rework_triggered`、`ci_status_lookup_failed`。
- dashboard 在 run row 附带 latest CI status badge。
- team config 新增可选 `ci` 节，覆盖 workflow 设置。

本计划明确不做：

- 自动 merge（V2 §3 非目标）。
- pipeline log 抓取或失败摘要生成。
- review feedback sweep（Phase 4）。
- pipeline webhook 实时回流；V2 只用 poll。

## 文件结构

- 修改：`packages/workflow/src/types.ts`、`packages/workflow/src/parse.ts`、`packages/workflow/src/resolve.ts`：新增 `CiConfig`，并在 `WorkflowConfig` 中加 `ci: CiConfig`。
- 修改：`packages/workflow/src/__tests__/parse.test.ts`、`resolve.test.ts`：覆盖默认值和自定义值。
- 修改：`apps/orchestrator/src/team/config.ts`：增加可选 `ci` 节，覆盖 workflow 默认。
- 修改：`apps/orchestrator/src/team/__tests__/config.test.ts`：覆盖 ci 覆盖逻辑。
- 修改：`packages/shared-contracts/src/events.ts`：追加 `ci_status_observed`、`ci_status_rework_triggered`、`ci_status_lookup_failed`。
- 修改：`packages/shared-contracts/src/events.test.ts`：覆盖新事件。
- 修改：`packages/shared-contracts/src/run.ts`：`RunRecord` 增加可选 `latestCiStatus`、`latestCiCheckedAt`。
- 新建：`apps/orchestrator/src/orchestrator/ci-feedback.ts`：导出 `scanCiFeedbackOnce` 服务函数。
- 新建：`apps/orchestrator/src/orchestrator/__tests__/ci-feedback.test.ts`：覆盖 5 种 pipeline 状态分支 + 找不到 MR + lookup 失败。
- 修改：`apps/orchestrator/src/orchestrator/loop.ts`：在 reconciliation 阶段后调用 `scanCiFeedbackOnce`（如果 `ci.enabled`）。
- 修改：`apps/orchestrator/src/orchestrator/__tests__/loop.test.ts`：覆盖 enabled / disabled 路径。
- 修改：`apps/dashboard/components/overview/runs-table.tsx` 和 `runs-table.test.tsx`：在 status 列追加 CI badge。
- 修改：`apps/dashboard/components/detail/run-detail-page.tsx` + 对应测试：detail header 显示 CI status。
- 修改：`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`：在 Phase 3 节尾追加本计划链接。
- 修改：`README.md` / `README.zh-CN.md`：标注 ✅ CI 回流实验性可用。
- 修改：`CHANGELOG.md`。

## 任务 1：扩展 workflow / team config 的 ci 节

**文件：**
- 修改：`packages/workflow/src/types.ts`、`packages/workflow/src/parse.ts`
- 修改：`packages/workflow/src/__tests__/parse.test.ts`、`resolve.test.ts`
- 修改：`apps/orchestrator/src/team/config.ts`、对应测试

- [x] **步骤 1：写失败测试**

workflow parse 测试：未配置 ci 时返回默认 `{ enabled: false, onFailure: "ai-rework", waitForPipeline: true }`；配置自定义值时透传。

team config 测试：`scheduler.ci.enabled: true` 时 `config.ci.enabled === true`，并能被单 project 覆盖（如果实现允许）。

- [x] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @issuepilot/workflow test
pnpm --filter @issuepilot/orchestrator test -- src/team/__tests__/config.test.ts
```

- [x] **步骤 3：实现**

`CiConfig`：

```ts
export interface CiConfig {
  enabled: boolean;
  onFailure: "ai-rework" | "human-review";
  waitForPipeline: boolean;
}
```

`WorkflowConfig` 增加 `ci: CiConfig`，parser 给默认 `{ enabled: false, onFailure: "ai-rework", waitForPipeline: true }`。

team config schema 增加：

```yaml
ci:
  enabled: true
  on_failure: ai-rework
  wait_for_pipeline: true
```

team config 节为全局默认；project level 不复制 workflow 字段，但可在 `projects[].ci` 覆盖。

- [x] **步骤 4：运行测试 + typecheck + build**

```bash
pnpm --filter @issuepilot/workflow test
pnpm --filter @issuepilot/workflow typecheck
pnpm --filter @issuepilot/workflow build
pnpm --filter @issuepilot/orchestrator test -- src/team/__tests__/config.test.ts
```

- [x] **步骤 5：提交**

```bash
git add packages/workflow apps/orchestrator/src/team/config.ts apps/orchestrator/src/team/__tests__/config.test.ts
git commit -m "feat(config): add ci feedback settings"
```

## 任务 2：扩展共享 events 与 RunRecord

**文件：**
- 修改：`packages/shared-contracts/src/events.ts` + 测试
- 修改：`packages/shared-contracts/src/run.ts` + 测试

- [x] **步骤 1：写失败测试 → 步骤 2：跑测试确认失败 → 步骤 3：实现 → 步骤 4：跑 PASS → 步骤 5：提交**

在 `EVENT_TYPE_VALUES` 追加 `ci_status_observed`、`ci_status_rework_triggered`、`ci_status_lookup_failed`。`RunRecord` 增：

```ts
  /** Latest CI pipeline classification observed in the human-review loop. */
  latestCiStatus?: "running" | "success" | "failed" | "pending" | "canceled" | "unknown";
  /** ISO-8601 timestamp captured at the last CI poll for this run. */
  latestCiCheckedAt?: string;
```

```bash
pnpm --filter @issuepilot/shared-contracts test
pnpm --filter @issuepilot/shared-contracts build
git add packages/shared-contracts
git commit -m "feat(contracts): add ci feedback event types"
```

## 任务 3：实现 ci-feedback 扫描器

**文件：**
- 新建：`apps/orchestrator/src/orchestrator/ci-feedback.ts`
- 新建：`apps/orchestrator/src/orchestrator/__tests__/ci-feedback.test.ts`

- [x] **步骤 1：写失败测试**

覆盖：

- `success`：保持 `human-review`，写 `ci_status_observed`，不动 labels。
- `failed` + `onFailure: "ai-rework"`：transition labels → 增加 `reworkLabel`，移除 `handoffLabel`，写 `ci_status_rework_triggered` + GitLab note 含 pipeline URL。
- `failed` + `onFailure: "human-review"`：保持 labels，写 `ci_status_observed`（`detail.status = failed`），不发 rework event。
- `running` / `pending` / `unknown`：什么也不动，emit `ci_status_observed { action: wait }`。`unknown` 与 wait 同组，避免 race condition 时 marker note 被 unknown 占坐导致后续 failed 无法写 rework note。
- `canceled` / `skipped`：保持 labels，写 GitLab note 提示人工判断，emit `ci_status_observed`。
- `getPipelineStatus` 抛错：emit `ci_status_lookup_failed`，保持 labels。
- 找不到 MR：emit `ci_status_observed` with `detail.reason = "no_mr"`。

- [x] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/orchestrator/__tests__/ci-feedback.test.ts
```

- [x] **步骤 3：实现**

```ts
export interface ScanCiFeedbackInput {
  workflow: WorkflowConfig;
  ci: CiConfig;
  state: RuntimeState;
  gitlab: Pick<
    GitLabAdapter,
    | "findMergeRequestBySourceBranch"
    | "getPipelineStatus"
    | "transitionLabels"
    | "createIssueNote"
  >;
  eventBus: EventBus<IssuePilotEvent>;
  now?: () => Date;
}

export async function scanCiFeedbackOnce(
  input: ScanCiFeedbackInput,
): Promise<void>;
```

实现：

1. 取所有 status === `completed` 且 issue.labels 含 `handoffLabel` 的 run。
2. 对每个 run：用 `branch` 找 MR；找不到 → emit `ci_status_observed` with no_mr，continue。
3. `pipelineStatus = await gitlab.getPipelineStatus(branch)`；异常 → `ci_status_lookup_failed`，continue。
4. 更新 `state.setRun(runId, { ...run, latestCiStatus, latestCiCheckedAt: now })`。
5. 按状态分支处理 labels + notes + events。
6. note 必须使用稳定 marker `<!-- issuepilot:ci-feedback:<runId> -->`，避免重复。

- [x] **步骤 4：运行测试**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/orchestrator/__tests__/ci-feedback.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

- [x] **步骤 5：提交**

```bash
git add apps/orchestrator/src/orchestrator/ci-feedback.ts apps/orchestrator/src/orchestrator/__tests__/ci-feedback.test.ts
git commit -m "feat(orchestrator): scan ci status and recycle to ai-rework"
```

## 任务 4：在 main loop 中调用扫描器

**文件：**
- 修改：`apps/orchestrator/src/orchestrator/loop.ts`
- 修改：`apps/orchestrator/src/orchestrator/__tests__/loop.test.ts`

- [x] **步骤 1：写失败测试**

补两个 loop 测试：

- `ci.enabled: true` → 每轮 reconciliation 之后会调用 `scanCiFeedbackOnce`。
- `ci.enabled: false` → 不调用。

- [x] **步骤 2：跑确认失败 → 步骤 3：实现 → 步骤 4：跑 PASS → 步骤 5：提交**

在 loop 中注入 `scanCiFeedbackOnce`（可 mock）；ci.disabled 时跳过。

```bash
git add apps/orchestrator/src/orchestrator/loop.ts apps/orchestrator/src/orchestrator/__tests__/loop.test.ts
git commit -m "feat(orchestrator): integrate ci feedback into main loop"
```

## 任务 5：dashboard CI badge

**文件：**
- 修改：`apps/dashboard/components/overview/runs-table.tsx` + 测试
- 修改：`apps/dashboard/components/detail/run-detail-page.tsx` + 测试

- [x] **步骤 1：写失败测试**

runs-table 测试：run 含 `latestCiStatus: "failed"` → 表格出现 `CI failed` badge（rose tone）。`success` → emerald；`running`/`pending` → sky。

detail page 测试：header 区域显示 `Latest CI: <status>`（带时间戳）。

- [x] **步骤 2：跑确认失败 → 步骤 3：实现 → 步骤 4：跑 PASS → 步骤 5：提交**

复用现有 `Badge` 组件；`statusToTone(status)` 映射成 5 种 tone。

```bash
git add apps/dashboard/components/overview/runs-table.tsx apps/dashboard/components/overview/runs-table.test.tsx apps/dashboard/components/detail/run-detail-page.tsx apps/dashboard/components/detail/run-detail-page.test.tsx
git commit -m "feat(dashboard): show latest ci status"
```

## 任务 6：focused e2e

**文件：**
- 新建：`tests/e2e/ci-feedback.test.ts`

- [x] **步骤 1：实现 e2e**

复用 fake GitLab：

- A：seed handoff run → fake pipeline = success → 下一轮 poll 后 labels 保持 `human-review`，run.latestCiStatus = success。
- B：fake pipeline = failed → labels 切到 `ai-rework`，issue 多一个 ci-feedback note，event log 有 `ci_status_rework_triggered`。
- C：fake `getPipelineStatus` 抛 500 → emit `ci_status_lookup_failed`，labels 不变。
- D：fake pipeline = failed + `ci.on_failure: human-review` → labels 不变，无 marker note。
- E：fake pipeline = canceled，跨 6+ poll cycle → exactly one marker note（C1 dedup）。

- [x] **步骤 2：跑 e2e → 步骤 3：提交**

```bash
pnpm --filter @issuepilot/tests-e2e test -- ci-feedback
git add tests/e2e/ci-feedback.test.ts
git commit -m "test(e2e): cover ci feedback rework loop"
```

## 任务 7：文档、CHANGELOG 与 release safety

**文件：**
- 修改：spec / README / CHANGELOG。

- [x] **步骤 1：补 spec 链接 → 步骤 2：README 标 ✅ → 步骤 3：CHANGELOG 一条 → 步骤 4：release safety → 步骤 5：提交**

```bash
pnpm lint && pnpm typecheck && pnpm test && git diff --check
git add docs README.md README.zh-CN.md CHANGELOG.md
git commit -m "docs(v2): document ci feedback phase"
```

## 自审

Spec 覆盖：

- V2 §9 五种 pipeline 状态策略：Task 3 覆盖。
- V2 §12 CiStatusEvent：Task 2 覆盖（用 `ci_status_*` 三事件实现）。
- V2 §13 ci_lookup_failed 分类：Task 3 覆盖。
- V2 §14 ci 回流测试：Task 3、4、6 覆盖。

刻意延后：

- pipeline 日志摘要生成、按 job 名映射 reviewer：本计划不引入。
- webhook 实时事件：V3 范围（Webhook + poll 混合调度）。
- 多 MR 关联同一 issue 的歧义解决：V2 仍以 source branch 为主键，多 MR 场景写 `detail.notes` 占位提示。

类型一致性：

- `CiConfig`、`latestCiStatus`、新事件类型先于消费者使用前定义。

占位扫描：无 `TBD` / `TODO`。
