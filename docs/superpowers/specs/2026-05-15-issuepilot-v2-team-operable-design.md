# IssuePilot V2 团队可运营版本设计

日期：2026-05-15（最近一次状态更新：2026-05-16）
状态：已确认；**Phase 1–5 全部合入 `main`，V2 团队可运营版本主体功能已落地**
关联文档：

- `docs/superpowers/specs/2026-05-11-issuepilot-design.md`
- `docs/superpowers/specs/2026-05-15-issuepilot-gap-closure-design.md`
- `docs/superpowers/specs/2026-05-15-issuepilot-v1-local-release-design.md`
- `docs/superpowers/plans/2026-05-15-issuepilot-v1-installable-local-release.md`
- `docs/superpowers/specs/2026-05-16-issuepilot-v2-phase1-team-runtime-foundation-design.md`
- `docs/superpowers/specs/2026-05-15-issuepilot-v2-phase2-dashboard-operations-design.md`
- `docs/superpowers/specs/2026-05-16-issuepilot-v2-phase3-ci-feedback-design.md`
- `docs/superpowers/specs/2026-05-16-issuepilot-v2-phase4-review-feedback-sweep-design.md`
- `docs/superpowers/specs/2026-05-16-issuepilot-v2-phase5-workspace-retention-design.md`
- `docs/superpowers/specs/2026-05-17-issuepilot-central-workflow-config-design.md`
- `docs/superpowers/plans/2026-05-17-issuepilot-central-workflow-config.md`
- `docs/superpowers/diagrams/v2-architecture.mmd`（V2 架构图源）
- `docs/superpowers/diagrams/v2-flow.mmd`（V2 端到端生命周期流程图源）
- `docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md`（Phase 5 操作 runbook）

## 0. 文档入口和当前进度

本文件是 V2 的总设计 spec，也是 V2 文档导航入口。每个 V2 实施计划必须有一个对应的
补充 spec；补充 spec 只锁定该 Phase 的细节，不替代本总 spec。

当前 V2 进度：**Phase 1、Phase 2、Phase 3、Phase 4、Phase 5 全部已合入 `main`。**
V2 团队可运营版本的功能交付已经完成；剩余条目集中在「真实试点验证」与「team-mode
workspace cleanup wiring」两个面向（详见 §16 Phase 5 与 §17 完成标准）。
2026-05-17 新增的中心化 workflow 配置设计是后续 team-mode 配置收敛增强，不改变
Phase 1-5 已落地状态；由于当前仍是实验阶段，已经按计划破坏式替换了
`issuepilot.team.yaml -> projects[].workflow` 输入模型，team mode 现在统一通过
中心配置目录管理 `project` 文件和 `workflow_profile`，并在内部编译为 effective
workflow。落地详情参见 `docs/superpowers/specs/2026-05-17-issuepilot-central-workflow-config-design.md`
与 `docs/superpowers/plans/2026-05-17-issuepilot-central-workflow-config.md`。

| 顺序 | Phase | 状态 | 对应 spec | 对应 plan |
| --- | --- | --- | --- | --- |
| 1 | Team Runtime Foundation | 已完成 | `2026-05-16-issuepilot-v2-phase1-team-runtime-foundation-design.md` | `2026-05-15-issuepilot-v2-team-runtime-foundation.md` |
| 2 | Dashboard Operations | 已完成 | `2026-05-15-issuepilot-v2-phase2-dashboard-operations-design.md` | `2026-05-15-issuepilot-v2-dashboard-operations.md` |
| 3 | CI Feedback | 已完成 | `2026-05-16-issuepilot-v2-phase3-ci-feedback-design.md` | `2026-05-15-issuepilot-v2-ci-feedback.md` |
| 4 | Review Feedback Sweep | 已完成 | `2026-05-16-issuepilot-v2-phase4-review-feedback-sweep-design.md` | `2026-05-15-issuepilot-v2-review-feedback-sweep.md` |
| 5 | Workspace Retention | 已完成（V1 入口已激活；team daemon wiring 列为后续 follow-up） | `2026-05-16-issuepilot-v2-phase5-workspace-retention-design.md` | `2026-05-15-issuepilot-v2-workspace-retention.md` |

> **可视化入口**：`docs/superpowers/diagrams/v2-architecture.mmd` 给出 V2 五个 Phase
> 共同构成的运行时层级图；`docs/superpowers/diagrams/v2-flow.mmd` 给出 GitLab issue
> 在 V2 下从 `ai-ready` 走到关闭/失败/打回的完整生命周期流程图。两份文件都附带渲染好
> 的 SVG 产物，README 与使用手册直接引用。

阅读顺序：

1. 先读本文件的目标、边界和架构。
2. 再按上表顺序读对应 Phase 的补充 spec。
3. 真正执行时读对应 plan；plan 只作为实施任务拆解，不作为产品源头。

## 1. 背景

IssuePilot P0 已闭合本地单机闭环，V1 把闭环包装成可安装的本地 CLI，并保留
source-checkout 作为贡献者开发和紧急回滚路径。V2 的任务不是继续堆单机功能，而是把
IssuePilot 从“一个人本机跑一个项目”推进到“团队共享机器上可持续运营多个项目”。

V2 必须优先解决团队运行时的确定性问题：

- 多项目 workflow 如何加载、隔离和展示。
- 并发从 1 提升到 2-5 后如何避免重复 claim、重复 run 和资源挤压。
- dashboard 写操作如何进入 orchestrator，而不是让 UI 绕过状态机。
- CI、review feedback、workspace cleanup 这些自动化动作如何被审计和回滚。

V2 仍不是生产化执行平台。鉴权层、权限模型、预算、多 worker、容器 sandbox、Postgres
run history 和多 tracker 都留给正式应用阶段或更后续版本。

## 2. 目标

V2 交付一个 team-operable release。目标使用路径是：

```bash
issuepilot run --config /path/to/issuepilot.team.yaml
issuepilot dashboard --api-url http://127.0.0.1:4738
```

团队可以在一台共享机器或内网服务上运行一个 daemon，并让多个工程师通过 dashboard
观察和操作日常 IssuePilot run。

V2 完成后应满足：

1. 单个 daemon 可以管理多个 GitLab 项目的 workflow。
2. team mode 使用中心化 workflow profile + 项目事实配置，并编译为内部 `WorkflowConfig`；不为旧 `projects[].workflow` 实验 schema 增加兼容层。
3. 全局并发默认 2，支持配置到 5；同一 issue 只能有一个 active lease。
4. dashboard 支持基础操作：`retry`、`stop`、`archive run`。
5. CI 状态可被读取；失败后按策略回流到 `ai-rework` 或保持 `human-review` 并提示人工。
6. MR review feedback 可被 sweep 成下一轮 agent 输入。
7. dashboard 和报告直接展示结构化 handoff / failure / blocked / closing note 字段。
8. workspace cleanup 有明确 retention policy，失败现场默认保留。
9. 关键操作都有事件记录、操作者记录和可诊断的失败路径。

## 3. 非目标

V2 不做以下内容：

- 多租户权限系统。
- 远程 worker 池、SSH worker、Docker 或 Kubernetes sandbox。
- Postgres / SQLite 作为强依赖的长期 run history。
- 任意 tracker 插件化；GitLab 仍是唯一一等 tracker。
- 自动 merge 作为默认行为。
- 大模型质量分析、成本预算、跨 issue 依赖规划。
- workflow 可视化拖拽编辑器。
- 将 dashboard 变成通用项目管理系统。

## 4. 设计选项

### 方案 A：V2 先做 Team Runtime Foundation（推荐）

先交付多项目配置、并发租约、dashboard 操作 API、统一事件审计和基础 retention。
CI 回流、review feedback sweep 和报告增强在这个底座上分阶段加入。

优点：

- 先稳定状态模型，后续功能不会绕开 orchestrator。
- 能用小范围真实试点验证多项目和并发风险。
- dashboard 写操作从第一天就进入统一状态机和事件记录边界。

缺点：

- 第一版 V2 看起来偏“底座”，业务可见的新功能不如 CI / review 自动化醒目。

### 方案 B：V2 先做 Dashboard 操作体验

优先做 `retry`、`stop`、`archive run` 和报告页面，让用户快速感知 V2 变化。
多项目和并发只做最小支持。

优点：

- 体验提升最明显。
- 能快速收集 reviewer / operator 的使用反馈。

缺点：

- 如果租约和多项目边界不稳，UI 操作会放大竞态和恢复复杂度。
- 后续补底座时容易重写操作 API。

### 方案 C：V2 先做 CI + Review 自动化

优先接入 GitLab pipeline / MR discussion，把 CI failed 和 review comments 自动喂回
`ai-rework`。

优点：

- 直接减少人工粘贴 review 反馈的成本。
- 对日常研发流程最有业务价值。

缺点：

- 依赖稳定的 MR/run 关联、事件 contract、retry 语义和 dashboard 可观测性。
- 没有 team runtime 底座时，失败恢复和审计会不清晰。

推荐采用方案 A，把 B 和 C 切成后续 V2 增量任务。

## 5. 总体架构

V2 保持 V1 的包边界，但新增一个 team runtime 层：

```text
issuepilot.team.yaml
  -> team config loader
  -> project registry
  -> global scheduler
  -> project-scoped workflow loader
  -> lease store
  -> run dispatcher
  -> GitLab / Codex / workspace adapters
  -> event store + dashboard API
```

关键原则：

- team config 是团队配置入口：中心配置仓库管理 workflow profile、policy 和项目事实。
- loader 编译出 effective `WorkflowConfig` 后交给 runtime；这是内部运行态，不是旧 `projects[].workflow` 的兼容层。
- repo-owned `WORKFLOW.md` 不再作为 team mode 的事实来源。
- orchestrator 是唯一写入 GitLab label、note、MR 和 run state 的组件。
- dashboard 所有写操作都调用 orchestrator API，并产生 audit event。
- 并发控制以 lease 为中心，而不是只靠内存 slot。

## 6. Team Config

新增可选 team config 文件：

```yaml
version: 1

server:
  host: 127.0.0.1
  port: 4738

scheduler:
  max_concurrent_runs: 2
  max_concurrent_runs_per_project: 1
  lease_ttl_ms: 900000
  poll_interval_ms: 10000

defaults:
  labels: ./policies/labels.gitlab.yaml
  codex: ./policies/codex.default.yaml
  workspace_root: ~/.issuepilot/workspaces
  repo_cache_root: ~/.issuepilot/repos

projects:
  - id: platform-web
    name: Platform Web
    project: ./projects/platform-web.yaml
    workflow_profile: ./workflows/default-web.md
    enabled: true
  - id: infra-tools
    name: Infra Tools
    project: ./projects/infra-tools.yaml
    workflow_profile: ./workflows/default-node-lib.md
    enabled: true

retention:
  successful_run_days: 7
  failed_run_days: 30
  max_workspace_gb: 50
```

`--config <path>` 启用 V2 team mode。team mode 不接受 repo-owned `WORKFLOW.md` 作为
项目配置来源。

`project.id` 是 V2 dashboard、API、events 和 storage path 的稳定项目标识。
effective workflow 内的 `tracker.project_id` 仍表示 GitLab project。

## 7. 调度与租约

V1 的内存并发槽位不足以支撑 team mode。V2 引入 lightweight lease store，仍可先用
`~/.issuepilot/state` 下的 JSON 文件实现，不强制引入数据库。

租约字段：

```ts
interface RunLease {
  leaseId: string;
  projectId: string;
  issueId: string;
  runId: string;
  branchName: string;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
  owner: string;
  status: "active" | "released" | "expired";
}
```

调度规则：

1. 每轮 poll 先恢复 active leases，再检查过期 lease。
2. 同一 `projectId + issueId` 同时只能存在一个 active lease。
3. 全局 active lease 数不能超过 `scheduler.max_concurrent_runs`。
4. 单项目 active lease 数不能超过 `max_concurrent_runs_per_project`。
5. daemon 正常退出时释放 active lease；异常退出后由 TTL 和 GitLab labels 恢复。
6. lease acquire 成功后才允许 GitLab claim label 从 `ai-ready` / `ai-rework` 切到
   `ai-running`。

V2 不要求跨机器强一致。共享机器单 daemon 是目标形态；lease store 是为了 crash
recovery、dashboard 操作和未来 V3 多 worker 做准备。

## 8. Dashboard 操作

V2 dashboard 增加三个基础操作：

| 操作 | 适用状态 | 行为 |
| --- | --- | --- |
| `retry` | `ai-failed`、`ai-blocked`、`ai-rework`、archived failed run | 创建新 attempt，按 label 策略回到 candidate 队列 |
| `stop` | active `ai-running` run | 请求 runner 取消 turn，释放 lease，写 failure/blocked note |
| `archive run` | terminal run | 从默认列表隐藏 run，保留 event log 和 workspace retention 记录 |

API 草案：

```text
POST /api/v1/projects/:projectId/runs/:runId/retry
POST /api/v1/projects/:projectId/runs/:runId/stop
POST /api/v1/projects/:projectId/runs/:runId/archive
```

操作要求：

- 所有操作都写 `operator_action` event。
- 操作者身份 V2 可先使用本机用户名或 dashboard-provided display name；完整 RBAC 留到 V3。
- stop 必须是 best-effort：优先取消 Codex turn，失败时标记 run 为 stopping，并通过
  timeout / process exit 收敛。
- retry 不复用旧 worktree 作为默认行为，除非 workflow 明确允许。

## 9. CI 状态回流

V2 读取 GitLab MR pipeline 状态，但默认不自动 merge。

状态策略：

- pipeline success：保持 `human-review`，dashboard 标记可 review。
- pipeline failed：默认写 structured note，并切到 `ai-rework`。
- pipeline running / pending：保持 `human-review`，等待下一轮 poll。
- pipeline canceled / skipped：写 note，保持 `human-review`，提示人工判断。

配置：

```yaml
ci:
  enabled: true
  on_failure: ai-rework
  wait_for_pipeline: true
```

CI 回流必须基于 MR source branch 或 marker note 找到对应 run，不能仅按 issue 最新 MR
猜测。

## 10. Review Feedback Sweep

V2 支持把 MR review comments 转成下一轮 agent 输入，但不直接让 agent 自己读取任意
GitLab discussion。

流程：

1. human reviewer 在 MR 上评论。
2. IssuePilot poll `human-review` issue 的 MR discussions。
3. 只收集未 resolved 或自上次 sweep 后新增的讨论。
4. 生成 review feedback summary，写入 run event。
5. 如果 issue 被打回 `ai-rework`，下一次 run prompt 包含 feedback summary。

sweep 需要记录 `lastDiscussionCursor`，避免重复喂同一批评论。

## 11. Workspace Retention

V2 增加 retention policy，但失败现场仍优先保留。

默认策略：

- successful / closed run workspace 保留 7 天。
- failed / blocked run workspace 保留 30 天。
- active run 永不清理。
- 总 workspace 超过 `max_workspace_gb` 时，只清理已超过保留期的 terminal run。
- 清理前写 `workspace_cleanup_planned` event，清理后写 `workspace_cleanup_completed`
  或 `workspace_cleanup_failed` event。

cleanup 不删除 GitLab branch 或 MR。远端分支清理属于后续 release 管理任务。

## 12. 数据与事件契约

V2 必须扩展 shared contracts，而不是让 dashboard 解析内部对象。

新增或扩展：

- `ProjectSummary`
- `TeamRuntimeSummary`
- `RunLease`
- `OperatorActionEvent`
- `CiStatusEvent`
- `ReviewFeedbackSweepEvent`
- `WorkspaceCleanupEvent`

所有 API response 必须包含 `projectId`。V1 单项目模式可以使用保留 id
`default`，以降低 dashboard 代码分叉。

## 13. 错误处理

V2 的错误分类：

- `config_error`：team config 或 workflow 无效。项目禁用，不影响其他项目。
- `lease_conflict`：发现同 issue active lease 冲突。保留现有 lease，写 warning event。
- `operator_action_failed`：dashboard 操作失败。run 状态不应被部分更新。
- `ci_lookup_failed`：GitLab pipeline 查询失败。保持原 label，等待下一轮。
- `review_sweep_failed`：评论查询失败。保持 `human-review`，dashboard 显示告警。
- `cleanup_failed`：workspace 清理失败。保留 workspace 并写原因。

任何单项目失败都不能拖垮整个 daemon，除非是全局配置、state store 或 credentials
不可用。

## 14. 测试策略

V2 实现需要覆盖：

1. team config parser：多项目、重复 project id、无效 project/profile、默认值。
2. lease store：acquire/release/expire、同 issue 冲突、crash recovery。
3. scheduler：全局并发、单项目并发、公平性和 disabled project。
4. dashboard actions：retry/stop/archive API 与事件。
5. CI 回流：success/failed/running/canceled/skipped。
6. review feedback sweep：新增评论、重复评论、resolved 评论。
7. workspace retention：成功/失败/active run 的清理边界。
8. E2E：两个 fake GitLab 项目并发运行，至少一个 retry 或 stop 场景。

真实 smoke 应新增 team-mode runbook：两个 sandbox 项目、并发 2、一个正常 handoff、
一个 CI failed 或 review rework。

## 15. 实验期切换

- team mode 直接切换到中心配置 schema，不为旧 `projects[].workflow` 做兼容加载。
- `projects[].project` 和 `projects[].workflow_profile` 是 team mode 的项目配置入口。
- repo-owned `WORKFLOW.md` 不再作为 team mode 的事实来源。
- V2 不要求自动迁移旧 workspace；retention 只管理 V2 可识别的 run metadata。
- 文档、fixture 和 runbook 一次性更新到中心配置写法。

## 16. 分阶段交付

### Phase 1：Team Runtime Foundation

状态：已完成，已合入 `main`。

- team config parser。
- project registry。
- lease store。
- scheduler 多项目并发。
- dashboard overview 按 project 分组。

补充设计：

- `docs/superpowers/specs/2026-05-16-issuepilot-v2-phase1-team-runtime-foundation-design.md`

实施计划：

- `docs/superpowers/plans/2026-05-15-issuepilot-v2-team-runtime-foundation.md`

### Phase 2：Dashboard Operations

状态：已完成，已合入 `main`。

- retry / stop / archive API。
- operator action events。
- dashboard 按状态展示可用操作。
- focused E2E 覆盖 retry 和 stop。

补充设计：

- `docs/superpowers/specs/2026-05-15-issuepilot-v2-phase2-dashboard-operations-design.md`

实施计划：

- `docs/superpowers/plans/2026-05-15-issuepilot-v2-dashboard-operations.md`

### Phase 3：CI 回流

状态：已完成，已合入 `main`。

- GitLab pipeline lookup。
- CI status event。
- failed pipeline -> `ai-rework` 策略。
- dashboard 显示 CI 状态。

补充设计：

- `docs/superpowers/specs/2026-05-16-issuepilot-v2-phase3-ci-feedback-design.md`

实施计划：

- `docs/superpowers/plans/2026-05-15-issuepilot-v2-ci-feedback.md`

### Phase 4：Review Feedback Sweep

状态：已完成。

- MR discussion cursor。
- feedback summary event。
- `ai-rework` prompt 注入。
- dashboard 展示 feedback 摘要。

补充设计：

- `docs/superpowers/specs/2026-05-16-issuepilot-v2-phase4-review-feedback-sweep-design.md`

实施计划：

- `docs/superpowers/plans/2026-05-15-issuepilot-v2-review-feedback-sweep.md`

### Phase 5：Workspace Retention

状态：已完成。

- `RetentionConfig` 进入 `@issuepilot/shared-contracts`，`retention.successful_run_days` /
  `retention.failed_run_days` / `retention.max_workspace_gb` /
  `retention.cleanup_interval_ms` 同时被 V1 workflow 和 V2 team config 解析。
- 纯函数 planner `packages/workspace/src/retention.ts`：active run 永不删除、
  successful 7 天、failed/blocked 30 天、超容量只清已过期 terminal run、
  失败现场 marker 默认保留。
- executor `apps/orchestrator/src/maintenance/workspace-cleanup.ts`：plan →
  rm → 事件审计三段式，单条失败 fail-soft，emit
  `workspace_cleanup_planned` / `workspace_cleanup_completed` / `workspace_cleanup_failed`。
- V1 单项目入口（`issuepilot run --workflow ...`）按 `cleanup_interval_ms`
  自动跑 cleanup；dashboard service header 展示 `workspace usage GB` 与
  `next cleanup ETA`。
- CLI `issuepilot doctor --workspace --workflow <path>` 提供 dry-run 预览。
- Runbook：`docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md`，
  覆盖准备清理 vs 强制清理决策、`workspace_cleanup_failed` 诊断、误删 rollback。

后续 follow-up（不阻塞 V2 主体）：

- V2 team daemon 启动时打 warn 提示 `retention` 节被解析但 cleanup loop
  未自动启动；多项目场景下需要在 V1 入口逐 workflow 启用 cleanup，或等待
  team-mode wiring 后续 release。
- 远端 GitLab `ai/*` 分支清理仍归后续 release 管理任务，本 Phase 不做。

补充设计：

- `docs/superpowers/specs/2026-05-16-issuepilot-v2-phase5-workspace-retention-design.md`

实施计划：

- `docs/superpowers/plans/2026-05-15-issuepilot-v2-workspace-retention.md`

## 17. 完成标准

V2 完成时应满足：

1. 一个 daemon 可以加载两个以上项目并稳定 poll。
2. 并发 2 的 fake E2E 稳定通过，没有重复 claim 同一 issue。
3. dashboard 能按 project 查看 runs，并执行 retry / stop / archive。
4. CI failed 可以按配置回流到 `ai-rework`。
5. review comments 可以被 sweep，并进入下一轮 agent prompt。
6. workspace cleanup 按 retention policy 执行，失败现场默认保留。
7. 所有新增 API 和 event type 进入 `@issuepilot/shared-contracts`。
8. V1 单项目入口继续通过 release checks。
9. team-mode 真实 smoke runbook 有固定 evidence 模板。
