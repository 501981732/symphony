# IssuePilot V2 Dashboard Operations 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 V1/V2 daemon 加上 dashboard 受控的 `retry` / `stop` / `archive` 三件套，并通过 Codex app-server 的 `turn/interrupt` 协议把 stop 做成真实 cancel。

**Architecture:** 在 orchestrator 中新建 `apps/orchestrator/src/operations/actions.ts` 三个 service 函数，统一通过 Fastify POST 路由对外。runner-codex-app-server 包暴露 `onTurnActive(cancel)` 钩子让 caller 在每个 turn 拿到 cancel 闭包；orchestrator 增加内存型 `run-cancel-registry` 把 runId 映射到 cancel 闭包；stopRun 优先调 `turn/interrupt` 让 Codex 自然收敛，失败时退回 `stopping` 中间态并依赖 turnTimeout 兜底。

**Tech Stack:** TypeScript、Node.js 22、Fastify、Vitest、Next.js App Router、Tailwind、`@issuepilot/shared-contracts`、Codex app-server JSON-RPC `turn/interrupt`。

**前置：** V2 Phase 1（团队运行时底座）已合入 main，lease store / project registry / team daemon shell / project-aware `/api/state` 可用。

**关联 spec：**
- `docs/superpowers/specs/2026-05-15-issuepilot-v2-phase2-dashboard-operations-design.md`（本期补充设计，对真实 cancel 和 operator 身份做出最终决策）
- `docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md` §8 / §12 / §13（V2 总 spec）

---

## 范围检查

本计划覆盖 V2 spec §8「retry / stop / archive 三件套」的完整实现，包括：

- 三个 POST 操作 API。
- runner-codex-app-server 包内 `onTurnActive` 钩子 + `turn/interrupt` 真实 cancel 通路 + `turn/completed { status: "interrupted" }` 识别。
- orchestrator 端 `run-cancel-registry` 内存映射，单 daemon 进程作用域。
- `operator_action_requested` / `operator_action_succeeded` / `operator_action_failed` 三个新事件。
- `RunRecord.archivedAt` 字段 + `stopping` 中间状态。
- archived run 在 `/api/runs` 默认隐藏，`?includeArchived=true` 恢复显示。
- dashboard `RunActions` 按状态渲染 Retry / Stop / Archive；runs-table 加 `Show archived` toggle；detail page header 加按钮。
- focused e2e：retry / stop-interrupt / stop-timeout 三场景。

本计划明确不做：

- CI 状态读取（Phase 3）。
- review feedback sweep（Phase 4）。
- workspace cleanup（Phase 5）。
- RBAC / 多用户身份（V3 范围）。
- runner 进程级 SIGKILL 兜底。
- 操作前的二次确认弹窗。

## 文件结构

**新建文件：**

- `apps/orchestrator/src/runtime/run-cancel-registry.ts`：内存型 `runId → cancel()` 映射。
- `apps/orchestrator/src/runtime/__tests__/run-cancel-registry.test.ts`：覆盖 register/cancel/unregister 配对、并发隔离、timeout/reject/not_registered 分类。
- `apps/orchestrator/src/operations/actions.ts`：`retryRun` / `stopRun` / `archiveRun` 三个 service。
- `apps/orchestrator/src/operations/__tests__/actions.test.ts`：每个动作至少覆盖成功 / 状态非法 / 失败回滚三条路径。
- `apps/dashboard/components/overview/run-actions.tsx`：按 run 状态渲染按钮，useTransition 阻塞二次点击。
- `apps/dashboard/components/overview/run-actions.test.tsx`：覆盖按钮显隐与回调触发。
- `tests/e2e/operator-actions.test.ts`：retry / stop-interrupt / stop-timeout 三场景。

**修改文件：**

- `packages/shared-contracts/src/events.ts`：`EVENT_TYPE_VALUES` 追加三个新事件类型。
- `packages/shared-contracts/src/__tests__/events.test.ts`：覆盖新事件类型。
- `packages/shared-contracts/src/run.ts`：`RUN_STATUS_VALUES` 追加 `stopping`；`RunRecord` 增加 `archivedAt?: string`。
- `packages/shared-contracts/src/__tests__/run.test.ts`：covers `stopping` 和 `archivedAt`。
- `packages/runner-codex-app-server/src/lifecycle.ts`：`DriveInput` 增加 `onTurnActive`；turn 收敛逻辑识别 `turn/completed { status: "interrupted" }` 走 `cancelled` outcome。
- `packages/runner-codex-app-server/src/__tests__/cancel.test.ts`（新）：覆盖 `onTurnActive` 注册、`turn/interrupt` 发出、turn 收敛后 cancel 闭包变 noop、`turn/completed { status: "interrupted" }` 识别。
- `apps/orchestrator/src/server/index.ts`：新增 POST `/api/runs/:runId/{retry|stop|archive}`；`/api/runs` 默认隐藏 archived，支持 `?includeArchived=true`。
- `apps/orchestrator/src/server/__tests__/server.test.ts`：覆盖三个新路由的 200 / 404 / 409 / 500 行为，含 operator header 兜底为 `"system"`、archived 过滤。
- `apps/orchestrator/src/daemon.ts`（V1 单 workflow 模式）：构造 `runCancelRegistry`，注入 `OperatorActionDeps`；`runAgent` 路径里 register/unregister。
- `apps/orchestrator/src/__tests__/daemon.test.ts`：覆盖 `operatorActions` deps 被注入 + cancel registry 在 runAgent 期间 register/unregister。
- `apps/orchestrator/src/team/daemon.ts`（V2 team 模式）：同上。
- `apps/orchestrator/src/team/__tests__/daemon.test.ts`：覆盖 team 模式下的 deps 注入。
- `apps/dashboard/lib/api.ts`：新增 `retryRun` / `stopRun` / `archiveRun` POST 客户端；`fetchRuns` 默认隐藏 archived。
- `apps/dashboard/lib/__tests__/api.test.ts`（或 dashboard 现有的 colocated api.test.ts）：覆盖三个客户端的 200 / 409 / 404 路径。
- `apps/dashboard/components/overview/runs-table.tsx`：新增 `Actions` 列 + `Show archived` toggle。
- `apps/dashboard/components/overview/runs-table.test.tsx`：覆盖 actions 列与 toggle。
- `apps/dashboard/components/detail/run-detail-page.tsx`：header 区域放置 `RunActions`。
- `apps/dashboard/components/detail/run-detail-page.test.tsx`：覆盖 header 按钮。
- `docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`：Phase 2 节末追加 plan 链接（如果尚未追加）。
- `README.md` / `README.zh-CN.md`：V2 列表中的 retry/stop/archive 改成 ✅ shipped。
- `CHANGELOG.md`：新增 Unreleased Added 一条，列出所有新事件 / API / dashboard / e2e。

## 任务 1：扩展共享契约

**Files:**
- Modify: `packages/shared-contracts/src/events.ts`
- Modify: `packages/shared-contracts/src/__tests__/events.test.ts`
- Modify: `packages/shared-contracts/src/run.ts`
- Modify: `packages/shared-contracts/src/__tests__/run.test.ts`

- [ ] **Step 1: 写失败的 events 测试**

在 `packages/shared-contracts/src/__tests__/events.test.ts` 顶部 `REQUIRED_EVENT_TYPES` 数组追加三项：

```ts
  "operator_action_requested",
  "operator_action_succeeded",
  "operator_action_failed",
```

并新增一个独立测试：

```ts
it("isEventType narrows new operator action types", () => {
  expect(isEventType("operator_action_requested")).toBe(true);
  expect(isEventType("operator_action_succeeded")).toBe(true);
  expect(isEventType("operator_action_failed")).toBe(true);
});
```

- [ ] **Step 2: 写失败的 run 测试**

`packages/shared-contracts/src/__tests__/run.test.ts` 现有第一个测试断言「RUN_STATUS_VALUES enumerates exactly the six P0 statuses」，新增 `stopping` 后该 hard-coded 集合会 break，先把它改成包含 `stopping` 的 seven statuses：

```ts
it("RUN_STATUS_VALUES enumerates the seven dashboard-visible statuses", () => {
  expect(new Set(RUN_STATUS_VALUES)).toEqual(
    new Set([
      "claimed",
      "running",
      "retrying",
      "stopping",
      "completed",
      "failed",
      "blocked",
    ]),
  );
});
```

然后在该 `describe` 块末尾追加两个新测试：

```ts
it("accepts stopping run status", () => {
  expect(isRunStatus("stopping")).toBe(true);
});

it("allows RunRecord to carry archivedAt", () => {
  const run: RunRecord = {
    runId: "run-1",
    issue: {
      id: "1",
      iid: 1,
      title: "Fix checkout",
      url: "https://gitlab.example.com/group/web/-/issues/1",
      projectId: "group/web",
      labels: ["ai-failed"],
    },
    status: "failed",
    attempt: 1,
    branch: "ai/1-fix",
    workspacePath: "/tmp/run-1",
    startedAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:01.000Z",
    archivedAt: "2026-05-15T00:01:00.000Z",
  };

  expect(run.archivedAt).toBe("2026-05-15T00:01:00.000Z");
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm --filter @issuepilot/shared-contracts test -- src/__tests__/events.test.ts src/__tests__/run.test.ts
```

期望：失败，错误指向缺失的事件类型 / `stopping` / `archivedAt`。

- [ ] **Step 4: 扩展 events.ts**

在 `EVENT_TYPE_VALUES` 末尾「Human review reconciliation」分组之后新增分组（保持 grep 友好）：

```ts
  // Operator dashboard actions (V2 Phase 2)
  "operator_action_requested",
  "operator_action_succeeded",
  "operator_action_failed",
```

- [ ] **Step 5: 扩展 run.ts**

把 `RUN_STATUS_VALUES` 修改为：

```ts
export const RUN_STATUS_VALUES = [
  "claimed",
  "running",
  "retrying",
  "stopping",
  "completed",
  "failed",
  "blocked",
] as const;
```

在 `RunRecord` 接口末尾增加：

```ts
  /**
   * ISO-8601 timestamp set when an operator archives this run via the
   * dashboard. Archived runs are excluded from `/api/runs` by default;
   * pass `?includeArchived=true` to include them.
   */
  archivedAt?: string;
```

- [ ] **Step 6: 运行 focused 测试**

```bash
pnpm --filter @issuepilot/shared-contracts test
pnpm --filter @issuepilot/shared-contracts typecheck
pnpm --filter @issuepilot/shared-contracts build
```

期望：PASS。`build` 是为了让下游的 declaration 立即可见。

- [ ] **Step 7: 提交**

```bash
git add packages/shared-contracts/src/events.ts packages/shared-contracts/src/run.ts packages/shared-contracts/src/__tests__/events.test.ts packages/shared-contracts/src/__tests__/run.test.ts
git commit -m "feat(contracts): add operator action events and stopping/archived run state"
```

## 任务 2：Runner cancel API

**Files:**
- Modify: `packages/runner-codex-app-server/src/lifecycle.ts`
- Create: `packages/runner-codex-app-server/src/__tests__/cancel.test.ts`
- Modify: `packages/runner-codex-app-server/src/__tests__/lifecycle.test.ts`（如果原 turn outcome 测试需要补 `interrupted` 分支）

- [ ] **Step 1: 写失败的 cancel 测试**

创建 `packages/runner-codex-app-server/src/__tests__/cancel.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";

import { driveLifecycle, type DriveInput, type RpcClient } from "../index.js";

function createFakeRpc(): {
  rpc: RpcClient;
  notificationHandler: (handler: (m: string, p: unknown) => void) => void;
  requestHandler: (
    handler: (m: string, p: unknown) => Promise<unknown> | unknown,
  ) => void;
  requests: Array<{ method: string; params: unknown }>;
} {
  let notifyHandler: (m: string, p: unknown) => void = () => {};
  let reqHandler: (m: string, p: unknown) => Promise<unknown> | unknown = () =>
    ({});
  const requests: Array<{ method: string; params: unknown }> = [];
  const rpc: RpcClient = {
    request: vi.fn(async (method, params) => {
      requests.push({ method, params });
      if (method === "initialize") return { ok: true };
      if (method === "thread/start") return { thread: { id: "thr_abc" } };
      if (method === "turn/start") return { turn: { id: "turn_xyz" } };
      if (method === "turn/interrupt") return {};
      return {};
    }),
    notify: vi.fn(),
    onNotification: (h) => {
      notifyHandler = h;
    },
    onRequest: (h) => {
      reqHandler = h;
    },
    onMalformed: () => {},
    close: vi.fn(async () => {}),
    waitExit: () => Promise.resolve({ code: 0, signal: null }),
  };
  return {
    rpc,
    notificationHandler: (cb) => {
      cb(notifyHandler);
    },
    requestHandler: (cb) => {
      cb(reqHandler);
    },
    requests,
  };
}

function baseInput(rpc: RpcClient): DriveInput {
  return {
    rpc,
    maxTurns: 1,
    prompt: "do the thing",
    title: "issue#1",
    cwd: "/tmp/x",
    threadName: "test",
    sandboxType: "workspace-write",
    approvalPolicy: "never",
    turnSandboxPolicy: { type: "workspaceWrite" },
    turnTimeoutMs: 2000,
    tools: [],
    onEvent: () => {},
  };
}

describe("driveLifecycle cancel API", () => {
  it("invokes onTurnActive with a cancel closure after turn/start", async () => {
    const fake = createFakeRpc();
    const cancels: Array<() => Promise<void>> = [];
    const inputPromise = driveLifecycle({
      ...baseInput(fake.rpc),
      onTurnActive: (cancel) => cancels.push(cancel),
    });
    await new Promise((r) => setImmediate(r));
    expect(cancels).toHaveLength(1);
    expect(typeof cancels[0]).toBe("function");
    // Let the test finish by emitting turn/completed
    fake.notificationHandler((h) =>
      h("turn/completed", { turnId: "turn_xyz", stop: true }),
    );
    await inputPromise;
  });

  it("cancel closure sends turn/interrupt with current threadId/turnId", async () => {
    const fake = createFakeRpc();
    let cancel!: () => Promise<void>;
    const inputPromise = driveLifecycle({
      ...baseInput(fake.rpc),
      onTurnActive: (c) => {
        cancel = c;
      },
    });
    await new Promise((r) => setImmediate(r));
    await cancel();
    const interrupt = fake.requests.find((r) => r.method === "turn/interrupt");
    expect(interrupt).toBeDefined();
    expect(interrupt?.params).toEqual({
      threadId: "thr_abc",
      turnId: "turn_xyz",
    });
    fake.notificationHandler((h) =>
      h("turn/completed", { turnId: "turn_xyz", turn: { status: "interrupted" } }),
    );
    await inputPromise;
  });

  it("cancel closure becomes noop after turn settles", async () => {
    const fake = createFakeRpc();
    let cancel!: () => Promise<void>;
    const inputPromise = driveLifecycle({
      ...baseInput(fake.rpc),
      onTurnActive: (c) => {
        cancel = c;
      },
    });
    await new Promise((r) => setImmediate(r));
    fake.notificationHandler((h) =>
      h("turn/completed", { turnId: "turn_xyz", stop: true }),
    );
    await inputPromise;
    const before = fake.requests.filter((r) => r.method === "turn/interrupt")
      .length;
    await cancel();
    const after = fake.requests.filter((r) => r.method === "turn/interrupt")
      .length;
    expect(after).toBe(before);
  });

  it("turn/completed with status interrupted resolves as cancelled", async () => {
    const fake = createFakeRpc();
    const result = driveLifecycle(baseInput(fake.rpc));
    await new Promise((r) => setImmediate(r));
    fake.notificationHandler((h) =>
      h("turn/completed", {
        turnId: "turn_xyz",
        turn: { id: "turn_xyz", status: "interrupted" },
      }),
    );
    const value = await result;
    expect(value.status).toBe("cancelled");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @issuepilot/runner-codex-app-server test -- src/__tests__/cancel.test.ts
```

期望：失败，因为 `DriveInput.onTurnActive` 尚未定义且 lifecycle 不会发 `turn/interrupt` 也不识别 `interrupted` 状态。

- [ ] **Step 3: 扩展 DriveInput 接口**

在 `packages/runner-codex-app-server/src/lifecycle.ts` 的 `DriveInput` 接口末尾新增：

```ts
  /**
   * Optional hook invoked at the start of each turn. The supplied closure
   * issues a `turn/interrupt` JSON-RPC request bound to the current
   * `(threadId, turnId)`. After the turn settles (any outcome), calling the
   * closure becomes a noop so callers do not need to track turn state.
   */
  onTurnActive?: (cancel: () => Promise<void>) => void;
```

- [ ] **Step 4: 在 driveLifecycle 主循环里构造 cancel 闭包**

在 `driveLifecycle` 主循环中，把 `for` 循环体改为：

```ts
  for (let i = 0; i < input.maxTurns; i++) {
    const turnResult = (await rpc.request("turn/start", {
      threadId,
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      cwd: input.cwd,
      sandboxPolicy: normalizeSandboxPolicy(input.turnSandboxPolicy, input.cwd),
    })) as unknown;

    const turnId = resultTurnId(turnResult);
    lastTurnId = turnId;
    turnsUsed++;
    onEvent("turn_started", { turnId });

    let turnSettled = false;
    const cancelTurn = async (): Promise<void> => {
      if (turnSettled) return;
      await rpc.request("turn/interrupt", { threadId, turnId });
    };
    input.onTurnActive?.(cancelTurn);

    const outcome = await waitForTurn(
      queuedNotifications,
      (consumer) => {
        notificationConsumer = consumer;
      },
      turnId,
      input.turnTimeoutMs,
      onEvent,
    );
    turnSettled = true;

    // existing outcome handling ...
  }
```

`turnSettled` 闭包变量保证 turn 收敛后调用 `cancelTurn()` 立即 return，不再产生 `turn/interrupt` 请求。

- [ ] **Step 5: 让 notificationOutcome 识别 `turn/completed { interrupted }`**

修改 `notificationOutcome` 内的 `turn/completed` 分支：

```ts
  if (method === "turn/completed" && currentTurnId === turnId) {
    onEvent("turn_completed", params);
    const turnStatus = (p?.["turn"] as { status?: unknown } | undefined)?.status;
    if (turnStatus === "interrupted") {
      return { kind: "cancelled" };
    }
    return { kind: "completed", stop: p?.["stop"] !== false };
  }
```

注意：现有 `turn/cancelled` 通知路径（Codex 自身发起的取消）保留，不变。这里只是给 `turn/completed { status: "interrupted" }` 一条专用识别分支。

- [ ] **Step 6: 运行 focused 测试**

```bash
pnpm --filter @issuepilot/runner-codex-app-server test -- src/__tests__/cancel.test.ts
pnpm --filter @issuepilot/runner-codex-app-server test
pnpm --filter @issuepilot/runner-codex-app-server typecheck
```

期望：全部 PASS。如果原 `lifecycle.test.ts` 因为新增 `turnSettled` 变量或 `interrupted` 分支断言出现回归，调整测试（不调整生产逻辑）。

- [ ] **Step 7: 提交**

```bash
git add packages/runner-codex-app-server/src/lifecycle.ts packages/runner-codex-app-server/src/__tests__/cancel.test.ts
git commit -m "feat(runner): expose onTurnActive cancel hook and turn/interrupt"
```

## 任务 3：Run cancel registry

**Files:**
- Create: `apps/orchestrator/src/runtime/run-cancel-registry.ts`
- Create: `apps/orchestrator/src/runtime/__tests__/run-cancel-registry.test.ts`

- [ ] **Step 1: 写失败的 registry 测试**

创建 `apps/orchestrator/src/runtime/__tests__/run-cancel-registry.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";

import { createRunCancelRegistry } from "../run-cancel-registry.js";

describe("createRunCancelRegistry", () => {
  it("returns not_registered for unknown runId", async () => {
    const registry = createRunCancelRegistry();
    const result = await registry.cancel("unknown");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_registered");
  });

  it("invokes the registered cancel and reports ok", async () => {
    const registry = createRunCancelRegistry();
    const cancel = vi.fn(async () => {});
    registry.register("run-1", cancel);
    const result = await registry.cancel("run-1");
    expect(result.ok).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("classifies a thrown cancel as cancel_threw and surfaces the message", async () => {
    const registry = createRunCancelRegistry();
    registry.register("run-2", async () => {
      throw new Error("rpc disconnected");
    });
    const result = await registry.cancel("run-2");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cancel_threw");
    expect(result.message).toContain("rpc disconnected");
  });

  it("classifies a long-running cancel as cancel_timeout", async () => {
    vi.useFakeTimers();
    const registry = createRunCancelRegistry();
    registry.register("run-3", () => new Promise<void>(() => {}));
    const promise = registry.cancel("run-3", { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cancel_timeout");
    vi.useRealTimers();
  });

  it("does not mix up cancels across runIds", async () => {
    const registry = createRunCancelRegistry();
    const cancel1 = vi.fn(async () => {});
    const cancel2 = vi.fn(async () => {});
    registry.register("run-a", cancel1);
    registry.register("run-b", cancel2);
    await registry.cancel("run-a");
    expect(cancel1).toHaveBeenCalled();
    expect(cancel2).not.toHaveBeenCalled();
  });

  it("unregister removes the cancel", async () => {
    const registry = createRunCancelRegistry();
    registry.register("run-1", async () => {});
    registry.unregister("run-1");
    const result = await registry.cancel("run-1");
    expect(result.reason).toBe("not_registered");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/runtime/__tests__/run-cancel-registry.test.ts
```

期望：失败，因为 `apps/orchestrator/src/runtime/run-cancel-registry.ts` 尚不存在。

- [ ] **Step 3: 实现 registry**

创建 `apps/orchestrator/src/runtime/run-cancel-registry.ts`：

```ts
export interface RunCancelResult {
  ok: boolean;
  reason?: "not_registered" | "cancel_threw" | "cancel_timeout";
  message?: string;
}

export interface RunCancelRegistry {
  register(runId: string, cancel: () => Promise<void>): void;
  cancel(runId: string, opts?: { timeoutMs?: number }): Promise<RunCancelResult>;
  unregister(runId: string): void;
  has(runId: string): boolean;
  activeCount(): number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export function createRunCancelRegistry(): RunCancelRegistry {
  const map = new Map<string, () => Promise<void>>();

  return {
    register(runId, cancel) {
      map.set(runId, cancel);
    },
    unregister(runId) {
      map.delete(runId);
    },
    has(runId) {
      return map.has(runId);
    },
    activeCount() {
      return map.size;
    },
    async cancel(runId, opts) {
      const cancelFn = map.get(runId);
      if (!cancelFn) {
        return { ok: false, reason: "not_registered" };
      }

      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<RunCancelResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, reason: "cancel_timeout" }),
          timeoutMs,
        );
      });
      const cancelPromise = (async (): Promise<RunCancelResult> => {
        try {
          await cancelFn();
          return { ok: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, reason: "cancel_threw", message };
        }
      })();

      try {
        return await Promise.race([cancelPromise, timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
```

- [ ] **Step 4: 运行 focused 测试**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/runtime/__tests__/run-cancel-registry.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

期望：PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/orchestrator/src/runtime/run-cancel-registry.ts apps/orchestrator/src/runtime/__tests__/run-cancel-registry.test.ts
git commit -m "feat(runtime): add run cancel registry for operator stop"
```

## 任务 4：Operator action services

**Files:**
- Create: `apps/orchestrator/src/operations/actions.ts`
- Create: `apps/orchestrator/src/operations/__tests__/actions.test.ts`

- [ ] **Step 1: 写失败的 actions 测试**

创建 `apps/orchestrator/src/operations/__tests__/actions.test.ts`，覆盖三个动作的成功 / 状态非法 / 失败回滚路径。**完整代码**：

```ts
import { createEventBus } from "@issuepilot/observability";
import type { IssuePilotInternalEvent } from "@issuepilot/shared-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntimeState } from "../../runtime/state.js";
import { createRunCancelRegistry } from "../../runtime/run-cancel-registry.js";
import { archiveRun, retryRun, stopRun } from "../actions.js";

function seedRun(
  state: ReturnType<typeof createRuntimeState>,
  overrides: Partial<{
    runId: string;
    status: string;
    attempt: number;
    archivedAt: string;
  }> = {},
) {
  const runId = overrides.runId ?? "run-1";
  state.setRun(runId, {
    runId,
    issue: {
      id: "1",
      iid: 1,
      title: "Fix",
      url: "https://gitlab.example.com/g/p/-/issues/1",
      projectId: "g/p",
      labels: ["ai-running"],
    },
    status: overrides.status ?? "running",
    attempt: overrides.attempt ?? 1,
    branch: "ai/1-fix",
    workspacePath: "/tmp/run",
    startedAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:01.000Z",
    ...(overrides.archivedAt ? { archivedAt: overrides.archivedAt } : {}),
  });
  return runId;
}

function createDeps() {
  const events: IssuePilotInternalEvent[] = [];
  const eventBus = createEventBus<IssuePilotInternalEvent>();
  eventBus.subscribe((e) => events.push(e));
  const state = createRuntimeState();
  const leaseStore = {
    release: vi.fn(async () => {}),
  };
  const runCancelRegistry = createRunCancelRegistry();
  const gitlab = {
    transitionLabels: vi.fn(async () => {}),
  };
  const workflow = {
    tracker: {
      runningLabel: "ai-running",
      reworkLabel: "ai-rework",
      failedLabel: "ai-failed",
      blockedLabel: "ai-blocked",
    },
  };
  return {
    deps: {
      state,
      eventBus,
      leaseStore,
      runCancelRegistry,
      gitlab,
      workflow,
      now: () => new Date("2026-05-15T12:00:00.000Z"),
    },
    events,
    leaseStore,
    runCancelRegistry,
    gitlab,
  };
}

describe("retryRun", () => {
  it("transitions a failed run to claimed with attempt+1 and labels ai-rework", async () => {
    const { deps, events, gitlab } = createDeps();
    const runId = seedRun(deps.state, { status: "failed", attempt: 2 });

    const result = await retryRun({ runId, operator: "system" }, deps);

    expect(result.ok).toBe(true);
    expect(gitlab.transitionLabels).toHaveBeenCalledWith(1, {
      add: ["ai-rework"],
      remove: ["ai-running", "ai-failed", "ai-blocked"],
    });
    const run = deps.state.getRun(runId);
    expect(run?.status).toBe("claimed");
    expect(run?.attempt).toBe(3);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "operator_action_requested",
      "operator_action_succeeded",
    ]);
  });

  it("returns invalid_status for a running run", async () => {
    const { deps, events, gitlab } = createDeps();
    const runId = seedRun(deps.state, { status: "running" });

    const result = await retryRun({ runId, operator: "system" }, deps);

    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("invalid_status");
    expect(gitlab.transitionLabels).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe("operator_action_failed");
  });

  it("rolls back state when transitionLabels throws", async () => {
    const { deps, events, gitlab } = createDeps();
    const runId = seedRun(deps.state, { status: "failed", attempt: 1 });
    (gitlab.transitionLabels as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("network down"),
    );

    const result = await retryRun({ runId, operator: "system" }, deps);

    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("gitlab_failed");
    const run = deps.state.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.attempt).toBe(1);
  });
});

describe("stopRun", () => {
  it("returns invalid_status for a non-running run", async () => {
    const { deps, events, runCancelRegistry } = createDeps();
    const cancel = vi.fn(async () => {});
    runCancelRegistry.register("run-1", cancel);
    const runId = seedRun(deps.state, { status: "failed" });

    const result = await stopRun({ runId, operator: "system" }, deps);

    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("invalid_status");
    expect(cancel).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe("operator_action_failed");
  });

  it("invokes cancel and emits succeeded when registry returns ok", async () => {
    const { deps, events, runCancelRegistry } = createDeps();
    const cancel = vi.fn(async () => {});
    runCancelRegistry.register("run-1", cancel);
    const runId = seedRun(deps.state, { status: "running" });

    const result = await stopRun({ runId, operator: "system" }, deps);

    expect(result.ok).toBe(true);
    expect(cancel).toHaveBeenCalled();
    expect(deps.state.getRun(runId)?.status).toBe("running");
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "operator_action_requested",
      "operator_action_succeeded",
    ]);
  });

  it("marks run as stopping when cancel times out", async () => {
    const { deps, events, runCancelRegistry } = createDeps();
    vi.useFakeTimers();
    runCancelRegistry.register("run-1", () => new Promise<void>(() => {}));
    const runId = seedRun(deps.state, { status: "running" });

    const promise = stopRun(
      { runId, operator: "system", cancelTimeoutMs: 50 },
      deps,
    );
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("cancel_failed");
    expect((result as { reason?: string }).reason).toBe("cancel_timeout");
    expect(deps.state.getRun(runId)?.status).toBe("stopping");
    expect(events.at(-1)?.type).toBe("operator_action_failed");
  });

  it("marks run as stopping when cancel throws", async () => {
    const { deps, events, runCancelRegistry } = createDeps();
    runCancelRegistry.register("run-1", async () => {
      throw new Error("rpc closed");
    });
    const runId = seedRun(deps.state, { status: "running" });

    const result = await stopRun({ runId, operator: "system" }, deps);

    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("cancel_threw");
    expect(deps.state.getRun(runId)?.status).toBe("stopping");
    expect(events.at(-1)?.type).toBe("operator_action_failed");
  });

  it("returns not_found when run does not exist", async () => {
    const { deps } = createDeps();

    const result = await stopRun({ runId: "ghost", operator: "system" }, deps);

    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("not_found");
  });
});

describe("archiveRun", () => {
  it("sets archivedAt on a terminal run", async () => {
    const { deps, events } = createDeps();
    const runId = seedRun(deps.state, { status: "failed" });

    const result = await archiveRun({ runId, operator: "system" }, deps);

    expect(result.ok).toBe(true);
    expect(deps.state.getRun(runId)?.archivedAt).toBe(
      "2026-05-15T12:00:00.000Z",
    );
    expect(events.map((e) => e.type)).toEqual([
      "operator_action_requested",
      "operator_action_succeeded",
    ]);
  });

  it("rejects archive on an active run", async () => {
    const { deps, events } = createDeps();
    const runId = seedRun(deps.state, { status: "running" });

    const result = await archiveRun({ runId, operator: "system" }, deps);

    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("invalid_status");
    expect(deps.state.getRun(runId)?.archivedAt).toBeUndefined();
    expect(events.at(-1)?.type).toBe("operator_action_failed");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/operations/__tests__/actions.test.ts
```

期望：失败，因为 `apps/orchestrator/src/operations/actions.ts` 尚不存在。

- [ ] **Step 3: 实现 actions service**

创建 `apps/orchestrator/src/operations/actions.ts`：

```ts
import { randomUUID } from "node:crypto";

import type { EventBus } from "@issuepilot/observability";
import type { IssuePilotInternalEvent } from "@issuepilot/shared-contracts";

import type { RuntimeState } from "../runtime/state.js";
import type { RunCancelRegistry } from "../runtime/run-cancel-registry.js";

export type OperatorAction = "retry" | "stop" | "archive";

export type OperatorActionResult =
  | { ok: true }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "invalid_status" }
  | {
      ok: false;
      code: "cancel_failed";
      reason: "cancel_timeout" | "cancel_threw" | "not_registered";
      message?: string;
    }
  | { ok: false; code: "gitlab_failed" | "internal_error"; message?: string };

export interface OperatorActionDeps {
  state: RuntimeState;
  eventBus: EventBus<IssuePilotInternalEvent>;
  leaseStore?: { release(leaseId: string): Promise<void> };
  runCancelRegistry: RunCancelRegistry;
  gitlab: {
    transitionLabels(
      iid: number,
      labels: { add: string[]; remove: string[] },
    ): Promise<void>;
  };
  workflow: {
    tracker: {
      runningLabel: string;
      reworkLabel: string;
      failedLabel: string;
      blockedLabel: string;
    };
  };
  now?: () => Date;
}

export interface OperatorActionInput {
  runId: string;
  operator: string;
  cancelTimeoutMs?: number;
}

function nowIso(deps: OperatorActionDeps): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

function emit(
  deps: OperatorActionDeps,
  type:
    | "operator_action_requested"
    | "operator_action_succeeded"
    | "operator_action_failed",
  runId: string,
  data: Record<string, unknown>,
): void {
  const ts = nowIso(deps);
  const event: IssuePilotInternalEvent = {
    id: randomUUID(),
    runId,
    type,
    message: `${type}:${data["action"] ?? "unknown"}`,
    data,
    createdAt: ts,
    ts,
  };
  const run = deps.state.getRun(runId);
  if (run?.issue) {
    event.issue = {
      id: run.issue.id ?? String(run.issue.iid),
      iid: run.issue.iid,
      title: run.issue.title,
      url: run.issue.url,
      projectId: run.issue.projectId,
    };
  }
  deps.eventBus.publish(event);
}

export async function retryRun(
  input: OperatorActionInput,
  deps: OperatorActionDeps,
): Promise<OperatorActionResult> {
  const { runId, operator } = input;
  emit(deps, "operator_action_requested", runId, {
    action: "retry",
    operator,
  });
  const run = deps.state.getRun(runId);
  if (!run) {
    emit(deps, "operator_action_failed", runId, {
      action: "retry",
      operator,
      code: "not_found",
    });
    return { ok: false, code: "not_found" };
  }
  if (
    run.status !== "failed" &&
    run.status !== "blocked" &&
    run.status !== "retrying"
  ) {
    emit(deps, "operator_action_failed", runId, {
      action: "retry",
      operator,
      code: "invalid_status",
      currentStatus: run.status,
    });
    return { ok: false, code: "invalid_status" };
  }

  const previousAttempt = run.attempt;
  const previousStatus = run.status;
  deps.state.setRun(runId, {
    ...run,
    status: "claimed",
    attempt: run.attempt + 1,
    updatedAt: nowIso(deps),
  });

  try {
    await deps.gitlab.transitionLabels(run.issue.iid, {
      add: [deps.workflow.tracker.reworkLabel],
      remove: [
        deps.workflow.tracker.runningLabel,
        deps.workflow.tracker.failedLabel,
        deps.workflow.tracker.blockedLabel,
      ],
    });
  } catch (err) {
    deps.state.setRun(runId, {
      ...deps.state.getRun(runId)!,
      status: previousStatus,
      attempt: previousAttempt,
    });
    const message = err instanceof Error ? err.message : String(err);
    emit(deps, "operator_action_failed", runId, {
      action: "retry",
      operator,
      code: "gitlab_failed",
      message,
    });
    return { ok: false, code: "gitlab_failed", message };
  }

  emit(deps, "operator_action_succeeded", runId, {
    action: "retry",
    operator,
    transitions: ["attempt_incremented", "labels_to_rework"],
  });
  return { ok: true };
}

export async function stopRun(
  input: OperatorActionInput,
  deps: OperatorActionDeps,
): Promise<OperatorActionResult> {
  const { runId, operator } = input;
  emit(deps, "operator_action_requested", runId, {
    action: "stop",
    operator,
  });
  const run = deps.state.getRun(runId);
  if (!run) {
    emit(deps, "operator_action_failed", runId, {
      action: "stop",
      operator,
      code: "not_found",
    });
    return { ok: false, code: "not_found" };
  }
  if (run.status !== "running") {
    emit(deps, "operator_action_failed", runId, {
      action: "stop",
      operator,
      code: "invalid_status",
      currentStatus: run.status,
    });
    return { ok: false, code: "invalid_status" };
  }

  const cancelResult = await deps.runCancelRegistry.cancel(runId, {
    ...(input.cancelTimeoutMs ? { timeoutMs: input.cancelTimeoutMs } : {}),
  });

  if (cancelResult.ok) {
    emit(deps, "operator_action_succeeded", runId, {
      action: "stop",
      operator,
      transitions: ["interrupt_sent"],
    });
    return { ok: true };
  }

  deps.state.setRun(runId, {
    ...run,
    status: "stopping",
    updatedAt: nowIso(deps),
  });
  const reason =
    cancelResult.reason ?? ("cancel_threw" as const);
  emit(deps, "operator_action_failed", runId, {
    action: "stop",
    operator,
    code: "cancel_failed",
    reason,
    message: cancelResult.message,
  });
  return {
    ok: false,
    code: "cancel_failed",
    reason,
    ...(cancelResult.message ? { message: cancelResult.message } : {}),
  };
}

export async function archiveRun(
  input: OperatorActionInput,
  deps: OperatorActionDeps,
): Promise<OperatorActionResult> {
  const { runId, operator } = input;
  emit(deps, "operator_action_requested", runId, {
    action: "archive",
    operator,
  });
  const run = deps.state.getRun(runId);
  if (!run) {
    emit(deps, "operator_action_failed", runId, {
      action: "archive",
      operator,
      code: "not_found",
    });
    return { ok: false, code: "not_found" };
  }
  if (
    run.status !== "failed" &&
    run.status !== "blocked" &&
    run.status !== "completed"
  ) {
    emit(deps, "operator_action_failed", runId, {
      action: "archive",
      operator,
      code: "invalid_status",
      currentStatus: run.status,
    });
    return { ok: false, code: "invalid_status" };
  }

  deps.state.setRun(runId, {
    ...run,
    archivedAt: nowIso(deps),
    updatedAt: nowIso(deps),
  });
  emit(deps, "operator_action_succeeded", runId, {
    action: "archive",
    operator,
    transitions: ["archived"],
  });
  return { ok: true };
}
```

- [ ] **Step 4: 运行 focused 测试**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/operations/__tests__/actions.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

期望：PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/orchestrator/src/operations/actions.ts apps/orchestrator/src/operations/__tests__/actions.test.ts
git commit -m "feat(orchestrator): add operator action services"
```

## 任务 5：HTTP 路由

**Files:**
- Modify: `apps/orchestrator/src/server/index.ts`
- Modify: `apps/orchestrator/src/server/__tests__/server.test.ts`

- [ ] **Step 1: 补失败的 server route 测试**

在 `apps/orchestrator/src/server/__tests__/server.test.ts` 末尾追加：

```ts
async function buildAppWithActions(
  actions: {
    retry?: ReturnType<typeof vi.fn>;
    stop?: ReturnType<typeof vi.fn>;
    archive?: ReturnType<typeof vi.fn>;
  },
) {
  const state = createRuntimeState();
  const eventBus = createEventBus<TestEvent>();
  const app = await createServer(
    {
      state,
      eventBus,
      readEvents: async () => [],
      workflowPath: ".agents/workflow.md",
      gitlabProject: "group/project",
      pollIntervalMs: 10000,
      concurrency: 1,
      operatorActions: {
        retry: actions.retry ?? vi.fn(),
        stop: actions.stop ?? vi.fn(),
        archive: actions.archive ?? vi.fn(),
      },
    },
    { port: 0 },
  );
  return { app, state };
}

describe("operator action routes", () => {
  it("POST /api/runs/:runId/retry returns 200 with operator header default", async () => {
    const retry = vi.fn(async () => ({ ok: true as const }));
    const { app } = await buildAppWithActions({ retry });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/retry",
      });
      expect(resp.statusCode).toBe(200);
      expect(retry).toHaveBeenCalledWith({
        runId: "run-1",
        operator: "system",
      });
    } finally {
      await app.close();
    }
  });

  it("POST honors x-issuepilot-operator header", async () => {
    const retry = vi.fn(async () => ({ ok: true as const }));
    const { app } = await buildAppWithActions({ retry });
    try {
      await app.inject({
        method: "POST",
        url: "/api/runs/run-1/retry",
        headers: { "x-issuepilot-operator": "alice" },
      });
      expect(retry).toHaveBeenCalledWith({ runId: "run-1", operator: "alice" });
    } finally {
      await app.close();
    }
  });

  it("POST returns 409 on invalid_status", async () => {
    const stop = vi.fn(async () => ({
      ok: false as const,
      code: "invalid_status" as const,
    }));
    const { app } = await buildAppWithActions({ stop });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/stop",
      });
      expect(resp.statusCode).toBe(409);
      expect(resp.json()).toMatchObject({
        ok: false,
        code: "invalid_status",
      });
    } finally {
      await app.close();
    }
  });

  it("POST returns 409 on cancel_failed with reason", async () => {
    const stop = vi.fn(async () => ({
      ok: false as const,
      code: "cancel_failed" as const,
      reason: "cancel_timeout" as const,
    }));
    const { app } = await buildAppWithActions({ stop });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/stop",
      });
      expect(resp.statusCode).toBe(409);
      expect(resp.json()).toMatchObject({
        ok: false,
        code: "cancel_failed",
        reason: "cancel_timeout",
      });
    } finally {
      await app.close();
    }
  });

  it("POST returns 404 on not_found", async () => {
    const archive = vi.fn(async () => ({
      ok: false as const,
      code: "not_found" as const,
    }));
    const { app } = await buildAppWithActions({ archive });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/archive",
      });
      expect(resp.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("POST returns 500 on gitlab_failed", async () => {
    const retry = vi.fn(async () => ({
      ok: false as const,
      code: "gitlab_failed" as const,
      message: "no route to host",
    }));
    const { app } = await buildAppWithActions({ retry });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/retry",
      });
      expect(resp.statusCode).toBe(500);
    } finally {
      await app.close();
    }
  });

  it("POST returns 503 actions_unavailable when operatorActions is not wired", async () => {
    // V2 team daemon Phase 2 path: server is created without operatorActions.
    const { app } = await buildTestApp();
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/retry",
      });
      expect(resp.statusCode).toBe(503);
      expect(resp.json()).toMatchObject({
        ok: false,
        code: "actions_unavailable",
      });
    } finally {
      await app.close();
    }
  });
});

describe("archived run filter", () => {
  it("GET /api/runs hides archived by default", async () => {
    const { app, state } = await buildTestApp();
    state.setRun("active", {
      runId: "active",
      issue: {
        id: "1",
        iid: 1,
        title: "Fix",
        url: "https://example/-/issues/1",
        projectId: "g/p",
        labels: [],
      },
      status: "completed",
      attempt: 1,
      branch: "ai/1",
      workspacePath: "/tmp",
      startedAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:01.000Z",
    });
    state.setRun("archived", {
      runId: "archived",
      issue: {
        id: "2",
        iid: 2,
        title: "Done",
        url: "https://example/-/issues/2",
        projectId: "g/p",
        labels: [],
      },
      status: "completed",
      attempt: 1,
      branch: "ai/2",
      workspacePath: "/tmp",
      startedAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:01.000Z",
      archivedAt: "2026-05-15T00:00:00.000Z",
    });
    try {
      const resp = await app.inject({ method: "GET", url: "/api/runs" });
      const ids = (resp.json() as Array<{ runId: string }>).map((r) => r.runId);
      expect(ids).toEqual(["active"]);
    } finally {
      await app.close();
    }
  });

  it("GET /api/runs?includeArchived=true returns archived runs", async () => {
    const { app, state } = await buildTestApp();
    state.setRun("archived", {
      runId: "archived",
      issue: {
        id: "2",
        iid: 2,
        title: "Done",
        url: "https://example/-/issues/2",
        projectId: "g/p",
        labels: [],
      },
      status: "completed",
      attempt: 1,
      branch: "ai/2",
      workspacePath: "/tmp",
      startedAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:01.000Z",
      archivedAt: "2026-05-15T00:00:00.000Z",
    });
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/runs?includeArchived=true",
      });
      const ids = (resp.json() as Array<{ runId: string }>).map((r) => r.runId);
      expect(ids).toContain("archived");
    } finally {
      await app.close();
    }
  });
});
```

注意 `buildTestApp()` 是文件顶部已有的 helper（参考行 19）；`buildAppWithActions()` 是本任务为 operator action 路径新增的，沿用 `buildTestApp` 的 deps 风格。这两个 helper 都不接受 `operatorActions = undefined` 之外的省略形式，避免和现有 `/api/state` test 的 deps 构造方式冲突。

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/server/__tests__/server.test.ts
```

- [ ] **Step 3: 扩展 ServerDeps 和路由**

在 `apps/orchestrator/src/server/index.ts` 的 `ServerDeps` 接口里增加：

```ts
  operatorActions?: {
    retry(input: { runId: string; operator: string }): Promise<OperatorActionResult>;
    stop(input: { runId: string; operator: string }): Promise<OperatorActionResult>;
    archive(input: { runId: string; operator: string }): Promise<OperatorActionResult>;
  };
```

import `OperatorActionResult` from `../operations/actions.js`。

把 `/api/runs` 的 query 类型改为：

```ts
app.get<{
  Querystring: { status?: string; limit?: string; includeArchived?: string };
}>("/api/runs", async (request, reply) => {
  // ... existing parsing ...
  const includeArchived = request.query.includeArchived === "true";
  let runs = status ? deps.state.listRuns(status) : deps.state.allRuns();
  if (!includeArchived) {
    runs = runs.filter(
      (r) => !(r as { archivedAt?: string | undefined }).archivedAt,
    );
  }
  runs = runs.slice(0, limit ?? 50);
  // ...
});
```

在文件末尾、`createServer` 内 server `app.get(...)` 路由块之后、`return app` 之前增加：

```ts
  function statusFromCode(code: string): number {
    if (code === "not_found") return 404;
    if (code === "invalid_status" || code === "cancel_failed") return 409;
    if (code === "gitlab_failed" || code === "internal_error") return 500;
    return 500;
  }

  async function dispatchAction(
    action: "retry" | "stop" | "archive",
    request: { params: { runId: string }; headers: Record<string, unknown> },
    reply: { code(s: number): { send(body: unknown): unknown } },
  ) {
    if (!deps.operatorActions) {
      return reply
        .code(503)
        .send({ ok: false, code: "actions_unavailable" });
    }
    const { runId } = request.params;
    const headerVal = request.headers["x-issuepilot-operator"];
    const operator =
      (Array.isArray(headerVal) ? headerVal[0] : headerVal) ?? "system";
    const operatorStr = typeof operator === "string" ? operator : "system";
    const result = await deps.operatorActions[action]({
      runId,
      operator: operatorStr,
    });
    if (result.ok) {
      return reply.code(200).send({ ok: true });
    }
    return reply.code(statusFromCode(result.code)).send(result);
  }

  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/retry",
    (request, reply) =>
      dispatchAction("retry", request as never, reply as never),
  );
  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/stop",
    (request, reply) =>
      dispatchAction("stop", request as never, reply as never),
  );
  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/archive",
    (request, reply) =>
      dispatchAction("archive", request as never, reply as never),
  );
```

如果原 `Fastify` 类型推断对 `dispatchAction` 不友好，可以把 `dispatchAction` 内联到三个路由 handler 里，但保持 `statusFromCode` 抽出来避免重复。

- [ ] **Step 4: 运行 focused 测试**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/server/__tests__/server.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

期望：PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/orchestrator/src/server/index.ts apps/orchestrator/src/server/__tests__/server.test.ts
git commit -m "feat(server): expose operator action routes and archive filter"
```

## 任务 6：装配 V1 / V2 daemon

**Files:**
- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `apps/orchestrator/src/team/daemon.ts`
- Modify: `apps/orchestrator/src/__tests__/daemon.test.ts`
- Modify: `apps/orchestrator/src/team/__tests__/daemon.test.ts`

- [ ] **Step 1: 写失败的 V1 daemon 测试**

在 `apps/orchestrator/src/__tests__/daemon.test.ts` 适当 `describe` 块里追加：

```ts
it("registers operator actions and runCancelRegistry into createServer", async () => {
  const createServer = vi.fn(async () => ({ close: vi.fn(async () => {}) }));
  await startDaemon({
    // ... existing required deps ...
    createServer,
  });
  const serverDeps = createServer.mock.calls[0]![0]!;
  expect(serverDeps.operatorActions).toBeDefined();
  expect(typeof serverDeps.operatorActions.retry).toBe("function");
  expect(typeof serverDeps.operatorActions.stop).toBe("function");
  expect(typeof serverDeps.operatorActions.archive).toBe("function");
});
```

并在 V1 daemon 内 runAgent 路径附近补一个测试，断言在 `driveLifecycle` 期间 `runCancelRegistry.has(runId)` 为 true，driveLifecycle 返回后 has(runId) 为 false。具体写法看你现有 daemon test 注入 `runAgent` 的能力；如果不容易精确测，至少断言 `runAgent` 调用时 `onTurnActive` 参数已被注入（spy `driveLifecycle`）。

- [ ] **Step 2: 补 V2 team daemon 测试（断言暂不装配）**

V2 team daemon Phase 2 不装配 `operatorActions`（见 Step 5 说明）。在 `apps/orchestrator/src/team/__tests__/daemon.test.ts` 增加：

```ts
it("does not wire operatorActions in Phase 2 (V2 dispatch lands later)", async () => {
  const createServer = vi.fn(async () => ({ close: vi.fn(async () => {}) }));
  await startTeamDaemon(
    { configPath: "/tmp/issuepilot.team.yaml" },
    {
      loadTeamConfig: async () => fakeConfig(),
      createProjectRegistry: async () => fakeRegistry(),
      createServer,
      createLeaseStore: () => fakeLeaseStore(),
    },
  );
  const serverDeps = createServer.mock.calls[0]![0]!;
  expect(serverDeps.operatorActions).toBeUndefined();
});
```

server 层 503 的端到端断言放在任务 5（server.test.ts）已经覆盖的 `deps.operatorActions` 缺失分支，不在 daemon test 重复。

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/__tests__/daemon.test.ts src/team/__tests__/daemon.test.ts
```

- [ ] **Step 4: 在 V1 daemon 装配**

在 `apps/orchestrator/src/daemon.ts` 顶部 import 增加：

```ts
import { createRunCancelRegistry } from "./runtime/run-cancel-registry.js";
import {
  archiveRun,
  retryRun,
  stopRun,
} from "./operations/actions.js";
```

在 `startDaemon` 内构造 `runCancelRegistry`：

```ts
const runCancelRegistry = createRunCancelRegistry();
```

把 `runAgent` 路径里 `driveLifecycle` 调用改成：

```ts
try {
  const result = await driveLifecycle({
    rpc,
    // ... existing fields ...
    onTurnActive: (cancel) => runCancelRegistry.register(runId, cancel),
    onEvent: (type, data) =>
      publishEvent({
        type: `codex_${type}`,
        runId,
        ts: new Date().toISOString(),
        detail: { data },
      }),
  });
  return {
    status: result.status,
    summary: result.failureReason,
  };
} finally {
  runCancelRegistry.unregister(runId);
  await rpc.close();
}
```

在 `createServer({ ... })` 调用处增加 `operatorActions`：

```ts
operatorActions: {
  retry: (input) =>
    retryRun(input, {
      state,
      eventBus,
      runCancelRegistry,
      gitlab,
      workflow,
    }),
  stop: (input) =>
    stopRun(input, {
      state,
      eventBus,
      runCancelRegistry,
      gitlab,
      workflow,
    }),
  archive: (input) =>
    archiveRun(input, {
      state,
      eventBus,
      runCancelRegistry,
      gitlab,
      workflow,
    }),
},
```

`state` / `eventBus` / `gitlab` / `workflow` 已经在外层作用域可用。

- [ ] **Step 5: V2 team daemon 暂不装配 operatorActions**

V2 team daemon（`apps/orchestrator/src/team/daemon.ts`）当前没有 GitLab adapter（Phase 1 只是 claim foundation shell，没有 runAgent dispatch），且 state 里也没有真实 run——所以 V2 模式下 retry / stop / archive 没东西可操作。

本步骤明确**不**给 V2 team daemon 装配 `operatorActions`：

- `createServerImpl({ ... })` 调用中**不**传 `operatorActions` 字段。
- 任务 5 已经实现的 server 路由会在 `deps.operatorActions` 缺失时返回 HTTP 503 `{ ok: false, code: "actions_unavailable" }`。
- 在 `apps/orchestrator/src/team/__tests__/daemon.test.ts` 新增测试：team daemon 启动后 POST `/api/runs/x/retry` 返回 503，body `code` 为 `"actions_unavailable"`，确保用户在 V2 模式下点 dashboard 按钮能看到明确反馈而不是 5xx 黑盒。

dashboard 端**不**为 V2 mode 隐藏按钮——按钮显隐只看 run 状态，不看 daemon mode。V2 dispatch 落地（独立 V3 work item 或 V2 Phase 6+）后再补回 operatorActions 装配；这条限制写入 README / CHANGELOG。

- [ ] **Step 6: 运行 focused 测试**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/__tests__/daemon.test.ts src/team/__tests__/daemon.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

期望：PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/orchestrator/src/daemon.ts apps/orchestrator/src/__tests__/daemon.test.ts apps/orchestrator/src/team/daemon.ts apps/orchestrator/src/team/__tests__/daemon.test.ts
git commit -m "feat(orchestrator): wire operator actions and run cancel registry"
```

## 任务 7：Dashboard API client + RunActions 组件

**Files:**
- Modify: `apps/dashboard/lib/api.ts`
- Modify: `apps/dashboard/lib/api.test.ts`（或当前 colocated test 文件）
- Create: `apps/dashboard/components/overview/run-actions.tsx`
- Create: `apps/dashboard/components/overview/run-actions.test.tsx`

- [ ] **Step 1: 写失败的 client 测试**

在 dashboard 的 api test 文件里追加：

```ts
import { describe, expect, it, vi } from "vitest";

import { archiveRun, retryRun, stopRun } from "./api";

describe("operator action client", () => {
  it("retryRun POSTs without operator header by default", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await retryRun("http://api", "run-1");
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://api/api/runs/run-1/retry");
      expect((init as RequestInit).method).toBe("POST");
      const headers = new Headers(((init as RequestInit).headers ?? undefined));
      expect(headers.get("x-issuepilot-operator")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stopRun throws ApiError on 409", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ ok: false, code: "invalid_status" }),
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(stopRun("http://api", "run-1")).rejects.toMatchObject({
        status: 409,
        code: "invalid_status",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("archiveRun returns ok on 200", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await archiveRun("http://api", "run-1");
      expect(result.ok).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
```

并创建 `apps/dashboard/components/overview/run-actions.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RunActions } from "./run-actions";

describe("RunActions", () => {
  it("renders Retry + Archive for failed run", () => {
    render(
      <RunActions
        run={{ runId: "r1", status: "failed" }}
        onRetry={vi.fn()}
        onStop={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /archive/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /stop/i }),
    ).not.toBeInTheDocument();
  });

  it("renders Stop for running run", () => {
    render(
      <RunActions
        run={{ runId: "r1", status: "running" }}
        onRetry={vi.fn()}
        onStop={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
  });

  it("hides all buttons when archived", () => {
    const { container } = render(
      <RunActions
        run={{ runId: "r1", status: "failed", archivedAt: "2026-05-15" }}
        onRetry={vi.fn()}
        onStop={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("calls onRetry with runId when Retry clicked", async () => {
    const onRetry = vi.fn();
    render(
      <RunActions
        run={{ runId: "r1", status: "failed" }}
        onRetry={onRetry}
        onStop={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledWith("r1");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @issuepilot/dashboard test -- lib/api.test.ts components/overview/run-actions.test.tsx
```

- [ ] **Step 3: 实现 client + 组件**

在 `apps/dashboard/lib/api.ts` 中（仿照已有的 `fetchRuns` / `fetchRunDetail` 风格）新增：

```ts
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly reason?: string,
  ) {
    super(message);
  }
}

async function postAction(
  apiUrl: string,
  runId: string,
  action: "retry" | "stop" | "archive",
): Promise<{ ok: true }> {
  const resp = await fetch(`${apiUrl}/api/runs/${runId}/${action}`, {
    method: "POST",
  });
  if (resp.ok) {
    return { ok: true };
  }
  let body: { code?: string; reason?: string } = {};
  try {
    body = await resp.json();
  } catch {
    /* keep empty */
  }
  throw new ApiError(
    `Operator action ${action} failed`,
    resp.status,
    body.code,
    body.reason,
  );
}

export const retryRun = (apiUrl: string, runId: string) =>
  postAction(apiUrl, runId, "retry");
export const stopRun = (apiUrl: string, runId: string) =>
  postAction(apiUrl, runId, "stop");
export const archiveRun = (apiUrl: string, runId: string) =>
  postAction(apiUrl, runId, "archive");
```

并把 `fetchRuns` 增加 `includeArchived?: boolean` 选项：

```ts
export function fetchRuns(
  apiUrl: string,
  opts?: { includeArchived?: boolean },
): Promise<...> {
  const params = new URLSearchParams();
  if (opts?.includeArchived) params.set("includeArchived", "true");
  const qs = params.toString();
  return fetch(
    `${apiUrl}/api/runs${qs ? `?${qs}` : ""}`,
  ).then((r) => r.json());
}
```

创建 `apps/dashboard/components/overview/run-actions.tsx`：

```tsx
"use client";

import { useTransition } from "react";

import { Button } from "../ui/button";

interface RunSnapshot {
  runId: string;
  status: string;
  archivedAt?: string;
}

interface RunActionsProps {
  run: RunSnapshot;
  onRetry?: (runId: string) => void | Promise<void>;
  onStop?: (runId: string) => void | Promise<void>;
  onArchive?: (runId: string) => void | Promise<void>;
}

export function RunActions({ run, onRetry, onStop, onArchive }: RunActionsProps) {
  const [pending, startTransition] = useTransition();

  if (run.archivedAt) return null;

  const showRetry =
    run.status === "failed" ||
    run.status === "blocked" ||
    run.status === "retrying";
  const showStop = run.status === "running";
  const showArchive =
    run.status === "failed" ||
    run.status === "blocked" ||
    run.status === "completed";

  if (!showRetry && !showStop && !showArchive) return null;

  const dispatch = (fn?: (id: string) => void | Promise<void>) => () => {
    if (!fn) return;
    startTransition(async () => {
      await fn(run.runId);
    });
  };

  return (
    <div className="flex flex-wrap gap-2">
      {showRetry && (
        <Button size="sm" disabled={pending} onClick={dispatch(onRetry)}>
          Retry
        </Button>
      )}
      {showStop && (
        <Button
          size="sm"
          variant="destructive"
          disabled={pending}
          onClick={dispatch(onStop)}
        >
          Stop
        </Button>
      )}
      {showArchive && (
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={dispatch(onArchive)}
        >
          Archive
        </Button>
      )}
    </div>
  );
}
```

`Button` 来自现有 shadcn 包装。如果当前 dashboard 没有 `Button`，复用 `apps/dashboard/components/ui/` 下已有的按钮组件；如果完全没有，参考 Phase 1 `Badge` 实现风格手写一个最小 `Button`。

- [ ] **Step 4: 运行 focused 测试**

```bash
pnpm --filter @issuepilot/dashboard test -- lib/api.test.ts components/overview/run-actions.test.tsx
pnpm --filter @issuepilot/dashboard typecheck
```

期望：PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/dashboard/lib/api.ts apps/dashboard/lib/api.test.ts apps/dashboard/components/overview/run-actions.tsx apps/dashboard/components/overview/run-actions.test.tsx
git commit -m "feat(dashboard): add run action client and button component"
```

## 任务 8：接入 runs-table 和 detail 页

**Files:**
- Modify: `apps/dashboard/components/overview/runs-table.tsx`
- Modify: `apps/dashboard/components/overview/runs-table.test.tsx`
- Modify: `apps/dashboard/components/detail/run-detail-page.tsx`
- Modify: `apps/dashboard/components/detail/run-detail-page.test.tsx`

- [ ] **Step 1: 补失败测试**

在 `runs-table.test.tsx` 加：

```tsx
it("hides archived runs by default", () => {
  const runs = [
    { runId: "active", status: "completed", ... },
    { runId: "archived", status: "completed", archivedAt: "2026-05-15T...", ... },
  ];
  render(<RunsTable runs={runs} apiUrl="http://api" />);
  expect(screen.queryByText("archived")).not.toBeInTheDocument();
});

it("shows archived after toggling Show archived", async () => {
  render(<RunsTable runs={runs} apiUrl="http://api" />);
  await userEvent.click(screen.getByRole("checkbox", { name: /show archived/i }));
  expect(screen.getByText("archived")).toBeInTheDocument();
});

it("renders RunActions in each row", () => {
  render(<RunsTable runs={[{ runId: "r1", status: "failed", ... }]} apiUrl="http://api" />);
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
});
```

在 `run-detail-page.test.tsx` 加：

```tsx
it("renders RunActions in header for failed run", () => {
  render(<RunDetailPage run={{ runId: "r1", status: "failed", ... }} apiUrl="http://api" events={[]} logsTail={[]} />);
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @issuepilot/dashboard test -- components/overview/runs-table.test.tsx components/detail/run-detail-page.test.tsx
```

- [ ] **Step 3: 实现 runs-table 整合**

在 `runs-table.tsx` 顶部 import `RunActions`、`archiveRun`、`retryRun`、`stopRun`、`useState`。在组件顶部增加 `const [showArchived, setShowArchived] = useState(false);`，按 toggle 过滤 props.runs。新增表格 `<th>Actions</th>` 列，行内渲染：

```tsx
<RunActions
  run={run}
  onRetry={async (id) => {
    await retryRun(props.apiUrl, id);
    props.onRefresh?.();
  }}
  onStop={async (id) => {
    await stopRun(props.apiUrl, id);
    props.onRefresh?.();
  }}
  onArchive={async (id) => {
    await archiveRun(props.apiUrl, id);
    props.onRefresh?.();
  }}
/>
```

`props.onRefresh` 是可选；如果 runs-table 当前依赖 SSE 自动刷新，refresh 调用可以省略。

在表格 header 行上方加：

```tsx
<label className="flex items-center gap-2 text-sm text-slate-600">
  <input
    type="checkbox"
    checked={showArchived}
    onChange={(e) => setShowArchived(e.target.checked)}
  />
  Show archived
</label>
```

- [ ] **Step 4: 实现 detail page 整合**

在 `run-detail-page.tsx` header 区域加 `<RunActions run={run} onRetry={...} onStop={...} onArchive={...} />`，回调里调用 client 函数后 `props.onRefresh?.()`。

- [ ] **Step 5: 运行 focused 测试**

```bash
pnpm --filter @issuepilot/dashboard test -- components/overview components/detail
pnpm --filter @issuepilot/dashboard typecheck
```

期望：PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/dashboard/components/overview/runs-table.tsx apps/dashboard/components/overview/runs-table.test.tsx apps/dashboard/components/detail/run-detail-page.tsx apps/dashboard/components/detail/run-detail-page.test.tsx
git commit -m "feat(dashboard): surface operator actions in tables"
```

## 任务 9：Focused e2e

**Files:**
- Create: `tests/e2e/operator-actions.test.ts`
- Modify: `tests/e2e/fakes/codex/script.ts`（若需扩展 fake 脚本以支持 expect-interrupt step）
- Modify: `tests/e2e/fixtures/codex.*.json`（新增 retry / stop 场景脚本）

- [ ] **Step 1: 扩展 fake codex 以支持 turn/interrupt 期望**

如果 `tests/e2e/fakes/codex/script.ts` 当前不支持 expect-incoming-rpc-request 类型 step，参考已有的 `expectResponse` 风格新增 `expectIncomingRequest("turn/interrupt")` step：收到该 request 立即回 `{}`，然后再 emit `turn/completed { turn: { status: "interrupted" } }`。如果脚本格式已经支持，跳过本步骤。

- [ ] **Step 2: 写 retry e2e**

创建 `tests/e2e/operator-actions.test.ts`，scenario A：

```ts
it("operator retry: failed run → POST /retry → re-claim on next poll", async () => {
  const env = await startE2E({ workflow: "...failed-then-retry-fixture..." });
  // seed a failed run via fake codex script that fails the first attempt
  await env.fakeGitlab.seedIssue({ iid: 1, labels: ["ai-ready"] });
  await env.daemon.pollOnce();
  // wait for run to reach 'failed'
  await waitForRunStatus(env, "failed", { timeoutMs: 15000 });
  // POST /retry
  const resp = await fetch(`${env.apiUrl}/api/runs/${env.lastRunId}/retry`, {
    method: "POST",
  });
  expect(resp.status).toBe(200);
  // expect run state and GitLab labels to flip to ai-rework
  expect(await env.fakeGitlab.getIssueLabels(1)).toContain("ai-rework");
  // next poll re-claims
  await env.daemon.pollOnce();
  await waitForRunStatus(env, "running", { timeoutMs: 15000 });
});
```

scenario B：

```ts
it("operator stop: running run → POST /stop → turn/interrupt → cancelled → failed", async () => {
  const env = await startE2E({
    workflow: "...long-running-codex-fixture-with-expect-interrupt...",
  });
  await env.fakeGitlab.seedIssue({ iid: 2, labels: ["ai-ready"] });
  await env.daemon.pollOnce();
  await waitForRunStatus(env, "running", { timeoutMs: 15000 });
  const resp = await fetch(`${env.apiUrl}/api/runs/${env.lastRunId}/stop`, {
    method: "POST",
  });
  expect(resp.status).toBe(200);
  // fake codex emits turn/completed { interrupted }; dispatch收敛
  await waitForRunStatus(env, "failed", { timeoutMs: 15000 });
  expect(env.fakeCodex.receivedRequests("turn/interrupt")).toHaveLength(1);
});
```

scenario C：

```ts
it("operator stop with unresponsive codex: HTTP 409 cancel_failed and run goes to stopping", async () => {
  const env = await startE2E({
    workflow: "...long-running-codex-that-ignores-interrupt...",
    cancelTimeoutMs: 500,
  });
  await env.fakeGitlab.seedIssue({ iid: 3, labels: ["ai-ready"] });
  await env.daemon.pollOnce();
  await waitForRunStatus(env, "running", { timeoutMs: 15000 });
  const resp = await fetch(`${env.apiUrl}/api/runs/${env.lastRunId}/stop`, {
    method: "POST",
  });
  expect(resp.status).toBe(409);
  expect(await resp.json()).toMatchObject({
    code: "cancel_failed",
    reason: "cancel_timeout",
  });
  await waitForRunStatus(env, "stopping", { timeoutMs: 5000 });
  // eventually turnTimeoutMs forces run to failed
  await waitForRunStatus(env, "failed", { timeoutMs: 35000 });
});
```

`startE2E` / `waitForRunStatus` / `env.fakeGitlab` / `env.fakeCodex` 的命名跟随 `tests/e2e/` 现有 happy-path / blocked-and-failed test 的 helper 风格。如果命名不一致，按现有 helper 调整。fixture 需要新建：`tests/e2e/fixtures/codex.stop-interrupt.json`、`tests/e2e/fixtures/codex.stop-ignore-interrupt.json`，把 `turnTimeoutMs` 设成 30s 让 scenario C 有足够时间观察 stopping 状态。

- [ ] **Step 3: 运行 e2e**

```bash
pnpm --filter @issuepilot/tests-e2e test -- operator-actions
```

期望：全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add tests/e2e/operator-actions.test.ts tests/e2e/fixtures/codex.stop-interrupt.json tests/e2e/fixtures/codex.stop-ignore-interrupt.json tests/e2e/fakes/codex/script.ts
git commit -m "test(e2e): cover operator retry, stop interrupt, and stop timeout"
```

## 任务 10：文档、CHANGELOG 与 release safety

**Files:**
- Modify: `docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: spec 链接**

在 V2 总 spec `### Phase 2：Dashboard Operations` 节末追加：

```md

实施计划：

- `docs/superpowers/plans/2026-05-15-issuepilot-v2-dashboard-operations.md`

补充设计：

- `docs/superpowers/specs/2026-05-15-issuepilot-v2-phase2-dashboard-operations-design.md`
```

如果 Phase 2 节末已经有 plan 链接，只追加 spec 链接。

- [ ] **Step 2: README V2 列表标 ✅**

`README.md` `### V2 — Team-operable release` 把 `Dashboard gains \`retry\`, \`stop\`, and \`archive run\` actions.` 这行改为：

```md
- ✅ Dashboard gains `retry`, `stop`, and `archive run` actions (V2 Phase 2).
```

`README.zh-CN.md` `### V2 — 团队可运营版本` 把 `dashboard 增加基础操作：\`retry\`、\`stop\`、\`archive run\`。` 改为：

```md
- ✅ dashboard 基础操作 `retry` / `stop` / `archive run` 已交付（V2 Phase 2，stop 走真实 `turn/interrupt`）。
```

- [ ] **Step 3: CHANGELOG**

在 `CHANGELOG.md` `## [Unreleased]` 下 `### Added` 节追加一条（参考 Phase 1 入库的格式风格）：

```md
- 2026-05-15 — **V2 Phase 2 Dashboard Operations 落地：retry / stop / archive 三件套，stop 走 Codex `turn/interrupt` 真实 cancel。** 新增 `apps/orchestrator/src/operations/actions.ts`（三个 action service 函数 + state 回滚 + emit operator_action_* 事件），`apps/orchestrator/src/runtime/run-cancel-registry.ts`（内存型 runId → cancel 闭包映射，5s 默认超时分类 cancel_timeout / cancel_threw / not_registered）。runner 包 `packages/runner-codex-app-server/src/lifecycle.ts` 暴露 `onTurnActive(cancel)` 钩子，每个 turn 把 `turn/interrupt` JSON-RPC request 闭包传给 caller；turn 收敛后闭包变 noop。识别 `turn/completed { turn.status: "interrupted" }` 走 cancelled outcome。共享契约 `packages/shared-contracts` 新增 3 个事件类型、`RUN_STATUS_VALUES` 增加 `stopping`、`RunRecord.archivedAt` 可选字段。orchestrator Fastify server 新增 POST `/api/runs/:runId/{retry|stop|archive}` 三个路由，operator header `x-issuepilot-operator` 缺失时默认 `system`；`GET /api/runs` 默认隐藏 archived，`?includeArchived=true` 还原。dashboard 新增 `components/overview/run-actions.tsx`，按 run.status 渲染 Retry / Stop / Archive，archived 时全部隐藏；runs-table 加 Actions 列 + `Show archived` toggle；detail page header 加 RunActions。Focused e2e `tests/e2e/operator-actions.test.ts` 覆盖 retry / stop-interrupt / stop-timeout 三场景。验证：`pnpm lint`、`pnpm typecheck`、`pnpm test` 全绿。
  - **V2 team daemon operatorActions 暂未装配**：V2 Phase 1 只是 claim foundation，没有 runAgent dispatch，state 里也没有真实 run，operatorActions 没东西可操作。V2 模式下三个路由返回 HTTP 503 `actions_unavailable`，dashboard 按钮显隐不分 mode，让用户在 V2 模式下点按钮能看到明确反馈。V2 dispatch 落地后再补回装配。
  - **不在本期范围**：CI 回流（Phase 3）、review sweep（Phase 4）、workspace cleanup（Phase 5）、RBAC 多用户身份（V3）、批量 retry / 批量 archive。
  - **runner 进程级 SIGKILL 兜底**：本期不做。`turn/interrupt` 失败时退回 `stopping` 中间态，依赖 `turnTimeoutMs` 收敛。如果未来发现 Codex 不响应 interrupt 比例高，再单独做 SIGKILL fallback。
```

- [ ] **Step 4: release safety**

```bash
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

期望：全部 PASS。如果当前 session 时间不足，至少运行 package-scoped focused commands，并在最终说明里明确 root checks 未运行。

- [ ] **Step 5: 提交**

```bash
git add docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md README.md README.zh-CN.md CHANGELOG.md
git commit -m "docs(v2): document Phase 2 dashboard operations release"
```

## 自审

**Spec 覆盖：**

- V2 spec §8 retry / stop / archive：任务 4 / 5 / 7 / 8 覆盖。
- V2 spec §12 OperatorActionEvent + ProjectSummary：任务 1 + 5 覆盖。
- V2 spec §13 错误分类（cancel_failed / invalid_status / not_found / gitlab_failed）：任务 4 + 5 覆盖。
- V2 spec §14 dashboard actions 测试 + e2e：任务 7 / 8 / 9 覆盖。
- V2 Phase 2 补充设计 §5 cancel 机制三层：任务 2（runner 层）+ 3（registry 层）+ 4（service 层）覆盖。
- V2 Phase 2 补充设计 §6 operator 身份：任务 5（server 默认 `"system"`，header 兜底） + 任务 7（dashboard client 不设 header）覆盖。
- V2 Phase 2 补充设计 §10 测试策略：任务 3（registry 单测）+ 任务 2（runner cancel 单测）+ 任务 4（actions service 单测）+ 任务 9（三场景 e2e）覆盖。

**刻意延后：**

- V2 team daemon 的 operatorActions 装配：V2 Phase 1 还没有 runAgent dispatch，state 里没有真实 run。任务 6 步骤 5 明确不装配，server 返回 HTTP 503 `actions_unavailable`，等 V2 dispatch 落地后再补。
- runner 进程级 SIGKILL 兜底：`turn/interrupt` 不响应时退回 `stopping` + turnTimeout，不进 SIGKILL。后续 release 评估。
- RBAC、批量操作、二次确认弹窗：V3 范围。

**类型一致性：**

- `OperatorActionResult` 联合类型在任务 4 定义，任务 5 server 和任务 7 client 都消费同一类型签名。
- `OperatorActionDeps.runCancelRegistry` 是 `RunCancelRegistry` 接口（任务 3 定义），任务 4 / 6 都引用。
- `DriveInput.onTurnActive` 在任务 2 定义，任务 6 daemon 装配处使用。
- `RunRecord.archivedAt` 在任务 1 定义，任务 4 archiveRun 写入，任务 5 `/api/runs` filter 读取，任务 7 RunActions 判断。
- `RUN_STATUS_VALUES` 包含 `stopping` 在任务 1 定义，任务 4 stopRun 写入，任务 7 RunActions 不需要专门 case（`stopping` 不命中 retry/stop/archive 的任何条件，按设计不显示按钮）。

**占位扫描：**

- 本计划不含 `TBD` / `TODO` / 「类似 Task N」 / 「补合理的错误处理」/ 「为上面写测试」等占位短语。
- 每个代码改动步骤都给出具体文件、具体命令、具体期望和可验证产出。
- V2 team daemon 在任务 6 步骤 5 明确**不**装配 operatorActions，且新增一个对应的 503 路径测试（任务 5 步骤 1 末），不留 conditional。
