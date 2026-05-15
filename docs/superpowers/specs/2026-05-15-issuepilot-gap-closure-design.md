# IssuePilot P0 Gap / 收口设计

日期：2026-05-15
状态：待用户评审
关联文档：

- `SPEC.md`
- `docs/superpowers/specs/2026-05-11-issuepilot-design.md`
- `docs/superpowers/specs/2026-05-14-issue-note-handoff-design.md`
- `docs/superpowers/specs/2026-05-14-human-review-closure-design.md`

## 1. 背景

当前仓库同时承载两层规格：

1. 根目录 `SPEC.md`：开源 Symphony Service Specification，定义语言无关、Linear-compatible 的调度器规范。
2. IssuePilot 设计规格：公司内部 GitLab-first、TypeScript-first、Codex app-server-first 的产品规格。

IssuePilot 不是 `SPEC.md` 的逐字实现。它继承的是服务边界和运行原则：

- repo-owned workflow contract
- 每个 issue 一个隔离 workspace
- orchestrator 独占调度状态
- Codex app-server 生命周期
- tracker/filesystem 驱动的恢复
- 可观测、可重试、可人工接手

它有意替换的是：

- Linear tracker -> GitLab Issue + label 状态机
- tracker state -> GitLab label
- agent 自行完成 ticket 写操作 -> agent tool + orchestrator deterministic reconciliation
- 纯调度器参考实现 -> 本地 P0 产品闭环

Workflow 文件名不应作为产品分叉点。根 `SPEC.md` 使用 `WORKFLOW.md` 作为 repo-owned
contract，IssuePilot 应尽量保持这个默认入口一致；`.agents/workflow.md` 可以作为显式
`--workflow` 路径或迁移期兼容路径，而不是新的规范默认。

因此本 spec 的目标不是把 IssuePilot 拉回 Symphony 原始实现，而是把差距分成三类：

1. **有意分叉**：不用补，只需要在文档中解释清楚。
2. **P0 收口 Gap**：当前实现或文档还没有完全闭合，应该在 P0 完成前解决。
3. **V2+ Gap**：根 `SPEC.md` 或路线图中合理，但不属于 P0。

## 2. 当前实现基线

截至本 spec，仓库已经具备这些 P0 能力：

- TypeScript monorepo、pnpm workspace、Turborepo、Vitest、ESLint、Prettier。
- `apps/orchestrator`：CLI、daemon、Fastify API、SSE、claim、dispatch、retry、reconcile、human-review closure。
- `apps/dashboard`：只读 Next.js dashboard，overview、run detail、timeline、tool calls、log tail。
- `packages/workflow`：workflow markdown 解析、校验、默认值、hot reload、prompt render。
- `packages/tracker-gitlab`：GitLab issue、labels、notes、MR、pipeline adapter。
- `packages/workspace`：bare mirror、git worktree、branch/path safety、hooks。
- `packages/runner-codex-app-server`：JSON-RPC stdio client、thread/turn lifecycle、dynamic GitLab tools。
- `packages/credentials`：GitLab OAuth Device Flow、本地 credential store、refresh。
- `packages/observability`：event bus、event store、run store、logger、redaction。
- fake GitLab + fake Codex E2E，覆盖 happy path、failure、blocked、retry、approval、human-review closure。
- real GitLab smoke runbook 和 `pnpm smoke` wrapper。

这个基线说明 P0 已经从 skeleton 进入收口阶段。后续重点不是新增大功能，而是统一入口、边界、事件契约、真实运行验证和发布路径。

## 3. 根 `SPEC.md` 对 IssuePilot 的差距分类

### 3.1 有意分叉，不作为 Gap

这些差异来自产品方向变化，不应按缺陷处理：

| `SPEC.md` | IssuePilot | 处理 |
| --- | --- | --- |
| `tracker.kind: linear`、Linear GraphQL | `tracker.kind: gitlab`、GitLab REST / GitBeaker | 有意替换 |
| tracker state 驱动：`Todo` / `In Progress` / terminal states | GitLab labels：`ai-ready` / `ai-running` / `human-review` / `ai-rework` / `ai-failed` / `ai-blocked` | 有意替换 |
| workspace 可仅由 hooks population | P0 固定使用 bare mirror + git worktree | IssuePilot 产品要求，不回退 |
| ticket writes 主要交给 agent tools | orchestrator 兜底 push / MR / note / label reconciliation | IssuePilot 可靠性交付需要 |
| optional status surface | P0 明确提供 read-only dashboard | IssuePilot 产品化要求 |
| `linear_graphql` optional tool | GitLab dynamic tool allowlist | 有意替换 |
| 不规定具体 UI | Next.js + Tailwind/shadcn | 已确认技术选型 |

### 3.2 P0 应补 Gap

这些差距会影响 P0 是否能作为稳定本地闭环试运行。

#### Gap P0-1：启动入口和 dashboard 形态不一致

主设计写明 `issuepilot run --workflow ... --port 4738` 启动 orchestrator loop、本地 API server 和 Next.js dashboard。当前实现中 `issuepilot run` 启动 daemon/API，dashboard 仍通过 `pnpm dev:dashboard` 单独启动；`pnpm smoke` 只打印 dashboard URL，不负责启动 dashboard。

影响：

- README、主设计和真实体验不完全一致。
- 新用户以为一个命令能看到 dashboard，实际还需要第二个进程。
- smoke runbook 的“API ready”和“dashboard ready”是两个概念。

收口方案：

1. P0 明确选择一种产品形态：
   - 推荐：`issuepilot run` 只承诺 daemon/API；dashboard 作为独立 Next.js app，由 `pnpm dev:dashboard` 或未来 package 启动。
   - 如果坚持一命令启动 dashboard，则需要 daemon 管理 Next.js child process、端口、退出信号和日志转发。
2. 更新 `2026-05-11-issuepilot-design.md`、README、getting-started、smoke runbook，使入口描述一致。
3. 若采用独立 dashboard，在 CLI ready banner 中明确 API URL 和 dashboard 需单独启动。

推荐先采用“daemon/API 与 dashboard 分进程”作为 P0 收口，因为它最贴合当前实现，风险更低。

#### Gap P0-2：workflow 文件名需要和根 `SPEC.md` 收敛

根 `SPEC.md` 将 `WORKFLOW.md` 定义为 repo-owned workflow contract。IssuePilot 当前文档和示例大量使用 `.agents/workflow.md`，这会让外部用户误以为 IssuePilot 不兼容开源 spec 的 workflow 入口。

影响：

- 开源 `SPEC.md` 和 IssuePilot README/getting-started 的默认文件名不一致。
- 目标仓库需要理解两套入口约定。
- 后续如果要把 IssuePilot 的 GitLab 扩展反馈到开源 spec，文件名差异会制造不必要的迁移成本。

收口方案：

1. P0 默认约定改为仓库根 `WORKFLOW.md`。
2. CLI 继续保留 `--workflow <path>`，所以 `.agents/workflow.md` 仍可作为显式路径使用。
3. 为迁移期定义兼容查找顺序：
   - 显式 `--workflow` 优先。
   - 未显式指定时优先 `./WORKFLOW.md`。
   - 若没有 `WORKFLOW.md`，可在 P0 兼容读取 `./.agents/workflow.md`，但输出 deprecation warning。
4. 更新主设计、README、README.zh-CN、getting-started 和 smoke runbook 的默认示例。

推荐保持 `WORKFLOW.md` 为唯一长期默认；`.agents/workflow.md` 只保留为兼容路径，未来版本可移除默认探测。

#### Gap P0-3：事件契约还没有完全收窄到 shared contracts

主设计要求 event type 使用 `@issuepilot/shared-contracts` 的字面量联合，事件结构包含稳定字段。当前 daemon 内部仍大量使用 `{ type: string, ts, detail }`，Codex events 也以 `detail: { data }` 包裹原始 payload。

影响：

- dashboard 只能防御式解析，难以稳定展示 MR、token、thread、turn、tool calls。
- fake E2E 能覆盖事件是否出现，但不完全证明事件 schema 可长期兼容。
- 后续 V2 dashboard 操作、报告生成、CI 回流会依赖更稳定的事件合同。

收口方案：

1. 在 `shared-contracts/src/events.ts` 中维护 P0 event type 和 payload shape。
2. daemon publish 层负责把内部事件归一化为 shared event。
3. Codex event 需要提升常用字段：`threadId`、`turnId`、`toolName`、`callId`、`tokenUsage`、`message`，原始 payload 可作为 redacted `raw` 附带。
4. dashboard 只消费 shared contract，不直接假设 runner 原始 payload。

#### Gap P0-4：Codex user-input-required 行为和 IssuePilot 主设计存在语义偏差

主设计写明 P0 对 app-server 请求用户输入时自动回复：

```text
This is a non-interactive IssuePilot run. Operator input is unavailable. If blocked, record the blocker and mark the issue ai-blocked.
```

当前 runner 遇到 `item/tool/requestUserInput` 直接抛错，保证不会卡住，但没有把这段提示回给 app-server。

影响：

- 当前行为满足“不无限等待”，但不满足“让 agent 有机会记录 blocker”的产品语义。
- 可能把本应 `ai-blocked` 的场景分类成普通 failure。

收口方案：

1. 优先按照实际 app-server 协议返回一个失败/文本响应，而不是直接 throw。
2. 同时发出 `turn_input_required` 事件。
3. 若协议无法继续，应在 classify 层把 user-input-required 明确归为 blocked。
4. 补 runner unit test 和 E2E fixture。

#### Gap P0-5：post-run MR 查找/upsert 边界表达不清

主设计要求：branch 已 push 但 MR 已存在时更新 MR；没有 MR 时创建 MR。当前 daemon 传给 `reconcile` 的 `findMergeRequest` 是 `async () => null`，实际行为依赖 GitLab adapter 的 create MR 是否能处理已存在场景。

影响：

- 重试或重复 reconcile 可能在真实 GitLab 上碰到 duplicate MR 或 create conflict。
- 代码读者看不到 spec 中的“create or update”保证。

收口方案：

1. 在 tracker-gitlab adapter 暴露并使用 `findMergeRequest(sourceBranch)` 或复用 `listMergeRequestsBySourceBranch`。
2. `reconcile` 先查找 source branch MR，再 create/update。
3. 针对 existing MR、新建 MR、duplicate conflict fallback 各补测试。

#### Gap P0-6：workflow reload 的动态效果不完整

根 `SPEC.md` 要求 workflow changes re-read and re-apply，对 polling cadence、concurrency、hooks、prompt 等未来行为生效。IssuePilot 当前 loader 支持 reload，但 daemon loop 中 poll interval 使用默认常量，concurrency slots 在启动时创建，server summary 也使用默认 poll interval。

影响：

- 修改 workflow 的 `poll_interval_ms` 或 `max_concurrent_agents` 后，用户可能以为已生效，实际并未完整生效。
- dashboard 显示值可能和最新 workflow 配置漂移。

收口方案：

1. P0 文档明确哪些字段 hot reload，哪些字段 restart required。
2. 对 `promptTemplate`、hooks、labels 等低风险字段保持 hot reload。
3. 对 poll interval / concurrency 选择：
   - P0 实现动态更新；或
   - 明确标记 restart required，并在 reload event/dashboard 中展示。

推荐 P0 先文档化 restart-required 字段，避免为了动态 slots 重构引入新风险。

#### Gap P0-7：workspace cleanup / retention 只有失败保留，没有完整策略

根 `SPEC.md` 包含 terminal workspace cleanup；IssuePilot 主设计 P0 强调失败 workspace 保留。当前 `pruneWorktree` 是 P1 placeholder。

影响：

- 长期本地试运行会积累 worktree 和 mirror 状态。
- terminal issue 或 closed issue 的 workspace 生命周期不明确。

收口方案：

1. P0 保持失败 workspace 永久保留。
2. 成功 closed issue workspace 默认保留，但文档明确手动清理方式。
3. V2 再实现按状态/时间/大小的 cleanup policy。
4. `pruneWorktree` 保持 P1，但 README 不应暗示 P0 自动清理。

#### Gap P0-8：真实 smoke 仍偏人工 runbook，不是可重复 release gate

当前有 fake E2E 和 `pnpm smoke` wrapper。`pnpm smoke` 可以启动 orchestrator 并等待 API ready，但真实 GitLab 验收步骤仍需人工跟 runbook。

影响：

- README 中“real GitLab smoke passing”容易被理解为自动化测试常绿。
- release 前缺少清晰、可复制的真实环境验收记录格式。

收口方案：

1. 保留 P0 人工 smoke，但要求每次 release 填写固定 evidence：issue URL、MR URL、handoff note、closing note、dashboard run URL、命令输出摘要。
2. 将 smoke runbook 中“自动”和“人工检查”明确拆开。
3. V2 再考虑真实 GitLab isolated project 的自动化 smoke。

#### Gap P0-9：release / install / upgrade 路径未闭合

README 已将“公开 package、版本化 release、安装/升级路径”标为进行中。当前根 package 是 private，CLI 主要通过 workspace bin 暴露。

影响：

- 试运行需要从源码仓库启动，不是稳定安装物。
- 多项目/团队试用前，版本和升级策略不明确。

收口方案：

1. P0 内部试运行先定义 source checkout 模式：`git clone` + `pnpm install` + `pnpm build`。
2. 明确 `pnpm exec issuepilot` 是当前推荐入口。
3. V1 release 再决定 npm package、standalone tarball 或 internal registry。

## 4. 根 `SPEC.md` 中暂不补的 V2+ Gap

这些能力重要，但不应进入 P0 收口：

| `SPEC.md` / 路线方向 | IssuePilot 处理 |
| --- | --- |
| per-state concurrency | V2 多项目/多并发调度时再做 |
| startup terminal workspace cleanup | V2 cleanup policy 统一处理 |
| retry queue/session metadata 跨进程持久化 | V3 run history / SQLite / Postgres |
| `/api/v1/refresh` operational trigger | V2 dashboard 操作面再做 |
| token/rate-limit aggregate accounting | V2/V3 observability |
| stall timeout based on event inactivity | P0 可保持 turn timeout；V2 再增强 |
| SSH worker extension | V3 多 worker |
| Docker/Kubernetes sandbox | V3 生产化执行平台 |
| pluggable trackers beyond GitLab | V3 或独立产品线 |
| auto merge policy | V2 可选，但默认仍人工 merge |
| PR/MR review feedback sweep | V2 |
| quality metrics / agent analytics | V4 |

## 5. 推荐 P0 收口顺序

### Phase 1：文档和入口一致性

目标：用户按照 README 能稳定启动，不产生“一条命令包含 dashboard”的误解。

任务：

1. 更新主设计 §5，明确 P0 入口是否包含 dashboard。
2. 更新 README / README.zh-CN / getting-started / smoke runbook。
3. CLI ready banner 与文档一致。

验收：

- 文档中 `issuepilot run`、`pnpm dev:dashboard`、`pnpm smoke` 的职责一致。
- `git diff --check` 通过。

### Phase 2：P0 行为契约收窄

目标：核心运行行为和 spec 语义一致。

任务：

1. MR find/update/create 语义显式化。
2. user-input-required 明确 blocked/failure 行为。
3. workflow reload 可动态字段和 restart-required 字段落文档，并让 dashboard/事件显示真实状态。

验收：

- unit tests 覆盖 existing MR、user input、reload status。
- fake E2E 不回退。

### Phase 3：事件 contract 和 dashboard 数据稳定

目标：dashboard、reports、V2 操作能力可以基于 shared contracts 继续演进。

任务：

1. shared event type/payload 定义补齐。
2. daemon publish 层统一事件 shape。
3. dashboard API 返回结构只依赖 shared contracts。

验收：

- dashboard tests 不依赖 runner raw payload。
- event store 中 P0 关键事件字段稳定。

### Phase 4：真实试运行证据模板和 release boundary

目标：P0 能被内部团队按固定方式试用和验收。

任务：

1. 增加 smoke evidence 模板。
2. 明确 source checkout install path。
3. 标注 npm/package release 为 V1 后续。

验收：

- 一次真实 GitLab smoke 可以按模板记录完整 evidence。
- README 不再把人工 smoke 暗示成自动 release gate。

## 6. 不推荐现在做的事

1. 不建议为了贴合根 `SPEC.md` 回退到 Linear / state-based tracker。那会违背 IssuePilot 已确认产品方向。`WORKFLOW.md` 文件名本身不属于这类产品分叉，应保持一致。
2. 不建议 P0 直接上 dashboard 操作按钮。当前事件 contract 和运行状态边界还没完全稳定，先加操作会扩大风险。
3. 不建议 P0 引入数据库。当前 JSON/JSONL 足够支撑本地闭环；持久化 run history 应与 V3 权限、预算、审计一起设计。
4. 不建议 P0 自动 merge。当前设计明确人类负责 merge 决策，IssuePilot 负责 merged 后收尾。

## 7. Definition of Done

P0 Gap 收口完成标准：

1. 根 `SPEC.md` 与 IssuePilot 的有意分叉在主设计或 README 中解释清楚。
2. P0 入口形态、dashboard 启动方式、smoke wrapper 职责一致。
3. workflow 默认文件名与根 `SPEC.md` 收敛到 `WORKFLOW.md`，`.agents/workflow.md` 仅作为显式路径或迁移兼容路径。
4. post-run reconciliation 对 existing MR 是显式 update，不靠 create side effect。
5. user-input-required 不会卡住，并按文档进入 blocked 或 failed。
6. workflow reload 的动态/需重启字段有明确说明。
7. P0 event contract 由 shared contracts 表达，dashboard 不直接依赖 runner raw payload。
8. workspace retention 策略在 P0 文档中说清楚。
9. 真实 GitLab smoke 有固定 evidence 模板。
10. 文档和测试通过：

```bash
git diff --check
pnpm test
pnpm typecheck
pnpm lint
```

其中 `pnpm test/typecheck/lint` 可按变更范围执行；纯文档变更至少运行 `git diff --check`。

## 8. 后续计划入口

本 spec 通过评审后，应拆出 implementation plan，建议按以下任务分组：

1. `issuepilot-p0-entrypoint-doc-sync`
2. `issuepilot-p0-reconcile-contract-hardening`
3. `issuepilot-p0-event-contract`
4. `issuepilot-p0-smoke-evidence-and-release-boundary`

这四组任务可以分阶段执行。Phase 1 和 Phase 4 主要是文档；Phase 2 和 Phase 3 涉及代码和测试，应该单独提交。
