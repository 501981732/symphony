# IssuePilot V2 Phase 2 — Dashboard Operations 补充设计

日期：2026-05-15
状态：已落地
关联文档：

- `docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`（V2 总 spec，本补充覆盖其 §8 实现层）
- `docs/superpowers/plans/2026-05-15-issuepilot-v2-dashboard-operations.md`（已有 Phase 2 实施计划，本补充扩展其范围）
- `docs/superpowers/specs/2026-05-11-issuepilot-design.md`（IssuePilot 总设计 spec，Codex app-server 协议）

## 1. 背景

V2 Phase 1（团队运行时底座）已经合入 main。当前 dashboard 仍是只读：operator 看到 run 失败、卡死或不再需要时，只能改 GitLab labels 或等 daemon 自然 timeout。Phase 2 按 V2 总 spec §8 给 dashboard 加上 `retry` / `stop` / `archive` 三件套和 audit-log 化的 operator action 事件。

原 Phase 2 plan（`docs/superpowers/plans/2026-05-15-issuepilot-v2-dashboard-operations.md`）已经覆盖了大部分契约和文件结构，**本补充 spec 不重写它**，只锁定两个原 plan 没有完整解决的设计决策：

1. **真正的 runner cancel 通路**。原 plan 任务 4 把 `runnerCancel` 占位为 `() => Promise.reject(new Error("not_implemented"))`，意味着 stop 按钮点完后只能等 `turnTimeoutMs` 收敛，违背 V2 §8「优先取消 Codex turn」的契约。本补充用 Codex app-server 上游协议的 `turn/interrupt` request 把它做成真正的 cancel。
2. **operator 身份方案**。原 plan 任务 5 在 dashboard client 读 `NEXT_PUBLIC_OPERATOR_DISPLAY_NAME ?? "operator"`，本补充收敛到「server 默认 `"system"`，client 不主动设置 header，audit 事件统一记 `system`」，与 V3 真正接入登录态时再切换的演进路径不冲突。

其他设计点（HTTP 路由、events、archivedAt 字段、dashboard 按钮组件、e2e）仍以原 plan 为准，本补充只对相关模块做小量 diff 标注。

## 2. 目标

Phase 2 完成时应满足：

1. dashboard 在 run 状态合法时显示 `Retry` / `Stop` / `Archive` 按钮，点击发起 orchestrator 受控操作。
2. `Stop` 按钮发起后，daemon 通过 Codex app-server `turn/interrupt` 请求中断当前 turn；request 在 ≤5s 内成功 resolve 时表示 cancel 信号已被 Codex 受理，turn 后续以 `turn/completed { status: "interrupted" }` notification 收敛并走现有 cancelled 完成路径（latency 由 Codex 决定，不在 stopRun 控制范围）；request 超时或被 reject 时按 V2 §8「best-effort」标 run 为 `stopping` 并依赖 `turnTimeoutMs` 兜底收敛。
3. 三个操作都写入 `operator_action_requested` / `operator_action_succeeded` / `operator_action_failed` 事件，事件包含 `runId`、`action`、`operator`、`createdAt`、`code`/`transitions`/`message` 字段。
4. archived run 默认在 `/api/runs` 和 dashboard 列表中隐藏，`?includeArchived=true` 和 dashboard `Show archived` toggle 可恢复显示。
5. V1（单 workflow）daemon 装配 operator actions；V2 team daemon 在 Phase 2 暂不装配，因为 Phase 1 只有 claim foundation，没有真实 runAgent dispatch。V2 team mode 下三个路由返回 HTTP 503 `actions_unavailable`，等 V2 dispatch 落地后再补装配。
6. focused e2e：retry action path（failed → claimed / `ai-rework` label）和 stop（running → `turn/interrupt` → cancelled → failed）至少各一条稳定通过。retry 后重新 dispatch 的完整闭环仍是后续 follow-up。

## 3. 非目标

Phase 2 不做：

- RBAC、多用户身份、登录态（V3 范围）。
- 批量 retry / 批量 archive。
- runner 进程级 SIGKILL 兜底。`turn/interrupt` 失败时仅标 `stopping`，依赖 `turnTimeoutMs`；如果未来发现 Codex 不响应 interrupt 的概率很高，再单独做 SIGKILL fallback。
- CI 回流（Phase 3）、review sweep（Phase 4）、workspace cleanup（Phase 5）。
- 操作前的二次确认弹窗。dashboard 按钮直接发请求；audit log 是事后审计手段。
- 历史 `system` 操作的反向归因。本期 audit log 只记当前操作者字符串。

## 4. 架构

新增组件：

- `apps/orchestrator/src/operations/actions.ts` — 三个 pure-ish service 函数 `retryRun` / `stopRun` / `archiveRun`，输入 `{ runId, operator }`，输出 `OperatorActionResult`。
- `apps/orchestrator/src/runtime/run-cancel-registry.ts` — 内存型 `runId → cancel()` 映射，daemon 在 `runAgent` 路径里 register/unregister。
- `packages/runner-codex-app-server/src/lifecycle.ts` 扩展 — `DriveInput` 增加可选 `onTurnActive(cancel)` 钩子，每个活跃 turn 把 `turn/interrupt` 闭包暴露给 caller。

复用组件：

- `RuntimeState`、`EventBus`、`LeaseStore`、`GitLabAdapter`、Fastify `createServer`。
- 现有的 dispatch 收敛路径：runner 返回 `cancelled` outcome 时已经走 `failed` state + lease release + GitLab 完成 note 的逻辑。

控制原则：

- dashboard 永远不直接写 GitLab labels 或 RuntimeState。所有写操作通过 orchestrator action service。
- action service 内部统一三段式：`emit operator_action_requested` → 状态校验 + 副作用 → `emit operator_action_succeeded` 或 `emit operator_action_failed` + 回滚已写入的 state。
- `stopRun` 不绕开现有 dispatch 状态机。它只发 cancel 信号；run 走 cancelled 收敛由现有 dispatch 路径完成，避免双写 state 和 labels 引入竞态。

## 5. Cancel 机制详设

### 5.1 Codex app-server `turn/interrupt` 协议

Codex app-server 暴露的 JSON-RPC 方法：

```json
{ "method": "turn/interrupt", "id": 31, "params": { "threadId": "thr_123", "turnId": "turn_456" } }
{ "id": 31, "result": {} }
// server 后续 emit:
{ "method": "turn/completed", "params": { "turn": { "id": "turn_456", "status": "interrupted", ... } } }
```

成功 response 是空对象；turn 后续以 `turn/completed` notification 收敛，`turn.status === "interrupted"`。这与现有 `notificationOutcome()` 内的 `turn/cancelled` 处理路径**不同**——Codex 用 `turn/completed` + status 字段表达 interrupt，需要新增分支。

### 5.2 runner 包扩展

`packages/runner-codex-app-server/src/lifecycle.ts` 修改：

```ts
export interface DriveInput {
  // 已有字段不变
  onTurnActive?: (cancel: () => Promise<void>) => void;
}
```

每个 `turn/start` 拿到 `turnId` 后立刻构造 cancel 闭包并调用 `onTurnActive(cancel)`：

```ts
const cancelTurn = async (): Promise<void> => {
  if (turnSettled) return;
  await rpc.request("turn/interrupt", { threadId, turnId });
};
input.onTurnActive?.(cancelTurn);
```

turn 收敛（任意 outcome）后置 `turnSettled = true`，cancel 闭包变 noop。

`notificationOutcome()` 增加对 `turn/completed` with `status: "interrupted"` 的识别，归类为 `kind: "cancelled"`，复用现有 cancelled outcome 路径。

### 5.3 orchestrator cancel registry

`apps/orchestrator/src/runtime/run-cancel-registry.ts` 新增：

```ts
export interface RunCancelRegistry {
  register(runId: string, cancel: () => Promise<void>): void;
  cancel(runId: string, opts?: { timeoutMs?: number }): Promise<RunCancelResult>;
  unregister(runId: string): void;
  has(runId: string): boolean;
}

export interface RunCancelResult {
  ok: boolean;
  reason?: "not_registered" | "cancel_threw" | "cancel_timeout";
  message?: string;
}
```

实现要求：

- 内存 `Map<string, () => Promise<void>>`，单 daemon 进程作用域。
- `cancel(runId, { timeoutMs = 5000 })`：调用闭包并用 `Promise.race` 包裹 timeout。闭包 reject 时返回 `{ ok: false, reason: "cancel_threw", message }`；timeout 时返回 `{ ok: false, reason: "cancel_timeout" }`；闭包成功 resolve 返回 `{ ok: true }`。
- daemon 拿到 cancel 成功 result 后**不**立刻改 state——它只表示 cancel 信号已被 Codex 受理，后续 turn 收敛由 dispatch 完成。
- `register/unregister` 必须配对调用；`runAgent` 用 try/finally 保证 unregister。

### 5.4 daemon 装配

`apps/orchestrator/src/daemon.ts` 新建 `runCancelRegistry = createRunCancelRegistry()`，并：

1. 把 registry 传入 `OperatorActionDeps`。
2. 在 `runAgent` 内部把 `onTurnActive: (cancel) => registry.register(runId, cancel)` 传给 `driveLifecycle`，并在 finally 里 `registry.unregister(runId)`。

`apps/orchestrator/src/team/daemon.ts` 在 Phase 2 明确不传 `operatorActions`。server 层在缺少 `operatorActions` 时返回 HTTP 503 `{ ok: false, code: "actions_unavailable" }`，让 dashboard 操作有明确失败语义，而不是隐藏按钮或暴露黑盒 5xx。V2 dispatch/runAgent 落地后再复用同一 registry 抽象补装配。

**对 dispatch 路径的假设**：本 spec 假定 `apps/orchestrator/src/daemon.ts` 的 dispatch 收敛逻辑已经处理 `driveLifecycle` 返回 `cancelled` outcome 的情况（release lease、写 GitLab failure/stop note、transition labels 到 `failedLabel`、state.status 转 `failed`）。writing-plans 阶段必须先 grep `runAgent` 返回值消费路径验证这一条；如果 dispatch 当前只识别 `failed` / `completed` / `blocked` 三种 outcome，plan 需要在新增任务里把 `cancelled` 分支补上，并新增对应单测，再进入 actions service 实现。

### 5.5 stopRun 决策树

```text
stopRun(runId, operator):
  emit operator_action_requested
  run = state.get(runId)
  if !run: return { ok: false, code: "not_found" }; emit operator_action_failed
  if run.status !== "running": return { ok: false, code: "invalid_status" }; emit operator_action_failed
  result = await runCancelRegistry.cancel(runId, { timeoutMs: 5000 })
  if result.ok:
    emit operator_action_succeeded { transitions: ["interrupt_sent"] }
    // run 自然收敛由 dispatch 完成
    return { ok: true }
  else:
    state.setRun({ ...run, status: "stopping" })
    emit operator_action_failed { code: "cancel_failed", message: result.reason }
    // 依赖 turnTimeoutMs 兜底；UI 显示 stopping... 提示
    return { ok: false, code: "cancel_failed" }
```

关键不变量：

- `stopRun` 永不直接调用 `gitlab.transitionLabels` 或 `gitlab.createIssueNote`。所有 GitLab side effect 由现有 dispatch 完成路径处理（已覆盖 cancelled outcome）。
- `stopping` 是 dashboard 可读的中间态，不进入 lease store 或 GitLab labels。turn timeout 后 run 走 failed 时自动覆写。

## 6. Operator 身份

- HTTP route 读 `x-issuepilot-operator` header。缺失时使用字符串字面量 `"system"`。
- dashboard client（`apps/dashboard/lib/api.ts`）**不**主动设置 operator header。原 plan 任务 5 的「读 `NEXT_PUBLIC_OPERATOR_DISPLAY_NAME`」逻辑删除。
- audit 事件的 `operator` 字段是 server-side 解析后的最终字符串，外部 caller（CLI、未来 SSO）可以通过 header 覆盖。
- 这条策略让 V3 接入登录态时只需在 dashboard client 加一行 header；server 协议向前兼容。

## 7. 状态机

| Action | 前置状态 | 中间状态 | 终态 | 副作用 |
|--------|---------|----------|------|--------|
| retry | `failed` / `blocked` / `rework` | — | 同 issue 新 attempt 进 `claimed`，`attempt + 1` | lease release（旧 run）→ GitLab `transitionLabels(reworkLabel)` → 下一轮 poll 重新 claim |
| stop | `running` | `stopping`（仅 cancel 失败时） | `failed`（由 dispatch 收敛） | `runCancelRegistry.cancel(runId)` → 等 `turn/completed { status: "interrupted" }` → dispatch 走 cancelled 路径 |
| archive | `failed` / `blocked` / `completed` | — | 同前 + `archivedAt` 字段 | state-only，不动 GitLab；`/api/runs` 默认隐藏 |

非法转换：返回 `{ ok: false, code: "invalid_status" }` + HTTP 409。

## 8. 数据与契约扩展

新增 / 扩展（沿用原 plan 任务 1 的范围）：

- `packages/shared-contracts/src/events.ts`：`EVENT_TYPE_VALUES` 追加 `operator_action_requested` / `operator_action_succeeded` / `operator_action_failed`。
- `packages/shared-contracts/src/run.ts`：`RunRecord` 增加可选 `archivedAt: string`（ISO-8601）。
- `packages/shared-contracts/src/events.ts`：可选增加 `OperatorActionEventDetail` 类型，描述 `action: "retry" | "stop" | "archive"` + `operator: string` + 选填 `code`/`transitions`/`message`。本节作为 V2 §12 的实现兑现。

HTTP API：

- `POST /api/runs/:runId/retry`
- `POST /api/runs/:runId/stop`
- `POST /api/runs/:runId/archive`

请求 header 可选 `x-issuepilot-operator: <name>`。Response：
- 200 `{ ok: true }` 成功
- 404 `{ ok: false, code: "not_found" }`
- 409 `{ ok: false, code: "invalid_status" }`
- 409 `{ ok: false, code: "cancel_failed", reason: "cancel_timeout" | "cancel_threw" | "not_registered" }`
- 500 `{ ok: false, code: "internal_error" }`

`GET /api/runs` 默认隐藏 `archivedAt != null`；`?includeArchived=true` 返回全量。

## 9. 错误处理（V2 §13 对齐）

- `operator_action_failed.code`: `invalid_status` / `not_found` / `cancel_failed` / `gitlab_failed` / `internal_error`。
- retry / archive 涉及 state 写入时，GitLab 调用失败的回滚顺序：
  1. 撤销 state 改动（恢复 `archivedAt` 或 attempt 计数）。
  2. emit `operator_action_failed`。
  3. 返回 HTTP 500 + `code: "gitlab_failed"` + `reason` redact 后的错误描述。
- stop 不直接写 state（除 `stopping` 中间态），无回滚分支。
- runner cancel 抛错的 redact：error message 经过现有 `redactSecrets` 过滤后写入 event detail。

## 10. 测试策略

单元测试新增（独立于 plan 任务 2 已声明的覆盖）：

1. `run-cancel-registry.test.ts`：
   - register/cancel/unregister 配对。
   - 多 runId 并发 register 不互相覆盖。
   - cancel 闭包 timeout（5s）返回 `cancel_timeout`。
   - cancel 闭包 reject 返回 `cancel_threw`。
   - cancel 未注册的 runId 返回 `not_registered`。
2. `runner-codex-app-server/src/__tests__/cancel.test.ts`：
   - `onTurnActive` 在 turn/start 后被调用，参数是可调用的 async 函数。
   - 调用 cancel 闭包后 rpc 收到 `turn/interrupt` 请求，params 是当前 `{ threadId, turnId }`。
   - turn 收敛后 cancel 闭包变 noop（重复调用不再发 rpc 请求）。
   - `turn/completed` with `status: "interrupted"` 被识别为 `cancelled` outcome。
3. `operations/actions.test.ts`（覆盖原 plan 任务 2 + 本补充新增的 cancel 路径）：
   - `stopRun`：cancel 成功 → state 不变 → emit succeeded。
   - `stopRun`：cancel timeout → state 标 `stopping` → emit failed `cancel_failed`。
   - `stopRun`：cancel 闭包 reject → state 标 `stopping` → emit failed `cancel_failed`。
   - `stopRun`：run 不在 running 状态 → 不触碰 registry → emit failed `invalid_status`。

E2E（原 plan 任务 7）相对原 plan 的增量：

- B 场景（stop）必须断言 fake codex 收到 `turn/interrupt` 请求且 turn 以 `interrupted` 收敛，而非依赖 turnTimeout。fake codex script 增加 expect-interrupt step。
- 新增 C 场景：seed running run → POST stop → fake codex **不响应** `turn/interrupt` → daemon 5s timeout → state 标 `stopping`，dashboard 可读，`turnTimeoutMs` 后 run 真正 failed。

## 11. 与原 Phase 2 plan 的 diff

执行 writing-plans 时按下面的 diff 更新原 plan（`docs/superpowers/plans/2026-05-15-issuepilot-v2-dashboard-operations.md`）：

- **任务 2（actions service）**：扩展 deps 引入 `runCancelRegistry`，替换原 `runnerCancel: (runId) => Promise<void>` 占位。stopRun 调用 registry 而非直调 cancel 函数。
- **任务 4（daemon 装配）**：V1 daemon 新增「构造 `runCancelRegistry`、在 runAgent 路径里 register/unregister、注入到 operatorActions」三步。V2 team daemon 暂不装配 operatorActions，server 返回 `actions_unavailable`。删除原 plan 中 `runnerCancel: () => Promise.reject("not_implemented")` 占位。
- **任务 5（dashboard client）**：删除 `NEXT_PUBLIC_OPERATOR_DISPLAY_NAME` 读取，dashboard client 不再 attach `X-IssuePilot-Operator` header。
- **新增任务 X（runner cancel API）**：在原 plan 任务 1（contracts）和任务 2（actions）之间插入「runner-codex-app-server 增加 `onTurnActive` + `turn/interrupt` 处理 + `turn/completed { status: "interrupted" }` 识别」。包含 runner 包单元测试。
- **新增任务 Y（run-cancel-registry）**：紧跟新任务 X 之后，实现 `apps/orchestrator/src/runtime/run-cancel-registry.ts` + 单元测试。
- **任务 7（e2e）**：B 场景断言 `turn/interrupt` 真实发出 + interrupted 收敛；新增 C 场景覆盖 cancel timeout 路径。
- **任务 8（文档）**：CHANGELOG 在原 plan 描述的基础上加上 runner cancel API、`turn/interrupt`、cancel registry、`stopping` 中间态四项。

## 12. 兼容性

- V1 单 workflow daemon 装配 actions + cancel registry；V2 team daemon 暂不装配 operatorActions，三个路由返回 `actions_unavailable`。
- 旧 RunRecord 无 `archivedAt` 时按未 archived 处理。
- 三个新事件类型对老 dashboard 客户端是 forward-compat（未知事件按 unknown 显示，不破坏渲染）。
- Codex app-server 的 `turn/interrupt` 协议未变，本次实现是对协议的 strict consumer，未来 Codex 协议演进时只需更新 runner 包。
- Phase 1 lease store 行为不变。stop 路径释放 lease 由现有 cancelled 收敛完成；retry 路径单独释放旧 lease（已在原 plan 任务 2 覆盖）。

## 13. 完成标准

Phase 2 完成时应满足：

1. `POST /api/runs/:runId/{retry|stop|archive}` 三个路由在 V1 daemon 下可用；V2 team daemon 下返回 HTTP 503 `actions_unavailable`。
2. dashboard 按 run 状态显示对应按钮；`Show archived` toggle 工作。
3. stop 按钮在 fake codex 响应 `turn/interrupt` request 时让 cancel 信号在 ≤5s 内被受理（HTTP 返回 200），fake codex 随后 emit `turn/completed { status: "interrupted" }` 让 run 在 dispatch 收敛路径下走入 `failed`；fake codex 不响应 interrupt request 时 HTTP 返回 409 `cancel_failed`，run 标 `stopping`，最终由 `turnTimeoutMs` 兜底进入 `failed`。
4. 三个 operator action 事件都进入 event store，可在 dashboard timeline 查看。
5. 单元测试 + 焦点 e2e（retry / stop / stop-timeout）全部通过。
6. `pnpm lint` / `pnpm typecheck` / `pnpm test` 全绿，含 unit + smoke + e2e。
7. CHANGELOG、README、原 Phase 2 plan 都已同步更新。
