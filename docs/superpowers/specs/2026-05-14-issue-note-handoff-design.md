# IssuePilot Issue Note Handoff 设计

## 背景

IssuePilot 当前会在 GitLab Issue 中写入多类 note：

- agent 通过 `gitlab_create_issue_note` 写入的自由文本 note。
- orchestrator reconcile 阶段写入或更新的 workpad note。
- 失败或阻塞时写入的 failure note。
- MR 被人工 merge 后写入的 closing note。

这些 note 已经能表达基本状态，但对人工 review 不够稳定：agent note 没有结构约束，workpad note 缺少 MR 链接，失败 note 信息偏少，主设计文档中对 workpad note 的“开始时创建、持续更新”描述也和当前实现存在漂移。

本设计只收敛 Issue note / handoff note 的语义和格式，不改变 label 状态机、MR 创建策略、GitLab adapter 边界或 Codex app-server runner 边界。

## 目标

1. 让 GitLab Issue 本身成为清晰的人类接手点。
2. 每次成功 run 都产生一条结构稳定、可更新、可恢复定位的 handoff note。
3. 人工 reviewer 不需要翻 dashboard 或日志，也能知道改了什么、验证了什么、看哪个 MR、下一步怎么处理。
4. failure / blocked / closing note 和 handoff note 使用同一套字段语言，降低理解成本。
5. 保留 `<!-- issuepilot:run:<runId> -->` marker 作为恢复、去重和 human-review reconciliation 的机器锚点。

## 非目标

- 不引入新的 GitLab label。
- 不在 P0 自动 merge MR。
- 不把完整日志写入 Issue note。
- 不让 agent 自由决定最终 handoff note 的结构。
- 不要求本次设计立即重构 dashboard timeline。

## 推荐方案

采用单条结构化 handoff note。orchestrator 在 reconcile 阶段生成或更新这条 note，并把 agent summary、validation、risks、branch、MR 信息和下一步动作写入固定模板。

agent 仍可通过 `gitlab_create_issue_note` 写临时说明，但最终进入 `human-review` 前，orchestrator 负责写入规范化 handoff note。这样可以保留 agent 灵活性，同时保证 Issue 上的最终交接内容可读、可测、可恢复。

## 成功 handoff note 格式

```md
<!-- issuepilot:run:<runId> -->
## IssuePilot handoff

- Status: human-review
- Run: `<runId>`
- Attempt: <attempt>
- Branch: `<branch>`
- MR: !<iid> <mrUrl>

### What changed
<agent summary or fallback>

### Validation
<agent validation or fallback>

### Risks / follow-ups
<agent risks or "None reported.">

### Next action
Review and merge the MR, or move this Issue to `<reworkLabel>` if changes are required.
```

字段要求：

- `Status` 使用业务状态，不使用内部事件名。
- `MR` 必须在 MR 创建或找到后写入。无代码变更且没有 MR 时，写 `MR: not created`，并在 `What changed` 中说明原因。
- `What changed`、`Validation`、`Risks / follow-ups` 禁止为空；缺失时使用明确 fallback。
- `Next action` 使用 workflow 中配置的 rework label，不硬编码 `ai-rework`。

## Failure / Blocked Note 格式

失败和阻塞仍写独立 note，但格式与 handoff note 对齐：

```md
## IssuePilot run blocked

- Status: ai-blocked
- Run: `<runId>`
- Attempt: <attempt>
- Branch: `<branch>`

### Reason
<classification reason>

### Next action
Provide the missing information, permission, or secret, then move this Issue back to `<readyLabel>`.
```

普通失败使用 `IssuePilot run failed` 和 `Status: ai-failed`。如果失败发生时 runId 或 branch 不可用，字段写 `unknown`，但不得省略字段。

## Closing Note 格式

MR 被人工 merge 后，orchestrator 写 closing note 并关闭 Issue：

```md
## IssuePilot closed this issue

- Status: closed
- Run: `<runId>`
- Branch: `<branch>`
- MR: !<iid> <mrUrl>

### Result
The linked MR was merged by a human reviewer, so IssuePilot removed `<handoffLabel>` and closed this Issue.
```

closing note 不需要重复实现摘要；摘要已经在 handoff note 和 MR description 中。

## Data Flow

1. Codex run 结束后，orchestrator 进入 reconcile。
2. orchestrator 判断是否存在新 commit。
3. 有新 commit 时 push branch，并 create/update MR。
4. orchestrator 根据 runId 查找已有 IssuePilot marker note。
5. 不存在则创建 handoff note，存在则更新同一条 note。
6. handoff note 写入完成后，label 从 running 切到 handoff。
7. human-review reconciliation 继续依赖 marker 中的 runId 和 branch 定位 MR。

这个顺序保证进入 `human-review` 时，Issue 上已经有完整 handoff 信息。

## Error Handling

- MR 创建失败：不写成功 handoff note，按现有失败路径转 `ai-failed` 或 `ai-blocked`。
- note 创建失败：不得切到 `human-review`，否则 reviewer 会看到无交接信息的 Issue。
- note 更新失败：保留 Issue 在 running 或失败状态，并写事件日志。
- closing note 创建成功但 close issue 失败：允许后续重试，但实现应尽量通过 marker 或最近 note 检查避免重复 closing note。

## 文档同步

主设计文档 `docs/superpowers/specs/2026-05-11-issuepilot-design.md` 需要同步更新：

- 把 workpad note 描述从“开始时创建、持续更新”改为“reconcile 阶段创建或更新最终 handoff note”。
- 统一 marker 为 `<!-- issuepilot:run:<runId> -->`。
- 明确 fallback note 不再是独立第三类成功 note，而是 handoff note 字段 fallback。

README 和 getting-started 中关于 handoff note 的说明也应更新为结构化模板。

## 测试要求

实现该设计时至少补充以下测试：

- reconcile 创建 handoff note 时包含 runId、attempt、branch、MR、summary、validation、risks 和 next action。
- reconcile 更新已有 marker note，而不是创建重复 handoff note。
- no-code-change 路径写入 `MR: not created` 和明确 no-code-change reason。
- failure / blocked note 包含状态、原因和 next action。
- human-review closing note 使用新模板。
- 文档中的 marker 和代码中的 marker 保持一致。

## 迁移策略

不需要迁移旧 note。新 run 写新模板；旧 run 仍可通过已有 marker 被识别。human-review reconciliation 应继续接受当前 marker 格式 `<!-- issuepilot:run:<runId> -->`，不新增第二种格式。

## Rollback

如果结构化 handoff note 在真实 GitLab 上造成噪音或 reviewer 反馈不佳，可以只回滚模板内容，不回滚 marker、去重和字段 fallback 机制。label 状态机和 MR 创建流程不受影响。
