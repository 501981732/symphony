# Human Review Closure 设计规格说明

日期：2026-05-14
状态：待用户评审
关联主规格：`docs/superpowers/specs/2026-05-11-issuepilot-design.md`

## 1. 背景

IssuePilot P0 当前已经覆盖从 GitLab Issue `ai-ready` 到 Codex 执行、push branch、创建或更新 Merge Request、回写 Issue note，并把 Issue 切到 `human-review` 的 handoff 流程。

实际使用中，工程师会在 `human-review` 阶段人工 review 并手动 merge MR。当前 daemon 不会继续观察 `human-review` issue，也不会在 MR merged 后自动关闭 GitLab issue，导致 issue label、dashboard 统计和真实代码状态脱节。

本设计补齐 P0 的手动 merge 后收尾闭环：**人负责 merge 决策，IssuePilot 负责 merged 后自动关闭 issue。**

## 2. 目标

- `human-review` issue 对应的 MR 被人工 merge 后，IssuePilot 自动写 final note、移除 `human-review` label，并关闭 GitLab issue。
- MR 仍 open 时不做状态变更。
- MR 被关闭但未 merge 时，IssuePilot 将 issue 从 `human-review` 回流到 `ai-rework`。
- 找不到对应 MR、GitLab API 失败或 issue 状态被人工改动时，不关闭 issue，只记录事件。
- 不引入自动 merge，不启用 `ai-merging`。

## 3. 非目标

- 不自动 merge MR。
- 不判断 GitLab approval rule 是否满足。
- 不在 P0 中实现 CI 失败自动回流。
- 不新增 dashboard 操作按钮。
- 不新增 `ai-done` label；终态使用 GitLab issue closed 状态表达。

## 4. 状态流转

P0 闭环变为：

```text
ai-ready -> ai-running -> human-review -> closed
ai-rework -> ai-running -> human-review -> closed

human-review + MR opened          -> no-op
human-review + MR merged          -> close issue
human-review + MR closed unmerged -> ai-rework
human-review + MR missing         -> no-op + event
```

`closed` 是 GitLab Issue 的关闭状态，不是 label。`ai-merging` 继续作为未来自动 merge 流程的保留 label，P0 不使用。

## 5. MR 识别规则

`human-review` reconciliation 必须优先使用 IssuePilot 自己写入的 workpad note 或 run event 中的 branch 信息，然后通过 source branch 查询 MR。

推荐顺序：

1. 读取 issue 上的 IssuePilot workpad note，解析 `Branch: <branch>`。
2. 如果本地 run store/event store 中有同 issue 的最新 run，也可作为辅助来源。
3. 用 source branch 查询 GitLab MR。
4. 如果同一 source branch 有多个 MR，优先级为：`opened`、最近的 `merged`、最近的 `closed`。

不能用 MR title 或 issue title 作为主匹配条件，因为 title 可能被人工修改，issue title 也可能在重试期间变化。

## 6. 安全关闭条件

自动关闭 issue 必须同时满足：

1. issue 当前是 open。
2. issue 当前包含 `human-review` label。
3. 找到对应 MR。
4. MR state 是 `merged`。
5. MR source branch 等于 IssuePilot 记录的 branch。
6. 关闭前重新读取 issue，确认仍然是 open 且仍包含 `human-review`。

任一条件不满足时，daemon 不关闭 issue。

## 7. Orchestrator 行为

daemon 每个 poll tick 在 claim 新任务之前执行 `reconcileHumanReview`：

1. 查询带 `human-review` 的 open issues。
2. 对每个 issue 尝试解析 IssuePilot branch。
3. 查询 source branch 对应 MR。
4. 按 MR 状态处理：
   - `opened`：记录 `human_review_mr_still_open`，不改 issue。
   - `merged`：写 final note，移除 `human-review`，关闭 issue。
   - `closed`：移除 `human-review`，添加 `ai-rework`。
   - missing/unknown/error：记录事件，不改 issue。

该流程不占用 agent concurrency slot，因为它不启动 Codex，不准备 worktree，也不执行 hook。

## 8. GitLab Adapter 需求

tracker-gitlab 需要补充或确认这些能力：

- 按 label 查询 open issues，支持查询 `human-review`。
- 按 source branch 查询 MR，返回 `iid`、`webUrl`、`state`、`sourceBranch`、`updatedAt`。
- 关闭 GitLab issue。
- 写 issue note。
- 更新 issue labels。

GitLab 写操作仍通过 adapter 收口，orchestrator 不直接依赖 GitLab SDK shape。

## 9. 事件

新增事件：

```text
human_review_scan_started
human_review_mr_found
human_review_mr_missing
human_review_mr_still_open
human_review_mr_merged
human_review_issue_closed
human_review_mr_closed_unmerged
human_review_rework_requested
human_review_reconcile_failed
```

事件 detail 至少包含 `issueIid`；找到 MR 时包含 `mrIid`、`mrState`、`branch`。

## 10. Dashboard

P0 dashboard 只读，不新增按钮。

- overview 的 `human-review` 数量会在 merged MR 自动关闭 issue 后下降。
- run detail timeline 展示 MR merged 和 issue closed 事件。
- `human_review_mr_missing`、`human_review_reconcile_failed` 通过现有 timeline 暴露。

## 11. 测试

tracker-gitlab：

- 按 source branch 查询 MR，覆盖 opened、merged、closed。
- close issue 调用正确 project 和 issue iid。

orchestrator：

- `human-review + merged MR`：写 final note，移除 `human-review`，关闭 issue。
- `human-review + opened MR`：不改 label，不关闭 issue。
- `human-review + closed unmerged MR`：切到 `ai-rework`。
- 找不到 MR：不关闭 issue。
- close 前 issue label 已被人工移除：不关闭 issue。
- GitLab API 失败：记录失败事件，不影响后续 claim。

fake E2E：

- issue 从 `ai-ready` 跑到 `human-review`。
- fake MR 状态改成 `merged`。
- 下一轮 daemon 自动关闭 issue。

## 12. Rollout 和回滚

该能力默认启用，因为它只处理 `human-review` 且 MR state 为 `merged` 的 issue，不改变运行中 agent 行为。

回滚方式：

- 临时关闭 daemon，或移除 loop 中的 `reconcileHumanReview` 调用。
- 如果误关闭 issue，需要人工 reopen。

为了降低误关闭风险，必须先实现安全关闭条件和测试，再接入 loop。
