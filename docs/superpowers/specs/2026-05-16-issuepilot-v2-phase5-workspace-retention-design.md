# IssuePilot V2 Phase 5 - Workspace Retention 补充设计

日期：2026-05-16
状态：待实施
对应计划：`docs/superpowers/plans/2026-05-15-issuepilot-v2-workspace-retention.md`
上级设计：`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`

## 1. 定位

本补充设计是 V2 Phase 5 Workspace Retention 的独立 spec 入口。Phase 5 的目标不是“尽可能清理磁盘”，而是在团队共享机器上建立可解释、可 dry-run、失败现场优先保留的 workspace 生命周期策略。

## 2. 目标

Phase 5 完成后应满足：

1. `~/.issuepilot` workspace 可按状态、时间和容量预算生成 cleanup plan。
2. active run 永不清理。
3. failed / blocked run 的现场优先保留，默认保留时间长于 successful run。
4. cleanup 每一步都有事件，可在 dashboard 或 runbook 中审计。
5. 操作者可以通过 dry-run 预览清理计划。

## 3. 默认策略

默认 retention policy：

| Run 状态 | 默认保留 |
| --- | --- |
| active / running / stopping | 永不自动清理 |
| successful / closed | 7 天 |
| failed / blocked | 30 天 |
| archived terminal run | 仍按原终态保留策略计算 |

当总 workspace 超过 `max_workspace_gb` 时，只允许清理已经超过保留期的 terminal run。容量压力不能成为删除 active run 或未过期 failure 现场的理由。

## 4. 范围

Phase 5 包含：

- workflow/team config 的 retention 设置。
- cleanup planner 纯函数。
- cleanup executor。
- `workspace_cleanup_planned`、`workspace_cleanup_completed`、`workspace_cleanup_failed` 事件。
- `issuepilot doctor --workspace` dry-run。
- dashboard service header 展示 workspace usage 和下一次 cleanup window。
- operator runbook 和 rollback 文档。

Phase 5 不包含：

- 删除 GitLab branch 或 MR。
- workspace 归档到远端对象存储。
- 跨 host 共享 workspace 的协调协议。
- 数据库化 retention metadata。

## 5. 关键决策

1. planner 必须是纯函数，便于测试和 dry-run。
2. executor 单条失败不能阻塞后续 cleanup，但必须写 `workspace_cleanup_failed`。
3. cleanup 前必须先写 planned event；实际删除后写 completed event。
4. retention 不改变 GitLab labels、MR 或 issue 状态。
5. V1 `--workflow` 单项目入口也应支持 retention fallback，但默认行为必须保守。

## 6. 验收口径

Phase 5 完成时必须满足：

1. planner 覆盖 active、未到期、已到期、容量超限、失败保留和读取失败边界。
2. executor 覆盖 plan -> execute 全流程和单条失败 fail-soft。
3. dry-run 输出不删除任何文件。
4. dashboard 能展示 workspace usage / next cleanup。
5. runbook 说明如何暂停 cleanup、如何回滚误配置、如何定位删除失败。
