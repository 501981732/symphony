# IssuePilot V2 Review Feedback Sweep 实施计划

Phase：V2 Phase 4
状态：已实施
对应 spec：`docs/superpowers/specs/2026-05-16-issuepilot-v2-phase4-review-feedback-sweep-design.md`
上级 spec：`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`
上一步：V2 Phase 3 CI Feedback
下一步：V2 Phase 5 Workspace Retention

> **给执行 agent：** 执行本计划时必须使用子技能 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。步骤使用 checkbox（`- [ ]`）追踪。

**目标：** 把 MR 上的 human review 评论汇总成一段结构化 feedback，在 issue 被打回 `ai-rework` 时注入下一轮 agent prompt，并避免重复喂同一批评论。

**架构：** 新增 `apps/orchestrator/src/orchestrator/review-feedback.ts`，由 main loop 在 reconciliation 阶段后扫描 `human-review` 状态下的 MR notes（复用 `listMergeRequestNotes`）。每个 run 持久化 `lastDiscussionCursor`（更新时间），sweep 时只取游标之后或仍未 resolved 的评论。prompt 注入逻辑改 `@issuepilot/workflow` 的 `render`，在 context 中加入 `reviewFeedback`。

**前置：** Phase 1 已合入。可独立于 Phase 2/3 实施。

**技术栈：** TypeScript、Node.js 22、Vitest、`@issuepilot/tracker-gitlab`、`@issuepilot/workflow`、`@issuepilot/observability`。

---

## 范围检查

V2 设计 §10 把 review feedback sweep 限定为「把 review 评论汇总成 next-attempt 输入」。本计划覆盖：

- `listMergeRequestNotes` 之上新增过滤逻辑：去掉机器人评论（IssuePilot 自己写的 marker note）、按 cursor 过滤。
- 生成 `ReviewFeedbackSummary`：作者、文本、URL、createdAt。
- 事件：`review_feedback_sweep_started` / `review_feedback_summary_generated` / `review_feedback_sweep_failed`。
- prompt context 增加 `reviewFeedback` 字段；workflow 模板可以引用。
- run record 持久化 `lastDiscussionCursor`。

本计划明确不做：

- 把 review 评论自动 resolved（仍由人类操作）。
- 多 MR / 跨 issue 评论聚合。
- 给评论加摘要 LLM 调用（V2 仍是逐条原文汇总；摘要属于 V4 范围）。
- CI 回流（Phase 3）。

## 文件结构

- 修改：`packages/shared-contracts/src/events.ts` + 测试：新事件类型。
- 修改：`packages/shared-contracts/src/run.ts` + 测试：`RunRecord` 增加可选 `lastDiscussionCursor: string`、`latestReviewFeedback?: ReviewFeedbackSummary`。
- 新建：`packages/shared-contracts/src/review.ts`：`ReviewFeedbackSummary`、`ReviewComment` 类型。
- 修改：`packages/shared-contracts/src/index.ts`：导出 review 类型。
- 新建：`apps/orchestrator/src/orchestrator/review-feedback.ts`：导出 `sweepReviewFeedbackOnce`。
- 新建：`apps/orchestrator/src/orchestrator/__tests__/review-feedback.test.ts`：覆盖新增评论 / 重复评论 / 跳过机器人 note / lookup 失败 / 无评论。
- 修改：`apps/orchestrator/src/orchestrator/dispatch.ts` 或 `prompt` 装配点：在生成 prompt context 前合并 `latestReviewFeedback` 到 `reviewFeedback` 字段。
- 修改：`apps/orchestrator/src/orchestrator/__tests__/dispatch.test.ts`：覆盖 prompt context 注入。
- 修改：`packages/workflow/src/render.ts`：`PromptContext` 增加 `reviewFeedback?: ReviewFeedbackSummary` 字段。
- 修改：`packages/workflow/src/__tests__/render.test.ts`：覆盖 `{{ review_feedback.comments }}` 模板渲染。
- 修改：`apps/orchestrator/src/orchestrator/loop.ts` + 测试：在 reconciliation 之后调用 `sweepReviewFeedbackOnce`。
- 修改：`apps/dashboard/components/detail/run-detail-page.tsx` + 测试：在 detail 页底部增加 `Latest review feedback` 面板。
- 修改：`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`：在 Phase 4 节尾追加本计划链接。
- 修改：`README.md` / `README.zh-CN.md`：标注 ✅ review feedback sweep 实验性可用。
- 修改：`CHANGELOG.md`。

## 任务 1：扩展契约（events + RunRecord + ReviewFeedbackSummary）

**文件：**
- 修改：`packages/shared-contracts/src/events.ts` + 测试
- 修改：`packages/shared-contracts/src/run.ts` + 测试
- 新建：`packages/shared-contracts/src/review.ts`
- 修改：`packages/shared-contracts/src/index.ts`

- [ ] **步骤 1：写失败测试 → 步骤 2：跑确认失败 → 步骤 3：实现 → 步骤 4：跑 PASS → 步骤 5：提交**

`review.ts`：

```ts
export interface ReviewComment {
  noteId: number;
  author: string;
  body: string;
  url: string;
  createdAt: string;
  /** MR-side discussion id, used to group comments. */
  discussionId?: string;
  /** Whether reviewer marked the thread as resolved. */
  resolved: boolean;
}

export interface ReviewFeedbackSummary {
  mrIid: number;
  mrUrl: string;
  generatedAt: string;
  /** ISO-8601 cursor representing the latest note included in this summary. */
  cursor: string;
  comments: ReviewComment[];
}
```

`RunRecord` 增加：

```ts
  lastDiscussionCursor?: string;
  latestReviewFeedback?: ReviewFeedbackSummary;
```

新事件类型：

```ts
  "review_feedback_sweep_started",
  "review_feedback_summary_generated",
  "review_feedback_sweep_failed",
```

```bash
pnpm --filter @issuepilot/shared-contracts test
pnpm --filter @issuepilot/shared-contracts build
git add packages/shared-contracts
git commit -m "feat(contracts): add review feedback summary types"
```

## 任务 2：实现 sweepReviewFeedbackOnce

**文件：**
- 新建：`apps/orchestrator/src/orchestrator/review-feedback.ts`
- 新建：`apps/orchestrator/src/orchestrator/__tests__/review-feedback.test.ts`

- [ ] **步骤 1：写失败测试**

覆盖：

- 无 MR：emit `review_feedback_sweep_started` + `review_feedback_summary_generated` with `comments: []`。
- MR 有 3 条评论，其中 1 条是 IssuePilot 自己的 marker note → 过滤后剩 2 条；cursor 设为最新 note 的 `createdAt`。
- run 已有 cursor，MR 上新增 1 条 → summary 只含 1 条新评论。
- run 已有 cursor，MR 无新评论 → emit `review_feedback_summary_generated` with `comments: []`，不更新 cursor。
- `listMergeRequestNotes` 抛错 → emit `review_feedback_sweep_failed`，state 不变。

- [ ] **步骤 2：跑确认失败 → 步骤 3：实现 → 步骤 4：跑 PASS → 步骤 5：提交**

```ts
export interface SweepReviewFeedbackInput {
  workflow: WorkflowConfig;
  state: RuntimeState;
  gitlab: Pick<
    GitLabAdapter,
    "findMergeRequestBySourceBranch" | "listMergeRequestNotes"
  >;
  eventBus: EventBus<IssuePilotEvent>;
  now?: () => Date;
}

export async function sweepReviewFeedbackOnce(
  input: SweepReviewFeedbackInput,
): Promise<void>;
```

实现要点：

- 只扫 `latestState === "human-review"` 或 `status === "completed"` 且 issue.labels 含 handoffLabel 的 run。
- bot 过滤规则：body 含 `<!-- issuepilot:` marker 或作者 === workflow.tracker.botAccountName（如果存在）。
- summary 写回 `state.setRun(runId, { ...run, latestReviewFeedback, lastDiscussionCursor: maxCreatedAt })`。

```bash
git add apps/orchestrator/src/orchestrator/review-feedback.ts apps/orchestrator/src/orchestrator/__tests__/review-feedback.test.ts
git commit -m "feat(orchestrator): sweep human review feedback"
```

## 任务 3：prompt 注入

**文件：**
- 修改：`packages/workflow/src/types.ts`、`packages/workflow/src/render.ts`、`packages/workflow/src/__tests__/render.test.ts`
- 修改：`apps/orchestrator/src/orchestrator/dispatch.ts` + 测试

- [ ] **步骤 1：写失败测试**

workflow render 测试：模板 `Issue {{ issue.title }} feedback {% for c in review_feedback.comments %}- {{ c.body }}{% endfor %}` 渲染时把 `comments` 注入。

dispatch 测试：当 run.latestReviewFeedback 存在且 attempt > 1（i.e. 来自 ai-rework），生成的 prompt 应包含 `## Review feedback` 区段。

- [ ] **步骤 2：跑确认失败 → 步骤 3：实现 → 步骤 4：跑 PASS → 步骤 5：提交**

`PromptContext`：

```ts
  reviewFeedback?: ReviewFeedbackSummary;
```

dispatch.ts 在装配 prompt context 前，从 `state.getRun(runId)?.latestReviewFeedback` 读出（如果存在），通过 `workflowLoader.render` 注入。

```bash
git add packages/workflow apps/orchestrator/src/orchestrator/dispatch.ts apps/orchestrator/src/orchestrator/__tests__/dispatch.test.ts
git commit -m "feat(workflow): inject review feedback into prompt"
```

## 任务 4：main loop 调用 sweep

**文件：**
- 修改：`apps/orchestrator/src/orchestrator/loop.ts` + 测试

- [ ] **步骤 1：写失败测试**

补 loop 测试：每轮 reconciliation 之后调用 `sweepReviewFeedbackOnce`。如果 workflow 未启用 review sweep（暂用 workflow.tracker.handoffLabel 存在为前提即可，本计划不引入开关），无 review 阶段 run 时也要无副作用。

- [ ] **步骤 2：跑确认失败 → 步骤 3：实现 → 步骤 4：跑 PASS → 步骤 5：提交**

```bash
git add apps/orchestrator/src/orchestrator/loop.ts apps/orchestrator/src/orchestrator/__tests__/loop.test.ts
git commit -m "feat(orchestrator): integrate review sweep into main loop"
```

## 任务 5：dashboard 面板

**文件：**
- 修改：`apps/dashboard/components/detail/run-detail-page.tsx` + 测试

- [ ] **步骤 1：写失败测试**

detail page 测试：run.latestReviewFeedback 存在 → 渲染 `Review feedback` 区段，每条评论显示 author、createdAt、body 前 200 字截断。无 feedback 时不渲染该区段。

- [ ] **步骤 2 → 5：标准 TDD 闭环**

复用 `Card` + `Badge`；列表项加 `target="_blank"` 链接到 GitLab note URL。

```bash
git add apps/dashboard/components/detail
git commit -m "feat(dashboard): show latest review feedback panel"
```

## 任务 6：focused e2e

**文件：**
- 新建：`tests/e2e/review-feedback-sweep.test.ts`

- [ ] **步骤 1：实现 e2e**

- A：fake MR 有 1 条 review comment（非机器人）→ sweep 后 run.latestReviewFeedback 含该评论，cursor 设为 createdAt。
- B：fake MR 新增第 2 条评论 → 第二次 sweep 只返回新评论，cursor 前进。
- C：issue 被人工切到 `ai-rework` → 下一轮 dispatch 的 codex prompt 中包含评论文本。

- [ ] **步骤 2 → 3：跑 e2e + 提交**

```bash
pnpm --filter @issuepilot/tests-e2e test -- review-feedback-sweep
git add tests/e2e/review-feedback-sweep.test.ts
git commit -m "test(e2e): cover review feedback sweep into ai-rework"
```

## 任务 7：文档、CHANGELOG 与 release safety

- [ ] **步骤 1-5：spec 链接 + README ✅ + CHANGELOG + release safety + commit**

```bash
pnpm lint && pnpm typecheck && pnpm test && git diff --check
git add docs README.md README.zh-CN.md CHANGELOG.md
git commit -m "docs(v2): document review feedback sweep phase"
```

## 自审

Spec 覆盖：

- V2 §10 review feedback sweep 流程：Task 2 覆盖。
- V2 §12 ReviewFeedbackSweepEvent：Task 1 覆盖。
- V2 §13 review_sweep_failed 分类：Task 2 覆盖。
- V2 §14 review feedback 测试：Task 2、6 覆盖。

刻意延后：

- 评论摘要 LLM 调用、长评论截断算法：V2 仍保留原文，仅截断显示。
- 多 MR 评论合并：V2 单 MR 即可（IssuePilot 模型下一 issue 一 MR）。
- review sweep 开关字段（workflow 或 team config）：本计划默认始终启用扫 human-review 阶段；如未来需要关闭，再引入 workflow `reviewSweep.enabled`。

类型一致性：

- `ReviewFeedbackSummary` / `ReviewComment` / 新事件类型在 contracts 任务先于消费者使用前定义。

占位扫描：无 `TBD` / `TODO`。
