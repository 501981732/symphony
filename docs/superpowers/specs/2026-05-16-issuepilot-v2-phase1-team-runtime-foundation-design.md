# IssuePilot V2 Phase 1 - Team Runtime Foundation 补充设计

日期：2026-05-16
状态：已落地
对应计划：`docs/superpowers/plans/2026-05-15-issuepilot-v2-team-runtime-foundation.md`
上级设计：`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`

## 1. 定位

本补充设计把 V2 总 spec 中的 team runtime foundation 决策收敛成 Phase 1 的独立设计入口，解决实施计划缺少一对一 spec 的问题。它不替代 V2 总 spec，只固定 Phase 1 已落地的边界、非目标和验收状态。

Phase 1 的目标是先建立 team mode 的运行时骨架，让后续 dashboard 操作、CI 回流、review sweep 和 workspace retention 都能接在同一套 project-aware state、lease 和 API contract 上。

## 2. 已确认范围

Phase 1 包含：

- `issuepilot run --config <issuepilot.team.yaml>` team mode 入口。
- team config parser 和 project registry。
- file-backed run lease store。
- project-aware `/api/state` 和 shared contracts。
- dashboard overview 按 project 展示。
- V1 `--workflow` 单项目入口兼容。

Phase 1 不包含：

- dashboard 写操作。
- CI 状态回流。
- MR review feedback sweep。
- workspace cleanup。
- V2 team daemon 的完整 dispatch/runAgent 闭环。
- 多 worker、跨机器锁或数据库化 state。

## 3. 关键决策

1. team config 只聚合项目和运行策略，不复制 `WORKFLOW.md` 中的 prompt、labels、hooks 或 GitLab tracker 配置。
2. `project.id` 是 dashboard、API、events 和 storage path 的稳定项目标识；GitLab project 仍来自每个项目自己的 workflow。
3. 并发控制先通过 JSON file-backed lease store 实现，服务 shared-machine single-daemon 场景。
4. lease acquire 必须早于 GitLab label claim；如果 claim 失败，需要释放 lease，避免 state 和 GitLab label 分叉。
5. team daemon Phase 1 只提供 project-aware runtime shell，不装配后续 Phase 的 operator actions 或 CI scanner。

## 4. 完成状态

Phase 1 已合入 `main`。当前已具备实验性 team mode foundation，但还不是完整团队生产运行闭环。后续 Phase 2/3 的能力主要装配在 V1 single-workflow daemon；V2 team daemon 等完整 dispatch 落地后再补 operator actions 和 CI scanner 装配。

## 5. 验收口径

Phase 1 完成时必须满足：

1. `--workflow` 和 `--config` 互斥，且 V1 路径不回退。
2. team config 可加载两个以上项目，disabled 或加载失败的项目不会拖垮整个 daemon。
3. lease store 覆盖全局并发、单项目并发、同 issue 冲突、release 和 expiry。
4. `/api/state` 在 team mode 返回 `runtime` 和 `projects`，dashboard 能展示 project list。
5. `pnpm lint`、`pnpm typecheck`、`pnpm test` 通过。
