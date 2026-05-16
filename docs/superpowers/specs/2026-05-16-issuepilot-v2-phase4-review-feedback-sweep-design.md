# IssuePilot V2 Phase 4 - Review Feedback Sweep 补充设计

日期：2026-05-16
状态：已实施
对应计划：`docs/superpowers/plans/2026-05-15-issuepilot-v2-review-feedback-sweep.md`
上级设计：`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`

## 1. 定位

本补充设计是 V2 Phase 4 Review Feedback Sweep 的独立 spec 入口。Phase 4 是当前 V2 的下一步：在 Phase 3 CI 回流之后，把 MR review 评论收集成下一轮 `ai-rework` agent 的输入，避免人工把 review 意见手动复制到 issue 或 prompt。

## 2. 目标

Phase 4 完成后应满足：

1. IssuePilot 可以扫描 `human-review` 阶段 run 对应 MR 的 review comments。
2. scanner 只收集未 resolved 或自上次 cursor 之后新增的评论。
3. 生成结构化 `ReviewFeedbackSummary`，写入 run state 和 event log。
4. issue 回到 `ai-rework` 后，下一轮 agent prompt 自动包含最新 review feedback。
5. dashboard run detail 能展示最新 feedback 摘要。

## 3. 范围

Phase 4 包含：

- GitLab MR discussions/notes 的读取和过滤。
- `lastDiscussionCursor` 持久化。
- `ReviewFeedbackSummary` shared contract。
- `review_feedback_sweep_started`、`review_feedback_summary_generated`、`review_feedback_sweep_failed` 事件。
- prompt context 注入 `reviewFeedback`。
- dashboard detail 展示最新 feedback。

Phase 4 不包含：

- 自动 resolve GitLab discussion。
- 跨 MR、跨 issue 汇总。
- LLM 摘要或评论质量判断。
- review 评论触发自动 merge。
- 替代 Phase 3 CI 回流。

## 4. 关键决策

1. Review feedback sweep 由 orchestrator 执行，agent 不直接获得任意 GitLab 读取能力。
2. cursor 以 GitLab discussion/note 更新时间为基础，必须避免重复喂同一批评论。
3. IssuePilot 自己写入的 marker notes、handoff/failure/closing/ci-feedback notes 必须被过滤。
4. prompt 注入发生在下一轮 run 构造 prompt context 时，不修改历史 prompt。
5. lookup 失败只写 `review_feedback_sweep_failed`，不改变 labels，避免把 review 阶段误推进。

## 5. 与已完成 Phase 的关系

Phase 4 依赖 Phase 1 的 project-aware contract。它不强依赖 Phase 2 dashboard actions 或 Phase 3 CI feedback，但实际执行顺序上应放在 Phase 3 之后，原因是：

- CI failed 应先回流，避免 reviewer comments 和 failing CI 同时竞争 `ai-rework` 入口。
- Phase 3 已建立 review-stage scanner 的事件和 state 更新模式，Phase 4 应复用同一类 loop integration。

## 6. 验收口径

Phase 4 完成时必须满足：

1. 新增 / 重复 / resolved / bot note / lookup failure 路径有 focused 单测。
2. prompt render 测试覆盖 `reviewFeedback` 注入。
3. loop integration 不因单次 GitLab discussion 查询失败阻塞主循环。
4. dashboard 展示 feedback 摘要，长评论有安全截断。
5. focused E2E 覆盖至少一个 review comment -> `ai-rework` next prompt 的闭环。
