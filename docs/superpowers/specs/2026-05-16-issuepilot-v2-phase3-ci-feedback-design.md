# IssuePilot V2 Phase 3 - CI Feedback 补充设计

日期：2026-05-16
状态：已落地
对应计划：`docs/superpowers/plans/2026-05-15-issuepilot-v2-ci-feedback.md`
上级设计：`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`

## 1. 定位

本补充设计是 V2 Phase 3 CI 回流的独立 spec 入口。它把 V2 总 spec §9 的方向、实施计划中的落地细节和 code review 后的收口决策汇总到一个稳定位置，避免只有 plan 和 CHANGELOG 记录实现状态。

Phase 3 的目标是在 `human-review` 阶段读取 MR pipeline 状态，让 CI failed 的 run 可以按策略自动回流到 `ai-rework`，减少 reviewer 在 CI 未通过时的人工判断成本。

## 2. 已确认范围

Phase 3 包含：

- workflow `ci` 配置：`enabled`、`on_failure`、`wait_for_pipeline`。
- team config / project config 的 CI override，effective config 写回 registered workflow。
- `scanCiFeedbackOnce` scanner。
- `ci_status_observed`、`ci_status_rework_triggered`、`ci_status_lookup_failed` 事件。
- `RunRecord.latestCiStatus` 和 `latestCiCheckedAt`。
- dashboard overview/detail 展示最新 CI 状态。
- fake E2E 覆盖 success、failed、lookup failed、human-review 策略和 canceled dedup 场景。

Phase 3 不包含：

- pipeline log 摘要。
- webhook 实时回流。
- 自动 merge。
- review feedback sweep。
- 多 MR 关联同一 issue 的复杂消歧。
- V2 team daemon 中的 CI scanner 装配。

## 3. 状态策略

CI scanner 只在 workflow `ci.enabled: true` 时注入 daemon loop。运行中修改 `ci.enabled` 不热生效，需要重启 `issuepilot run`。

pipeline 状态处理：

| Pipeline 状态 | 默认动作 |
| --- | --- |
| `success` | 保持 `human-review`，记录 observed event |
| `failed` + `on_failure: ai-rework` | 写 marker note，移除 `human-review`，加 `ai-rework` |
| `failed` + `on_failure: human-review` | 保持 `human-review`，只记录状态 |
| `running` / `pending` / `unknown` | 等待下一轮，不写 marker note |
| `canceled` / `skipped` | 写人工判断提示 note，保持 `human-review` |

`unknown` 必须按 wait 处理，不能提前占用 `<!-- issuepilot:ci-feedback:<runId> -->` marker note；否则后续真实 failed 状态可能被 dedup 误跳过。

## 4. 关键决策

1. review-stage 候选以 `RunRecord.status === "completed"` 为主，GitLab label 当前态由 `transitionLabels(requireCurrent:[handoffLabel])` 做最后防护。
2. rework / manual note 使用同一个 ci-feedback marker，scanner 必须通过 `findWorkpadNote` 做跨 poll 幂等。
3. human-review 终态后写入 `endedAt`，scanner 跳过已经关闭或已回流的 run。
4. emitted event data 进入 event bus 前必须过 `redact()`。
5. V2 team daemon Phase 1 没有真实 dispatch/runAgent，本期不装配 CI scanner。

## 5. 完成状态

Phase 3 已合入 `main`。当前 V2 进度应视为：Phase 1、Phase 2、Phase 3 已完成；下一步是 Phase 4 Review Feedback Sweep。

## 6. 验收口径

Phase 3 完成时必须满足：

1. workflow/team/project 三层 CI 配置优先级明确，并有单测覆盖。
2. success/failed/running/pending/unknown/canceled/skipped 的处理路径有单测。
3. failed pipeline 可以按配置回流到 `ai-rework` 并写结构化 note。
4. marker note 幂等，连续 poll 不重复写同一类提示。
5. dashboard 能显示 latest CI status。
6. focused E2E 覆盖主要 CI 回流路径。
