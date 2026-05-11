# IssuePilot Implementation Plan

> **For Claude / Codex：** REQUIRED SUB-SKILL：使用 `superpowers:executing-plans` 按 Task 顺序实施本计划，跨 Task 之间 commit。每个 Task 内严格遵循 TDD：先红、后绿、再 commit。
>
> **配套 Spec：** `docs/superpowers/specs/2026-05-11-issuepilot-design.md`

**Goal：** 交付 IssuePilot P0：本地 daemon 把带 `ai-ready` label 的 GitLab Issue 自动拾取，在隔离 worktree 内驱动 Codex app-server 完成实现，推送分支、创建 MR、写回 Issue note，并通过只读 Next.js dashboard 展示运行时间线。

**Architecture：** pnpm 工作区 + Turborepo。两个 app（`orchestrator` 本地 daemon、`dashboard` 只读 UI）依赖六个领域包（`core`、`workflow`、`tracker-gitlab`、`workspace`、`runner-codex-app-server`、`observability`、`shared-contracts`）。所有 git 操作通过 `execa` 调用真实 git CLI；Codex 通过 stdio JSON-RPC 与 `codex app-server` 交互；状态落盘为 `~/.issuepilot/state/**` 下的 JSON/JSONL。

**Tech Stack：** TypeScript / Node.js 22 LTS、pnpm workspace、Turborepo、Vitest、ESLint、Prettier、Fastify、Next.js App Router、Tailwind/shadcn、`pino`、`zod`、`gray-matter`、`yaml`、`liquidjs`、`execa`、`@gitbeaker/rest`、`commander`、SSE。

---

## 0. 工作约定（所有 Task 通用）

### 0.1 TDD 与提交节奏

每个 Task 必须按下列五个 Step 执行（除非 Task 明确声明"non-test"，例如脚手架）：

1. **写失败测试**：先在 `*.test.ts` 中写最小 reproduce/契约测试。
2. **运行测试确认失败**：`pnpm --filter <pkg> test -- <pattern>`，预期输出明确指出 missing export / 行为不符。
3. **写最小实现**：只为让测试通过的代码，不预先优化。
4. **运行测试确认通过**：再次执行测试命令，确认绿色。
5. **commit**：使用 Conventional Commit，scope 与包名一致。例：

```bash
git add packages/workflow tests/workflow
git commit -m "feat(workflow): parse front matter with defaults"
```

每个 Task 结束 **强制 commit 一次**，不允许跨 Task 累积变更。

### 0.2 通用命令

```bash
pnpm install                              # 安装依赖
pnpm -w turbo run build                   # 全量构建
pnpm -w turbo run test                    # 全量测试
pnpm --filter @issuepilot/<pkg> test      # 单包测试
pnpm --filter @issuepilot/<pkg> test -- -t "<name>"   # 单测过滤
pnpm --filter @issuepilot/<pkg> typecheck
pnpm -w lint
```

### 0.3 包命名

所有内部包统一前缀：`@issuepilot/`。
- `@issuepilot/core`
- `@issuepilot/workflow`
- `@issuepilot/tracker-gitlab`
- `@issuepilot/workspace`
- `@issuepilot/runner-codex-app-server`
- `@issuepilot/observability`
- `@issuepilot/shared-contracts`
- `@issuepilot/orchestrator`（app）
- `@issuepilot/dashboard`（app）

### 0.4 测试组织

- 单元测试：与源文件同包，路径 `packages/<pkg>/src/**/*.test.ts`。
- 跨包集成测试：根目录 `tests/integration/**`，专用 `tsconfig` 与 `vitest.config.ts`。
- E2E（含 fake server）：根目录 `tests/e2e/**`。
- 测试隔离：所有写文件系统的测试必须使用临时目录（`fs.mkdtempSync(os.tmpdir())`），并在 `afterEach` 清理。

### 0.5 安全与 secret

- 所有读取环境变量的代码集中在 `@issuepilot/core/config` 与 `@issuepilot/tracker-gitlab/auth`，禁止在其他模块直接 `process.env`。
- 任何事件、日志、API response 写入前都要经过 `redact()`（在 `observability/redact.ts` 实现），单元测试覆盖 token 类的关键字段。

### 0.6 文件结构总图（P0 完成时）

```text
.
├── apps/
│   ├── orchestrator/
│   │   ├── src/
│   │   │   ├── cli.ts                  # commander entrypoint
│   │   │   ├── main.ts                 # bootstrap daemon
│   │   │   ├── server/                 # Fastify HTTP + SSE
│   │   │   │   ├── index.ts
│   │   │   │   ├── routes.state.ts
│   │   │   │   ├── routes.runs.ts
│   │   │   │   └── routes.events.ts
│   │   │   ├── orchestrator/
│   │   │   │   ├── loop.ts             # poll/claim/dispatch loop
│   │   │   │   ├── claim.ts
│   │   │   │   ├── dispatch.ts
│   │   │   │   ├── reconcile.ts
│   │   │   │   └── retry.ts
│   │   │   └── runtime/                # 内存状态、并发槽位
│   │   ├── tests/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── dashboard/
│       ├── app/                        # Next.js App Router
│       │   ├── layout.tsx
│       │   ├── page.tsx                # 概览页
│       │   └── runs/[runId]/page.tsx   # Run 详情页
│       ├── components/
│       ├── lib/                        # API/SSE 客户端
│       ├── package.json
│       └── next.config.ts
├── packages/
│   ├── core/                           # 领域模型、调度合同、事件类型、Result 类型
│   ├── workflow/                       # .agents/workflow.md 解析、校验、渲染、hot reload
│   ├── tracker-gitlab/                 # Issue/MR/note/pipeline adapter（基于 @gitbeaker/rest）
│   ├── workspace/                      # bare mirror + worktree + hook 执行
│   ├── runner-codex-app-server/        # JSON-RPC client + 事件标准化
│   ├── observability/                  # event store、JSONL、pino logger、redact
│   └── shared-contracts/               # orchestrator <-> dashboard 类型
├── tests/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/
├── docs/
│   ├── superpowers/specs/2026-05-11-issuepilot-design.md
│   └── superpowers/plans/2026-05-11-issuepilot-implementation-plan.md
├── .agents/workflow.md                 # 示例配置
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── vitest.config.ts
├── eslint.config.mjs
├── .prettierrc
├── CHANGELOG.md
└── README.md
```

> `elixir/` 目录在 P0 期间继续保留作为参考，但不会被 Turborepo 构建图引用。

### 0.7 跨 Phase 依赖图

```text
Phase 1 (skeleton) ───┬──> Phase 2 (workflow)   ─┐
                      ├──> Phase 3 (gitlab)      ├──> Phase 6 (orchestrator)
                      ├──> Phase 4 (workspace)   ┤
                      └──> Phase 5 (codex runner)┘
                                                 └──> Phase 7 (dashboard) ──> Phase 8 (E2E + smoke)
```

每个 Phase 完成后运行 `pnpm -w turbo run test build` 并 commit；跨 Phase 不允许累积超过 1 个未通过测试。

---

## Phase 概览

| Phase | 里程碑 | 包 / App | 关键产出 |
|-------|--------|----------|----------|
| 1 | M1 Skeleton | repo 级 + 全部包占位 | 构建链路打通、契约类型就位 |
| 2 | M2 Workflow loader | `@issuepilot/workflow` | front matter 解析、校验、prompt 渲染、hot reload |
| 3 | M3 GitLab adapter | `@issuepilot/tracker-gitlab` | issue/label/note/MR/pipeline + 错误分类 |
| 4 | M4 Workspace | `@issuepilot/workspace` | bare mirror、worktree、分支、安全校验、hooks |
| 5 | M5 Codex runner | `@issuepilot/runner-codex-app-server` | JSON-RPC client、事件标准化、GitLab dynamic tools |
| 6 | M6 Orchestrator | `apps/orchestrator` | poll/claim/dispatch/reconcile/retry + Fastify API |
| 7 | M7 Dashboard | `apps/dashboard` | 概览 + Run 详情 + SSE timeline |
| 8 | M8 E2E + Smoke | `tests/e2e` | fake GitLab + fake Codex 全闭环 + 真实 smoke 指南 |

---

## Phase 1：TypeScript Monorepo Skeleton（M1）

**目标：** 打通构建/测试/类型/lint 链路；确立所有包的占位与公共契约类型。完成本 Phase 后，`pnpm -w turbo run build test typecheck lint` 全绿（即便包内只跑占位测试）。

### Task 1.1：初始化 pnpm workspace 与根配置

**Files：**
- Create: `package.json`（根）
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `.npmrc`（强制 `engine-strict=true`、`node-linker=isolated`）

**Step 1：写失败测试**

在根创建 `tests/integration/workspace.smoke.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { execaSync } from "execa";

describe("monorepo smoke", () => {
  it("pnpm -r exec node --version 在所有 workspace 都能跑", () => {
    const r = execaSync("pnpm", ["-r", "exec", "node", "--version"]);
    expect(r.exitCode).toBe(0);
  });
});
```

**Step 2：运行测试确认失败**

`pnpm -w test` → 失败（没有 vitest / 没有 workspace 配置）。

**Step 3：写最小实现**

`pnpm-workspace.yaml`：

```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "tests/*"
```

`package.json`（关键字段）：

```json
{
  "name": "issuepilot",
  "private": true,
  "packageManager": "pnpm@9",
  "engines": { "node": ">=22 <23" },
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test && pnpm test:smoke",
    "coverage": "pnpm --filter @issuepilot/workflow coverage && pnpm --filter @issuepilot/tracker-gitlab coverage",
    "typecheck": "turbo run typecheck",
    "lint": "turbo run lint",
    "test:smoke": "vitest run --config vitest.config.ts",
    "dev:orchestrator": "pnpm --filter @issuepilot/orchestrator dev",
    "dev:dashboard": "pnpm --filter @issuepilot/dashboard dev"
  },
  "devDependencies": {
    "turbo": "^2",
    "typescript": "^5.5",
    "vitest": "^2",
    "@vitest/coverage-v8": "^2",
    "eslint": "^9",
    "prettier": "^3"
  }
}
```

`turbo.json`：

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "test":      { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint":      {},
    "dev":       { "cache": false, "persistent": true }
  }
}
```

`tsconfig.base.json`：strict、`module: NodeNext`、`target: ES2023`、`moduleResolution: NodeNext`、`composite: true`、`declaration: true`。

**Step 4：运行测试确认通过**

`pnpm install && pnpm -w test` → smoke 测试通过。

**Step 5：commit**

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc tests
git commit -m "chore: bootstrap pnpm workspace with turborepo"
```

### Task 1.2：为 8 个包/2 个 app 创建占位

**Files：**
- Create: `packages/{core,workflow,tracker-gitlab,workspace,runner-codex-app-server,observability,shared-contracts}/package.json`
- Create: 上述每个包的 `src/index.ts`、`tsconfig.json`、`vitest.config.ts`
- Create: `packages/<pkg>/src/index.test.ts`（trivial 占位测试）
- Create: `apps/orchestrator/{package.json,tsconfig.json,src/index.ts}`
- Create: `apps/dashboard/{package.json,tsconfig.json,next.config.ts,app/page.tsx}`

每个 package 的 `package.json` 模板：

```json
{
  "name": "@issuepilot/<pkg>",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "coverage": "vitest run --coverage",
    "lint": "eslint src"
  }
}
```

**Step 1：写失败测试**

`packages/core/src/index.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import * as core from "./index";

it("@issuepilot/core 至少导出版本字符串", () => {
  expect(typeof core.VERSION).toBe("string");
});
```

**Step 2：失败**：`vitest` 报告 `VERSION` undefined。

**Step 3：实现** `src/index.ts`：

```ts
export const VERSION = "0.0.0";
```

每个包重复一遍。

**Step 4：通过：** `pnpm -w test`。

**Step 5：commit**：`chore: scaffold workspace packages and apps`。

### Task 1.3：引入 ESLint + Prettier + tsconfig 引用

**Files：**
- Create: `eslint.config.mjs`、`.prettierrc`、`.editorconfig`
- Modify：根 `package.json` 增加 `lint`/`format` scripts
- Modify：每个包 `tsconfig.json` 增加 `references` 指回依赖

**Step 1：写失败测试**

`tests/integration/lint.smoke.test.ts`：调用 `pnpm lint` 子进程，断言 `exitCode === 0` 且 stdout 不含 `error`。

**Step 2：失败**：未配置。

**Step 3：实现** ESLint flat config（`@typescript-eslint`、`eslint-plugin-import`），Prettier 标准配置（80 列、双引号、尾逗号 `all`）。

**Step 4：通过：** `pnpm -w lint test`。

**Step 5：commit**：`chore: configure eslint, prettier, tsconfig project references`。

### Task 1.4：定义 `@issuepilot/shared-contracts` 公共类型

**Files：**
- Create: `packages/shared-contracts/src/{events.ts,run.ts,state.ts,issue.ts,api.ts}`
- Create: `packages/shared-contracts/src/index.test.ts`

**关键接口（必须实现）：**

```ts
export type RunStatus =
  | "claimed" | "running" | "retrying"
  | "completed" | "failed" | "blocked";

export interface IssueRef {
  id: string;          // GitLab global id
  iid: number;
  title: string;
  url: string;
  projectId: string;
  labels: string[];
}

export interface RunRecord {
  runId: string;
  issue: IssueRef;
  status: RunStatus;
  attempt: number;
  branch: string;
  workspacePath: string;
  mergeRequestUrl?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  lastError?: { code: string; message: string };
}

export type EventType =
  | "run_started" | "claim_succeeded" | "claim_failed"
  | "workspace_ready" | "workspace_failed"
  | "session_started" | "turn_started" | "turn_completed"
  | "turn_failed" | "turn_cancelled" | "turn_timeout"
  | "tool_call_started" | "tool_call_completed" | "tool_call_failed"
  | "approval_required" | "approval_auto_approved" | "turn_input_required"
  | "notification" | "unsupported_tool_call" | "malformed_message"
  | "port_exit"
  | "gitlab_push" | "gitlab_mr_created" | "gitlab_mr_updated"
  | "gitlab_note_created" | "gitlab_note_updated"
  | "gitlab_labels_transitioned"
  | "reconciliation_started" | "reconciliation_completed"
  | "run_completed" | "run_failed" | "run_blocked"
  | "retry_scheduled";

export interface IssuePilotEvent {
  id: string;
  runId: string;
  issue: Pick<IssueRef, "id" | "iid" | "title" | "url" | "projectId">;
  type: EventType;
  message: string;
  threadId?: string;
  turnId?: string;
  data?: unknown;
  createdAt: string;
}

export interface OrchestratorStateSnapshot {
  service: {
    status: "starting" | "ready" | "degraded" | "stopping";
    workflowPath: string;
    gitlabProject: string;
    pollIntervalMs: number;
    concurrency: number;
    lastConfigReloadAt: string | null;
    lastPollAt: string | null;
  };
  summary: Record<RunStatus, number>;
}
```

**Step 1：写失败测试**

```ts
import { describe, it, expectTypeOf } from "vitest";
import type { RunRecord, IssuePilotEvent } from "./index";

it("RunRecord 至少包含 runId/issue/status", () => {
  expectTypeOf<RunRecord>().toHaveProperty("runId");
  expectTypeOf<IssuePilotEvent>().toHaveProperty("type");
});
```

**Step 2：失败**（类型未定义）。

**Step 3：实现**：补齐 `src/*.ts` 并 `export *` 到 `index.ts`。

**Step 4：通过**。

**Step 5：commit**：`feat(shared-contracts): define run/event/state interfaces`。

**Phase 1 验收：**

- [ ] `pnpm install` 成功，所有包就位。
- [ ] `pnpm -w turbo run build test typecheck lint` 全绿。
- [ ] `packages/shared-contracts` 导出 `RunRecord`、`IssuePilotEvent`、`OrchestratorStateSnapshot` 等核心类型。
- [ ] 根目录有 `.editorconfig`、`.prettierrc`、`eslint.config.mjs`、`turbo.json`。
- [ ] `apps/orchestrator` 与 `apps/dashboard` 都能跑 `pnpm --filter <app> build`。

---

## Phase 2：Workflow Loader（M2）

**目标：** 让 `@issuepilot/workflow` 能够解析 `.agents/workflow.md` front matter，渲染 prompt 模板，并实现 hot reload + last-known-good fallback。

### 接口契约（必须实现）

```ts
// packages/workflow/src/types.ts
export interface TrackerConfig {
  kind: "gitlab";
  baseUrl: string;
  projectId: string;
  tokenEnv: string;
  activeLabels: string[];       // 默认 ["ai-ready", "ai-rework"]
  runningLabel: string;         // 默认 "ai-running"
  handoffLabel: string;         // 默认 "human-review"
  failedLabel: string;          // 默认 "ai-failed"
  blockedLabel: string;         // 默认 "ai-blocked"
  reworkLabel: string;          // 默认 "ai-rework"
  mergingLabel: string;         // 默认 "ai-merging"
}

export interface WorkspaceConfig {
  root: string;                 // 默认 ~/.issuepilot/workspaces
  strategy: "worktree";         // P0 唯一值
  repoCacheRoot: string;        // 默认 ~/.issuepilot/repos
}

export interface GitConfig {
  repoUrl: string;
  baseBranch: string;           // 默认 "main"
  branchPrefix: string;         // 默认 "ai"
}

export interface AgentConfig {
  runner: "codex-app-server";
  maxConcurrentAgents: number;  // 默认 1
  maxTurns: number;             // 默认 10
  maxAttempts: number;          // 默认 2
  retryBackoffMs: number;       // 默认 30_000
}

export interface CodexConfig {
  command: string;              // 默认 "codex app-server"
  approvalPolicy: "never" | "untrusted" | "on-request";
  threadSandbox: "workspace-write" | "read-only" | "danger-full-access";
  turnTimeoutMs: number;        // 默认 3_600_000
  turnSandboxPolicy: { type: "workspaceWrite" | "readOnly" | "dangerFullAccess" };
}

export interface HooksConfig {
  afterCreate?: string;
  beforeRun?: string;
  afterRun?: string;
}

export interface WorkflowConfig {
  tracker: TrackerConfig;
  workspace: WorkspaceConfig;
  git: GitConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  hooks: HooksConfig;
  promptTemplate: string;       // Markdown body 原文
  source: { path: string; sha256: string; loadedAt: string };
}

export interface PromptContext {
  issue: {
    id: string; iid: number; identifier: string;
    title: string; description: string;
    labels: string[]; url: string;
    author: string; assignees: string[];
  };
  attempt: number;
  workspace: { path: string };
  git: { branch: string };
}

export interface WorkflowLoader {
  loadOnce(path: string): Promise<WorkflowConfig>;
  start(path: string): Promise<{ current(): WorkflowConfig; stop(): Promise<void> }>;
  render(template: string, ctx: PromptContext): string;
}
```

### Task 2.1：front matter + Markdown body 解析

**Files：**
- Create: `packages/workflow/src/parse.ts`
- Create: `packages/workflow/src/parse.test.ts`
- Create: `packages/workflow/tests/fixtures/workflow.valid.md`
- Create: `packages/workflow/tests/fixtures/workflow.missing-tracker.md`

**Step 1：写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { parseWorkflowFile } from "./parse";
import path from "node:path";

const fixture = (n: string) => path.join(__dirname, "../tests/fixtures", n);

describe("parseWorkflowFile", () => {
  it("解析合法 front matter 并返回 prompt body", async () => {
    const w = await parseWorkflowFile(fixture("workflow.valid.md"));
    expect(w.tracker.projectId).toBe("group/project");
    expect(w.git.baseBranch).toBe("main");
    expect(w.agent.maxConcurrentAgents).toBe(1);
    expect(w.promptTemplate).toMatch(/Issue: \{\{ issue.identifier \}\}/);
  });

  it("缺少 tracker 时抛 WorkflowConfigError 且包含字段路径", async () => {
    await expect(parseWorkflowFile(fixture("workflow.missing-tracker.md")))
      .rejects.toMatchObject({ name: "WorkflowConfigError", path: "tracker" });
  });
});
```

**Step 2：运行失败** → `parse.ts` 不存在。

**Step 3：实现**

依赖：`gray-matter`、`yaml`、`zod`。流程：

```ts
import matter from "gray-matter";
import YAML from "yaml";
import { z } from "zod";

const WorkflowSchema = z.object({
  tracker: z.object({
    kind: z.literal("gitlab"),
    base_url: z.string().url(),
    project_id: z.string().min(1),
    token_env: z.string().min(1),
    active_labels: z.array(z.string()).default(["ai-ready", "ai-rework"]),
    running_label: z.string().default("ai-running"),
    handoff_label: z.string().default("human-review"),
    failed_label: z.string().default("ai-failed"),
    blocked_label: z.string().default("ai-blocked"),
    rework_label: z.string().default("ai-rework"),
    merging_label: z.string().default("ai-merging"),
  }),
  workspace: z.object({
    root: z.string().default("~/.issuepilot/workspaces"),
    strategy: z.literal("worktree").default("worktree"),
    repo_cache_root: z.string().default("~/.issuepilot/repos"),
  }).default({} as any),
  git: z.object({
    repo_url: z.string().min(1),
    base_branch: z.string().default("main"),
    branch_prefix: z.string().default("ai"),
  }),
  agent: z.object({
    runner: z.literal("codex-app-server").default("codex-app-server"),
    max_concurrent_agents: z.number().int().min(1).default(1),
    max_turns: z.number().int().min(1).default(10),
    max_attempts: z.number().int().min(1).default(2),
    retry_backoff_ms: z.number().int().min(0).default(30_000),
  }).default({} as any),
  codex: z.object({
    command: z.string().default("codex app-server"),
    approval_policy: z.enum(["never","untrusted","on-request"]).default("never"),
    thread_sandbox: z.enum(["workspace-write","read-only","danger-full-access"])
      .default("workspace-write"),
    turn_timeout_ms: z.number().int().min(1_000).default(3_600_000),
    turn_sandbox_policy: z.object({
      type: z.enum(["workspaceWrite","readOnly","dangerFullAccess"])
        .default("workspaceWrite"),
    }).default({ type: "workspaceWrite" }),
  }).default({} as any),
  hooks: z.object({
    after_create: z.string().optional(),
    before_run: z.string().optional(),
    after_run: z.string().optional(),
  }).default({}),
});

export class WorkflowConfigError extends Error {
  override name = "WorkflowConfigError";
  constructor(message: string, public readonly path: string) { super(message); }
}
```

`parseWorkflowFile` 流程：
1. `fs.readFile(path)` → `gray-matter`（用 `engines.yaml = YAML`） 切分 front matter / body。
2. `WorkflowSchema.safeParse(data)` 失败 → `throw new WorkflowConfigError(issue.message, issue.path.join("."))`。
3. 将 snake_case 转 camelCase 输出（在转换层显式映射，不要使用通用工具，保持可读性）。
4. 计算 body 的 `sha256`。
5. `source = { path, sha256, loadedAt: new Date().toISOString() }`。

**Step 4：通过**：`pnpm --filter @issuepilot/workflow test`。

**Step 5：commit**：`feat(workflow): parse front matter into typed config`。

### Task 2.2：环境变量与 `~` 解析

**Files：**
- Create: `packages/workflow/src/resolve.ts`、`resolve.test.ts`

**目标：**

- `token_env: "GITLAB_TOKEN"` 在使用方（GitLab adapter）才解析为真实值；workflow 加载阶段只校验该 env name **存在于** `process.env`（缺失 → throw）。
- 所有路径字段中的 `~` 与 `$HOME` 替换为 `os.homedir()`，不允许其他 shell expansion。
- 提供独立 `resolveSecrets(cfg)`：返回不含 secret 的 `cfg`，调用方按需取。

**测试覆盖：** 缺失 env 抛 `WorkflowConfigError(path = "tracker.token_env")`；`~/foo` → `/Users/.../foo`；非字符串路径报错。

**commit：** `feat(workflow): resolve tilde paths and validate token env`。

### Task 2.3：Prompt 模板渲染

**Files：**
- Create: `packages/workflow/src/render.ts`、`render.test.ts`

**实现：** 使用 `liquidjs`，禁用文件系统加载（避免任意路径包含），开启 `strictFilters` + `strictVariables: false`（缺字段为空字符串）。

**测试覆盖：**

- `{{ issue.identifier }}` / `{{ issue.title }}` / `{{ workspace.path }}` / `{{ attempt }}` 全部支持。
- 未定义字段渲染为空串，并在日志（mock pino）记录 warn。
- 模板注入尝试（如 `{% include "../etc/passwd" %}`）报错或被禁用。

**commit：** `feat(workflow): render liquid prompt with whitelisted context`。

### Task 2.4：Hot Reload + Last-Known-Good

**Files：**
- Create: `packages/workflow/src/watch.ts`、`watch.test.ts`

**接口：**

```ts
export async function watchWorkflow(filePath: string, opts: {
  onReload: (cfg: WorkflowConfig) => void;
  onError: (err: WorkflowConfigError) => void;
  debounceMs?: number;          // 默认 250
}): Promise<{ current(): WorkflowConfig; stop(): Promise<void> }>;
```

行为：
- 启动时若解析失败 → reject 启动（caller 决定退出进程）。
- 运行期解析失败 → 不替换 `current()`；触发 `onError`，保留 last-known-good。
- 使用 `node:fs.watch` + `stat` 比较 mtime + sha256 去抖。
- `stop()` 关闭 watcher、清理 timer。

**测试覆盖：** 用 tmp 文件改写 front matter，断言 `current()` 切换；改坏后 `current()` 保留旧值并触发 onError；`stop()` 后无新事件。

**commit：** `feat(workflow): hot reload with last-known-good fallback`。

### Task 2.5：导出 Loader 工厂

**Files：**
- Modify：`packages/workflow/src/index.ts` 汇总导出
- Create：`packages/workflow/src/loader.test.ts`

`createWorkflowLoader()` 返回 `{ loadOnce, start, render }`。集成测试覆盖：fixture 文件 → `start()` → 修改 → `current()` 反映更新 → `stop()`。

**commit：** `feat(workflow): expose loader facade with start/loadOnce/render`。

**Phase 2 验收：**

- [ ] 合法 fixture 完整解析为 camelCase `WorkflowConfig`。
- [ ] 缺失字段抛 `WorkflowConfigError` 且 `path` 准确。
- [ ] Prompt 模板支持 spec §6 列出的所有变量。
- [ ] hot reload 在变更生效；解析失败时维持 last-known-good。
- [ ] 单测覆盖 ≥ 25 个 case；`vitest run --coverage` 在 `packages/workflow` line/statement ≥ 85%。

---

## Phase 3：GitLab Adapter（M3）

**目标：** 让 `@issuepilot/tracker-gitlab` 用 `@gitbeaker/rest` 实现 spec §11 列出的 9 个能力 + 错误分类，并暴露给后续 dispatcher 与 Codex dynamic tools。

### 接口契约

```ts
// packages/tracker-gitlab/src/types.ts
export type GitLabErrorCategory =
  | "auth"          // 401
  | "permission"    // 403
  | "not_found"     // 404
  | "validation"    // 422
  | "rate_limit"    // 429
  | "transient"     // 5xx / network
  | "unknown";

export class GitLabError extends Error {
  override name = "GitLabError";
  constructor(
    message: string,
    public readonly category: GitLabErrorCategory,
    public readonly status?: number,
    public readonly retriable?: boolean,
  ) { super(message); }
}

export interface GitLabAdapter {
  listCandidateIssues(opts: {
    activeLabels: string[];
    excludeLabels: string[];
    perPage?: number;
  }): Promise<IssueRef[]>;

  getIssue(iid: number): Promise<IssueRef & { description: string }>;

  transitionLabels(iid: number, opts: {
    add: string[];
    remove: string[];
    requireCurrent?: string[];       // 乐观锁：当前 issue 必须含这些 label
  }): Promise<{ labels: string[] }>;

  createIssueNote(iid: number, body: string): Promise<{ id: number }>;
  updateIssueNote(iid: number, noteId: number, body: string): Promise<void>;
  findWorkpadNote(iid: number, marker: string): Promise<{ id: number } | null>;

  createMergeRequest(input: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
    issueIid: number;
  }): Promise<{ id: number; iid: number; webUrl: string }>;
  updateMergeRequest(mrIid: number, input: Partial<{
    title: string; description: string; targetBranch: string;
  }>): Promise<void>;
  getMergeRequest(mrIid: number): Promise<{ iid: number; webUrl: string; state: string }>;
  listMergeRequestNotes(mrIid: number): Promise<Array<{ id: number; body: string; author: string }>>;

  getPipelineStatus(ref: string): Promise<"running" | "success" | "failed" | "pending" | "canceled" | "unknown">;
}
```

### Task 3.1：客户端工厂 + token 解析

**Files：**
- Create: `packages/tracker-gitlab/src/client.ts`、`client.test.ts`
- Create: `packages/tracker-gitlab/src/auth.ts`、`auth.test.ts`

**实现要点：**
- `createGitLabClient({ baseUrl, tokenEnv, projectId })`：从 `process.env[tokenEnv]` 取 token；缺失抛 `GitLabError(category="auth")`。
- token 不在 `toJSON()` / `inspect` / 日志中可读：`Object.defineProperty(client, "_token", { enumerable: false })`。
- 使用 `@gitbeaker/rest` 的 `Gitlab({ host, token })`；包装一层 `request<T>(fn): Promise<T>`，统一映射 HTTP 错误到 `GitLabError`。

**测试：** 用 `msw` 或 `undici.MockAgent` 拦截 HTTP；覆盖 401/403/404/422/429/500/503 → 对应 category。

**commit：** `feat(tracker-gitlab): client factory with classified errors`。

### Task 3.2：候选 Issue 拉取 + 排序

**Files：**
- Create: `packages/tracker-gitlab/src/issues.ts`、`issues.test.ts`

**实现：**

```ts
async listCandidateIssues({ activeLabels, excludeLabels, perPage = 50 }) {
  const issues = await this.api.Issues.all({
    projectId: this.projectId,
    state: "opened",
    labels: activeLabels.join(","),
    perPage,
    orderBy: "updated_at",
    sort: "asc",
  });
  return issues
    .filter(i => !excludeLabels.some(l => i.labels.includes(l)))
    .map(toIssueRef);
}
```

排序：`priority desc` → `updated_at asc` → `iid asc`（在调用方 orchestrator 里再次稳定排序）。

**测试：** mock 返回 6 条带不同 label，断言被排除项被过滤、字段映射准确。

**commit：** `feat(tracker-gitlab): list candidate issues with exclude filter`。

### Task 3.3：Label 状态机迁移（乐观并发）

**Files：**
- Create: `packages/tracker-gitlab/src/labels.ts`、`labels.test.ts`

**实现：**
1. 调用 `Issues.show(projectId, iid)` 读取当前 labels。
2. 若 `requireCurrent` 中任意 label 不存在 → 抛 `GitLabError("validation", 409, retriable=false)`，message `claim_conflict`。
3. 计算 `next = (current \ remove) ∪ add`。
4. `Issues.edit(projectId, iid, { labels: next.join(",") })`。
5. 再次 `Issues.show` 确认，最终 labels 包含 `add` 且不包含 `remove` 才视为成功；否则同样抛 `claim_conflict`。

**测试覆盖：** 普通迁移成功；并发同一 issue 时第二次抛 `claim_conflict`；网络 5xx 抛 `transient`（retriable）。

**commit：** `feat(tracker-gitlab): label transition with optimistic claim`。

### Task 3.4：Issue Note workpad

**Files：**
- Create: `packages/tracker-gitlab/src/notes.ts`、`notes.test.ts`

**实现：**
- 所有 IssuePilot 写出的 note 第一行必须以 `<!-- issuepilot:run=<runId> -->` 开头作为 marker。
- `findWorkpadNote(iid, marker)` 拉取 issue notes 列表（系统 note 排除），匹配前缀。
- 同一 run 复用 note，调用 `updateIssueNote`；不同 run 创建新 note。

**测试：** 已存在 marker note → update；不存在 → create；marker 不匹配 → 不动现有 note。

**commit：** `feat(tracker-gitlab): persistent workpad note operations`。

### Task 3.5：Merge Request CRUD + pipeline 状态

**Files：**
- Create: `packages/tracker-gitlab/src/merge-requests.ts`、`merge-requests.test.ts`
- Create: `packages/tracker-gitlab/src/pipelines.ts`、`pipelines.test.ts`

**实现：**
- `createMergeRequest`：若同 sourceBranch + state=opened 的 MR 已存在 → 返回现有 MR（不报错）。
- `updateMergeRequest`：单字段可选，跳过未提供项。
- `getPipelineStatus(ref)`：取 `Pipelines.all({ ref, perPage: 1, orderBy: "updated_at" })` 的最新一条；空数组 → `"unknown"`。

**测试：** 覆盖已存在 MR、target branch 缺省回退、pipeline 各种 status 映射。

**commit：** `feat(tracker-gitlab): merge request CRUD and pipeline status`。

### Task 3.6：契约导出 + 公共类型

**Files：**
- Modify：`packages/tracker-gitlab/src/index.ts`

导出 `GitLabAdapter`、`GitLabError`、`createGitLabAdapter()`。

**commit：** `feat(tracker-gitlab): expose adapter facade`。

**Phase 3 验收：**

- [ ] 9 个 `GitLabAdapter` 方法全部实现 + 单测。
- [ ] HTTP 错误正确分类为 `auth/permission/not_found/validation/rate_limit/transient`。
- [ ] token 在序列化和日志中不可见（专项测试断言 `JSON.stringify(adapter)` 不含 token）。
- [ ] 包覆盖率 ≥ 85%。

---

## Phase 4：Workspace Manager（M4）

**目标：** 实现 spec §9 描述的 bare mirror + git worktree 模型，并执行 workflow 中的 hooks。

### 接口契约

```ts
// packages/workspace/src/types.ts
export interface WorkspaceManager {
  ensureMirror(input: {
    repoUrl: string;
    projectSlug: string;
    repoCacheRoot: string;
  }): Promise<{ mirrorPath: string }>;

  ensureWorktree(input: {
    mirrorPath: string;
    projectSlug: string;
    issueIid: number;
    titleSlug: string;
    baseBranch: string;
    branchPrefix: string;
    workspaceRoot: string;
  }): Promise<{ workspacePath: string; branch: string; reused: boolean }>;

  runHook(input: {
    cwd: string;
    name: "after_create" | "before_run" | "after_run";
    script: string | undefined;
    env: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{ skipped: boolean; exitCode?: number; stdout: string; stderr: string }>;

  cleanupOnFailure(input: { workspacePath: string }): Promise<void>;
}
```

### Task 4.1：路径安全工具

**Files：**
- Create: `packages/workspace/src/paths.ts`、`paths.test.ts`

**函数：**
- `slugify(input: string, maxLen = 40): string`：仅保留 `[a-z0-9-]`，多个连字符合并，首尾去 `-`，空串返回 `untitled`。
- `assertWithinRoot(child, root)`：用 `fs.realpath` canonicalize，若 child 不在 root 之下抛 `WorkspacePathError`。
- `branchName({ prefix, iid, titleSlug })`：返回 `${prefix}/${iid}-${titleSlug}`，并校验长度 ≤ 200、不含 `..`。

**测试：** symlink escape、中文标题、过长输入、保留字符 (`..`, `:`, `~`)。

**commit：** `feat(workspace): path safety and branch sanitizer`。

### Task 4.2：bare mirror 管理

**Files：**
- Create: `packages/workspace/src/mirror.ts`、`mirror.test.ts`

**实现（execa）：**

```ts
async ensureMirror({ repoUrl, projectSlug, repoCacheRoot }) {
  const mirrorPath = path.join(expandHome(repoCacheRoot), `${projectSlug}.git`);
  await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
  const exists = await stat(mirrorPath).catch(() => null);
  if (!exists) {
    await execa("git", ["clone", "--mirror", repoUrl, mirrorPath]);
  } else {
    await execa("git", ["--git-dir", mirrorPath, "fetch", "--prune", "origin"]);
  }
  return { mirrorPath };
}
```

**测试：** 用本地 `git init --bare` + `git daemon` 不现实，使用临时目录里另一个普通 repo 作为 `repoUrl=file://...`；覆盖 first clone、第二次 fetch、网络失败抛错。

**commit：** `feat(workspace): ensure bare mirror via execa`。

### Task 4.3：worktree 创建与复用

**Files：**
- Create: `packages/workspace/src/worktree.ts`、`worktree.test.ts`

**实现要点：**
- 路径 `path.join(workspaceRoot, projectSlug, String(issueIid))`，先 `assertWithinRoot`。
- 不存在：`git --git-dir <mirror> worktree add <ws> -B <branch> origin/<baseBranch>`。
- 存在：
  1. `git -C <ws> rev-parse --is-inside-work-tree` 必须为 `true`。
  2. `git -C <ws> remote get-url origin` 与 mirror 一致（或为 alternates）。
  3. `git -C <ws> symbolic-ref --short HEAD` 必须等于预期 branch。
  4. `git -C <ws> fetch origin` + `git -C <ws> reset --hard origin/<branch>` 仅在状态干净时执行；脏工作区 → 抛 `WorkspaceDirtyError`，caller 触发 reconciliation 失败。

**测试：** first run reused=false；second run reused=true；脏 worktree 抛错；不一致 origin 抛错。

**commit：** `feat(workspace): worktree create-or-reuse with safety checks`。

### Task 4.4：hook 执行

**Files：**
- Create: `packages/workspace/src/hooks.ts`、`hooks.test.ts`

**实现：** 用 `execa("bash", ["-lc", script], { cwd, env, timeout })`；超时默认 600_000ms；空 `script` → `skipped: true`。stdout/stderr 限制大小（每个 1MB，超出截断并标 `[truncated]`）。

**测试：** 成功；非零退出 → 抛 `HookFailedError`；超时；空脚本。

**commit：** `feat(workspace): execute hooks with timeout and size cap`。

### Task 4.5：失败保留 + cleanup

**Files：**
- Create: `packages/workspace/src/cleanup.ts`、`cleanup.test.ts`

**实现：**
- `cleanupOnFailure({ workspacePath })`：**不删除** 文件，仅创建 `.issuepilot/failed-at-<isoDate>` 文件并写入失败上下文。这与 spec §9 "失败 workspace 保留供排障" 一致。
- 提供独立 `pruneWorktree({ mirrorPath, workspacePath, branch })`：仅在 P1 使用，P0 暂不调用。

**commit：** `feat(workspace): mark workspace failure for forensics`。

### Task 4.6：导出 facade

**Files：**
- Modify：`packages/workspace/src/index.ts`

**commit：** `feat(workspace): expose workspace manager facade`。

**Phase 4 验收：**

- [ ] bare mirror + worktree 在 tmp 仓库的集成测试可重复跑通 ≥ 5 次。
- [ ] 所有路径强制 canonicalize；越界写入抛错。
- [ ] hook 失败、超时、空脚本三种 case 均有测试。
- [ ] 失败 workspace 不被删除，会留下 `.issuepilot/failed-at-*`。

---

## Phase 5：Codex App-Server Runner（M5）

**目标：** 在 issue worktree 内启动 `codex app-server`，按 JSON-RPC 协议管理 `initialize → initialized → thread/start → turn/start → …`，把 spec §10 列出的事件标准化成 `IssuePilotEvent`，并提供 spec §11 列出的 GitLab dynamic tools。

### 接口契约

```ts
// packages/runner-codex-app-server/src/types.ts
export interface RunnerInput {
  cwd: string;                          // issue worktree
  command: string;                      // e.g. "codex app-server"
  codex: CodexConfig;
  agent: Pick<AgentConfig, "maxTurns">;
  prompt: string;
  title: string;
  tools: ToolDefinition[];              // GitLab dynamic tools
  context: { runId: string; issue: IssueRef; threadName: string };
  onEvent: (e: IssuePilotEvent) => void;
}

export interface RunnerOutcome {
  status: "completed" | "failed" | "blocked" | "cancelled" | "timeout";
  turnsUsed: number;
  lastTurnId?: string;
  threadId?: string;
  failureReason?: string;
}

export interface ToolDefinition {
  name: string;                         // gitlab_get_issue 等
  description: string;
  inputSchema: object;                  // JSON schema
  handler: (args: unknown) => Promise<unknown>;
}

export interface CodexRunner {
  run(input: RunnerInput): Promise<RunnerOutcome>;
}
```

### Task 5.1：JSON-RPC stdio client

**Files：**
- Create: `packages/runner-codex-app-server/src/rpc.ts`、`rpc.test.ts`

**实现：**
- `spawnRpc({ command, cwd })`：用 `execa.command(command, { cwd, buffer: false, stdio: ["pipe","pipe","pipe"] })`。
- 解析 stdout：newline-delimited JSON。维护待响应 map `id -> resolve/reject`。
- 提供：`request<T>(method, params): Promise<T>`、`notify(method, params)`、`onNotification(handler)`、`onMalformed(handler)`、`close()`、`waitExit(): Promise<{ code: number; signal: string | null }>`。

**测试：** 启动一个 Node 子进程当 fake server，验证 request/notify、malformed JSON 走 onMalformed、子进程退出后 pending request reject。

**commit：** `feat(runner): newline-delimited JSON-RPC stdio client`。

### Task 5.2：生命周期编排

**Files：**
- Create: `packages/runner-codex-app-server/src/lifecycle.ts`、`lifecycle.test.ts`

**实现 Step：**

1. `request("initialize", { client: { name, version }, capabilities: {...} })`。
2. `notify("initialized")`。
3. `request("thread/start", { name, cwd, sandbox: { type: codex.threadSandbox }, approvalPolicy: codex.approvalPolicy, tools: tools.map(toSchema) })` → 取 `threadId`。
4. 循环 `maxTurns` 次：
   - `request("turn/start", { threadId, prompt, title, cwd, sandboxPolicy: codex.turnSandboxPolicy })` → 取 `turnId`。
   - 阻塞直到收到该 `turnId` 对应的 `turn/completed | turn/failed | turn/cancelled | turn/timeout` 通知（用 `pTimeout` 包裹 `codex.turnTimeoutMs`）。
   - 如果 agent 通过工具调用更新了状态且 `turn/completed` 中标明 stop，则跳出循环。
5. 任何阶段抛错或子进程退出 → 收集 `RunnerOutcome` 并触发 `port_exit` 事件。

**测试：** 用脚本驱动 fake server，覆盖 spec §10 列出的 14 个事件类型逐一发出，断言 `onEvent` 顺序正确；超时与 cancel 路径独立测试。

**commit：** `feat(runner): drive thread/turn lifecycle with timeouts`。

### Task 5.3：事件标准化

**Files：**
- Create: `packages/runner-codex-app-server/src/events.ts`、`events.test.ts`

**实现：** 接收 app-server notification（`turn/notification`、`tool/started`、`tool/completed` 等）并转换为 `IssuePilotEvent`（types 来自 `@issuepilot/shared-contracts`）。所有事件挂上 `runId / issue / threadId / turnId / createdAt`，并经过 `observability/redact`（在 Phase 6 接线）。

**测试覆盖：**

- `notification` → `notification` event。
- `tool/started` 已知工具 → `tool_call_started`；未知工具 → `unsupported_tool_call` + 立即返回 fast-fail tool result。
- `approval/request` 在 `approvalPolicy === "never"` 时回 `approved=true` 并发 `approval_auto_approved`。
- `turn/input_required` 自动发出 spec §10 末尾给出的 non-interactive 回复。
- 不能解析的 line → `malformed_message`。

**commit：** `feat(runner): normalize app-server notifications into events`。

### Task 5.4：GitLab dynamic tools

**Files：**
- Create: `packages/runner-codex-app-server/src/tools/gitlab.ts`、`gitlab.test.ts`

**实现：** 接收一个 `GitLabAdapter` 实例 + `IssueRef`，导出 spec §11 列出的 9 个 `ToolDefinition`。每个 tool 的 `handler`：

- 校验参数（zod）。
- 调用 adapter 方法。
- 成功返回 `{ ok: true, data: ... }`。
- 失败返回 `{ ok: false, error: { category, message } }`（不抛错，避免让 runner 崩）。
- 写操作必须发 `gitlab_*` 事件（注入 `onEvent` 回调）。

**测试：** 每个 tool 至少 1 个 happy + 1 个 error case；token 不进入 args / response。

**commit：** `feat(runner): expose allowlisted GitLab dynamic tools`。

### Task 5.5：Runner facade

**Files：**
- Modify：`packages/runner-codex-app-server/src/index.ts`

`createCodexRunner({ gitlab, observability }) → CodexRunner`，封装 5.1-5.4。

**commit：** `feat(runner): expose codex runner facade`。

**Phase 5 验收：**

- [ ] 完整生命周期 + 14 个标准化事件全部测试通过。
- [ ] approval/input/超时/port exit 都有覆盖。
- [ ] 不支持的 tool 触发 `unsupported_tool_call` 且 runner 继续，无静默卡顿。
- [ ] token redact 在 fake adapter 测试中验证。

---

## Phase 6：Orchestrator（M6）

**目标：** 把 Phase 2–5 组合成 spec §8 的主循环：reload → reconcile → poll → claim → workspace → hooks → runner → post-run reconciliation → labels/notes → retry。提供 spec §15 的本地 API。

### Task 6.1：内存运行时与并发槽位

**Files：**
- Create: `apps/orchestrator/src/runtime/state.ts`、`state.test.ts`
- Create: `apps/orchestrator/src/runtime/slots.ts`、`slots.test.ts`

**实现：**
- `RuntimeState`：`Map<runId, RunRecord>`、当前 workflow 引用、`lastConfigReloadAt`、`lastPollAt`。
- `ConcurrencySlots(max)`：`tryAcquire(runId)`、`release(runId)`、`active()`。
- `summary()` → `OrchestratorStateSnapshot["summary"]`。

**测试：** 多并发申请、释放、统计。

**commit：** `feat(orchestrator): runtime state and concurrency slots`。

### Task 6.2：候选选取 + 认领

**Files：**
- Create: `apps/orchestrator/src/orchestrator/claim.ts`、`claim.test.ts`

**实现：**
1. `gitlab.listCandidateIssues({ activeLabels, excludeLabels: [running, handoff, failed, blocked] })`。
2. 按 `priority desc → updatedAt asc → iid asc` 稳定排序。
3. 槽位足够时取 N 个；逐个调用 `gitlab.transitionLabels(iid, { add: [running], remove: activeLabels, requireCurrent: [matchedActiveLabel] })`。
4. 冲突或失败 → 跳过；成功 → 创建 `RunRecord(status="claimed", attempt=1)` 写入 state。

**测试：** 并发 claim 冲突；空候选；只用部分槽位。

**commit：** `feat(orchestrator): claim candidates with optimistic labels`。

### Task 6.3：dispatch（workspace → hooks → runner）

**Files：**
- Create: `apps/orchestrator/src/orchestrator/dispatch.ts`、`dispatch.test.ts`

**Step：**

```
RunRecord.status: claimed
 -> ensureMirror
 -> ensureWorktree
 -> hooks.afterCreate (仅首次)
 -> hooks.beforeRun
 -> render prompt
 -> runner.run(...)
 -> hooks.afterRun (即便失败也跑，记录失败)
 -> reconcile（Task 6.4）
```

每一步落 event。任意步骤抛错 → 走 6.5 的失败分类。

**测试（基于 fakes）：** 完整 happy path；afterCreate 失败 → run_failed；prompt 渲染失败 → run_failed。

**commit：** `feat(orchestrator): dispatch run through workspace and runner`。

### Task 6.4：Post-run reconciliation

**Files：**
- Create: `apps/orchestrator/src/orchestrator/reconcile.ts`、`reconcile.test.ts`

**实现 spec §12：**

1. 工作区是否有 commit（`git -C ws log -1 origin/<base>..HEAD --format=%H`，空 → 无 commit）。
2. 本地 branch 是否存在。
3. push 到 origin（若 agent 未 push），并发出 `gitlab_push`。
4. 是否存在 MR（按 source branch 查询），若无则 `createMergeRequest` 并发出 `gitlab_mr_created`；若存在 → `updateMergeRequest`（title/body 改变时）并发出 `gitlab_mr_updated`。
5. workpad note：若不存在 → 创建 fallback note（包含 spec §12 列出的 5 个字段）；若存在 → 仅在新增内容时 update。
6. labels：把 `running` 改为 `handoff`，发出 `gitlab_labels_transitioned`。

**fallback MR body 模板：**

```
Issue: {issue.url}

## Implementation summary
{agent.summary || "Codex completed without a structured summary; see commits."}

## Validation
{agent.validation || "(no validation summary)"}

## Risks
{agent.risks || "(none reported)"}

---
Generated by IssuePilot for {issue.identifier}, attempt {attempt}.
```

**测试：** 7 种缺失组合（无 commit / 无 push / 无 MR / MR 过期 / 无 note / 无 label 切换 / 全缺）。

**commit：** `feat(orchestrator): deterministic post-run reconciliation`。

### Task 6.5：错误分类 + retry

**Files：**
- Create: `apps/orchestrator/src/orchestrator/classify.ts`、`classify.test.ts`
- Create: `apps/orchestrator/src/orchestrator/retry.ts`、`retry.test.ts`

**实现：** 把任意抛错（`GitLabError` / `WorkspacePathError` / `WorkspaceDirtyError` / `HookFailedError` / runner `RunnerOutcome.status`）按 spec §13 三分：

```ts
type Classification = { kind: "blocked" | "failed" | "retryable"; reason: string; code: string };
```

retry 策略：`attempt < maxAttempts && kind === "retryable"` → `retry_scheduled` 事件，`setTimeout(retryBackoffMs)` 后把 issue 重新塞回队列（重置 status="retrying"，attempt++）。

最终失败：`failed/blocked` → 写 fallback note（包含 attempt、错误码、原始消息 redacted、最近 5 条事件），切换对应 label。

**测试：** 每种错误源各一条测试 →  正确 kind；重试到达上限后转 failed；blocked 路径不重试。

**commit：** `feat(orchestrator): classify errors and schedule retries`。

### Task 6.6：主循环 + reload

**Files：**
- Create: `apps/orchestrator/src/orchestrator/loop.ts`、`loop.test.ts`

**实现：**

```ts
export async function startLoop(deps): Promise<{ stop: () => Promise<void> }> {
  const tick = async () => {
    const cfg = workflow.current();
    state.lastPollAt = nowIso();
    await reconcileRunning(state, deps);     // 重启后的兜底
    if (slots.available() === 0) return;
    const candidates = await claim(cfg, deps, slots);
    for (const r of candidates) dispatch(r, cfg, deps).finally(() => slots.release(r.runId));
  };
  const timer = setInterval(() => tick().catch(logError), cfg.poll_interval_ms ?? 10_000);
  return { stop: async () => { clearInterval(timer); await state.drain(); } };
}
```

`reconcileRunning`：重启后扫描所有 `ai-running` 的 issue（按 workpad note marker 匹配 runId），决定是 resume reconciliation 还是回滚到 `ai-rework`（具体策略：本机有 worktree → resume；否则把 label 改回首个 active label + 写 system note "previous run lost"）。

**测试：** 启动两个 tick → 候选耗尽；reload 切换 workflow → 下一 tick 用新 config；并发 stop。

**commit：** `feat(orchestrator): main loop with reload and reconcile-on-start`。

### Task 6.7：Fastify HTTP + SSE

**Files：**
- Create: `apps/orchestrator/src/server/index.ts`、`routes.*.ts`、`server.test.ts`

**路由：**

- `GET /api/state` → `OrchestratorStateSnapshot`。
- `GET /api/runs?status=&limit=` → `RunRecord[]`。
- `GET /api/runs/:runId` → `RunRecord & { events: IssuePilotEvent[]; logsTail: string[] }`。
- `GET /api/events?runId=` → `IssuePilotEvent[]`（分页）。
- `GET /api/events/stream` → `text/event-stream`，订阅 EventBus（`@issuepilot/observability`）；支持 `runId` 过滤。

**实现要点：**
- 默认绑定 `127.0.0.1`，端口来自 CLI `--port`。
- 全局 `onResponse` 中间件：在 reply body 序列化前调用 `redact()`。
- SSE：在 connection close 时清理订阅；定期发 `: keepalive\n\n`。

**测试：** supertest 风格用 `fastify.inject`；SSE 单测用 `eventsource-parser`。

**commit：** `feat(orchestrator): fastify HTTP API and SSE stream`。

### Task 6.8：CLI（`issuepilot run|validate|doctor`）

**Files：**
- Create: `apps/orchestrator/src/cli.ts`、`cli.test.ts`

`commander`：

```
issuepilot run        --workflow <path> --port <n>
issuepilot validate   --workflow <path>
issuepilot doctor     --workflow <path>
```

- `validate`：调 `workflow.loadOnce()` + 一次 `gitlab.getIssue(0)` 探测 token（捕获 not_found 视为可达）。
- `doctor`：依次检查 Node 版本、git CLI、`codex app-server --version`、`~/.issuepilot/state` 可写权限。

**测试：** 用 vitest + `commander` 的程序化调用。

**commit：** `feat(orchestrator): cli entry with run/validate/doctor`。

**Phase 6 验收：**

- [ ] `pnpm dev:orchestrator` 能启动，访问 `/api/state` 返回快照。
- [ ] 全部错误分类与 retry 路径覆盖在单测中。
- [ ] reconcile 兜底逻辑覆盖 spec §12 全部 7 个 case。
- [ ] CLI 三命令均有冒烟测试。

---

## Phase 6.x：Observability 包（与 Phase 6 并行交付）

> Phase 6 的 retry/reconcile/SSE 都依赖 `@issuepilot/observability`。建议在 Phase 6 内或 6 开始前把这个包闭环。

**Files：**
- `packages/observability/src/redact.ts`、`redact.test.ts`：基于 secret 字段名列表 + 已知 token 模式（GitLab PAT/Group token）做替换。
- `packages/observability/src/event-bus.ts`、`event-bus.test.ts`：内存 pub/sub，支持过滤函数。
- `packages/observability/src/event-store.ts`、`event-store.test.ts`：JSONL append-only；按 `<projectSlug>-<issueIid>.jsonl` 切文件；提供 `read(runId, { limit, offset })`。
- `packages/observability/src/run-store.ts`、`run-store.test.ts`：`runs/<projectSlug>-<issueIid>.json` 写入 + 原子重命名（写到 `.tmp` → `fs.rename`）。
- `packages/observability/src/logger.ts`：`pino` factory，自动注入 `runId/issueIid`，结构化 stdout + 滚动文件 `~/.issuepilot/state/logs/issuepilot.log`。

**测试覆盖：** redact 至少 5 个 token 模式；event-bus 多订阅者 + unsubscribe；store 在并发写 100 条 event 时不丢、不撕裂。

**commit（按子模块）：**
- `feat(observability): redact secrets in events and logs`
- `feat(observability): in-memory event bus`
- `feat(observability): append-only event store`
- `feat(observability): atomic run record store`
- `feat(observability): pino logger with run context`

---

## Phase 7：Dashboard（M7）

**目标：** 仅读 `apps/orchestrator` 的 API，按 spec §14 渲染三组视图：Service header / Summary / Runs。Run 详情页提供 timeline、tool calls、最近日志。

### Task 7.1：Next.js 脚手架 + Tailwind/shadcn

**Files：**
- Modify: `apps/dashboard/package.json`：`next`、`react`、`tailwindcss`、`@radix-ui/*`、`shadcn-ui` 相关
- Create: `apps/dashboard/{app/layout.tsx, app/globals.css, tailwind.config.ts, postcss.config.mjs}`
- Create: `apps/dashboard/components/ui/{button,card,table,badge}.tsx`（从 shadcn 生成）

**Step：** 跑通 `pnpm --filter @issuepilot/dashboard dev` 打开默认页。
**commit：** `feat(dashboard): nextjs app with tailwind and shadcn primitives`。

### Task 7.2：API 客户端 + SSE hook

**Files：**
- Create: `apps/dashboard/lib/api.ts`、`api.test.ts`
- Create: `apps/dashboard/lib/use-event-stream.ts`、`use-event-stream.test.ts`

**实现：**
- `apiGet<T>(path): Promise<T>` 默认连 `process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:4738"`。
- `useEventStream(runId?: string)`：用 `EventSource`，在 unmount 关闭；指数退避重连。

**测试：** vitest + `msw` mock REST；SSE 用 fake EventSource。

**commit：** `feat(dashboard): typed api client and event stream hook`。

### Task 7.3：概览页（`/`）

**Files：**
- Create: `apps/dashboard/app/page.tsx`
- Create: `apps/dashboard/components/{service-header,summary-cards,runs-table}.tsx`

**实现：**
- Service header：`GET /api/state` 中的字段。
- Summary：`summary` 计数卡片。
- Runs table：`GET /api/runs?status=running,retrying,blocked,failed,human-review&limit=50`，列：iid、title、labels、status、turn count、last event、elapsed、branch、MR、workspace path。
- 表头组件 `aria-sort` 支持点击排序（前端排序即可）。
- 自动刷新：`useEventStream()` 收到 `run_*` 事件触发 re-fetch（节流 1s）。

**测试：** `@testing-library/react` + `vitest`。

**commit：** `feat(dashboard): overview page with service header and runs table`。

### Task 7.4：Run 详情页（`/runs/[runId]`）

**Files：**
- Create: `apps/dashboard/app/runs/[runId]/page.tsx`
- Create: `apps/dashboard/components/{event-timeline,tool-call-list,log-tail}.tsx`

**实现：**
- 顶部展示 issue 基本信息、当前 label、MR 链接、attempt、状态、错误原因。
- Timeline：按 `createdAt` 升序，event type 用 Badge 区分颜色；展开节点显示 redacted `data`。
- Tool calls 列表：过滤 `tool_call_*`。
- Logs tail：从 `/api/runs/:runId` 中的 `logsTail`，无需轮询。
- `useEventStream(runId)`：实时追加事件。

**测试：** 渲染快照 + 事件追加交互。

**commit：** `feat(dashboard): run detail page with live timeline`。

**Phase 7 验收：**

- [ ] `pnpm --filter @issuepilot/dashboard build` 通过且不发出 client/server boundary 错误。
- [ ] 概览页与详情页在 mock API 下能正常渲染。
- [ ] SSE 重连在网络抖动下生效（测试触发 close → 自动 reconnect）。
- [ ] 任何展示 token 的字段均经过 redact（专项测试）。

---

## Phase 8：端到端验证（M8）

**目标：** 提供 fake GitLab + fake Codex app-server 的全闭环 E2E，并产出真实 GitLab 项目的人工 smoke 指南。

### Task 8.1：fake GitLab server

**Files：**
- Create: `tests/e2e/fakes/gitlab/server.ts`、`server.test.ts`
- Create: `tests/e2e/fakes/gitlab/data.ts`（内存表：issues / notes / merge_requests / pipelines）

**实现：** Fastify 实例，实现 `@gitbeaker/rest` 用到的最小端点子集；提供 `seed({ project, issues })`、`getState()`、`waitFor(predicate, timeoutMs)` 测试辅助。

**commit：** `test(e2e): fake gitlab server with stateful endpoints`。

### Task 8.2：fake Codex app-server

**Files：**
- Create: `tests/e2e/fakes/codex/main.ts`、`script.ts`

**实现：** 一个独立 Node 程序读取 stdin newline JSON、写 stdout。根据 `IPILOT_FAKE_SCRIPT` env 指向的 JSON 脚本依次发出事件、消费请求。脚本 schema：

```jsonc
[
  { "expect": "initialize" },
  { "respond": { "result": { "serverInfo": {...} } } },
  { "expect": "thread/start", "respond": { "result": { "threadId": "t1" } } },
  { "expect": "turn/start",   "respond": { "result": { "turnId": "u1" } } },
  { "notify": "turn/notification", "params": {...} },
  { "tool_call": { "name": "gitlab_create_issue_note", "args": {...} } },
  { "notify": "turn/completed", "params": { "turnId": "u1", "stop": true } }
]
```

**commit：** `test(e2e): scriptable fake codex app-server`。

### Task 8.3：闭环 E2E

**Files：**
- Create: `tests/e2e/happy-path.test.ts`
- Create: `tests/e2e/fixtures/workflow.fake.md`

**测试断言：** spec §18.2 列出的 7 个步骤：

```text
1. fake GitLab seed 一个 ai-ready issue
2. orchestrator.run() 拾取该 issue
3. workspace 创建 worktree（在 tmp 仓库上）
4. fake Codex 发出 tool calls + turn/completed
5. fake GitLab 状态：branch 已 push + MR 已建 + note 已写 + label = human-review
6. /api/runs/:runId 状态为 completed
7. JSONL event store 包含 spec §10 全部相关事件类型
```

**实现要点：** 不启动真实 Next.js dashboard，仅校验 orchestrator HTTP API；测试启动/关闭都用 helpers 函数，保证退出干净。

**commit：** `test(e2e): full happy path with fakes`。

### Task 8.4：失败路径 E2E

**Files：**
- Create: `tests/e2e/blocked-and-failed.test.ts`

**场景：**
- fake Codex 发 `turn/failed` → 期望 label 切到 `ai-failed`，workpad 写入失败原因，retry 1 次仍失败。
- fake GitLab 返回 403 → 期望 label 切到 `ai-blocked` 且不重试。
- fake Codex 在 `approval_policy=never` 下请求人工审批 → 期望自动 approve 并发出 `approval_auto_approved`。

**commit：** `test(e2e): blocked and failed classification paths`。

### Task 8.5：真实 smoke 指南 + `pnpm smoke`

**Files：**
- Create: `docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`
- Create: `scripts/smoke.ts`（CLI 包装：本地启动 orchestrator + 校验 `/api/state` 返回 `service.status === "ready"`，并提示用户在浏览器打开 dashboard）

**Runbook 必须包含：** 创建一次性 GitLab 测试项目、Group Access Token、配置 `.agents/workflow.md`、添加 `ai-ready`、启动 IssuePilot、对照 spec §18.3 的 10 个验收点逐一勾选。

**commit：** `docs(superpowers): real gitlab smoke runbook and pnpm smoke wrapper`。

**Phase 8 验收：**

- [ ] `pnpm -w turbo run test` 包含 `tests/e2e` 全部用例并全绿。
- [ ] happy-path 测试在 CI 中执行时间 ≤ 30s。
- [ ] runbook 任意工程师按指南可在 < 30 分钟完成首次真实 smoke。
- [ ] 失败 / blocked 路径的事件、label、note 均有断言。

---

## MVP Definition of Done（与 spec §21 对齐）

实施完成时，对照 spec §21 的 14 条逐项打勾，并附上对应自动化测试或 smoke runbook 步骤：

| Spec §21 条目 | 验证手段 |
|---|---|
| 1. `ai-ready` issue 自动拾取 | Task 6.2 单测 + Task 8.3 E2E |
| 2. 切到 `ai-running` | Task 6.2 + Task 3.3 |
| 3. 每个 Issue 独立 worktree | Task 4.3 + Task 8.3 |
| 4. Codex 在该 worktree 启动 | Task 5.2 + Task 8.3 |
| 5. Prompt 包含 issue/workspace context | Task 2.3 + Task 6.3 |
| 6. Codex 可调 allowlisted GitLab tools | Task 5.4 + Task 8.3 |
| 7. 代码变更被提交 | Task 4.3 + Task 6.4 |
| 8. 分支推送到 GitLab | Task 6.4 + Task 8.3 |
| 9. MR 创建或更新 | Task 3.5 + Task 6.4 |
| 10. Issue handoff note | Task 3.4 + Task 6.4 |
| 11. 成功 → `human-review` | Task 6.4 |
| 12. 失败/阻塞 → `ai-failed`/`ai-blocked` | Task 6.5 + Task 8.4 |
| 13. Dashboard 展示 timeline/session/MR/logs | Task 7.3/7.4 |
| 14. 失败 run 保留 workspace + logs | Task 4.5 + Task 6.5 |

---

## 风险与回退

- **Codex app-server 协议字段变动**：所有 RPC payload 集中在 `packages/runner-codex-app-server/src/{rpc,lifecycle,events}.ts`；遇到协议升级时只改这三个文件 + 重跑 Phase 8 fakes。
- **GitLab 速率限制**：所有写操作都通过 `tracker-gitlab` 调用，统一指数退避；Phase 6.5 重试机制兜底。
- **worktree 状态污染**：Phase 4 任何不一致直接抛 `WorkspaceDirtyError`，run 进入 `ai-failed` 保留现场，不尝试自动修复。
- **dashboard 误展示 secret**：所有 API response 经过 redact，并在 Phase 6.7 / 7.4 都加测试；新增字段需走 review。

---

## 执行交接

**计划已保存：** `docs/superpowers/plans/2026-05-11-issuepilot-implementation-plan.md`

**两种执行方式：**

1. **Subagent 驱动（当前会话）**：每个 Task 派一个 fresh subagent；Task 之间 code review。
   - REQUIRED SUB-SKILL：`superpowers:subagent-driven-development`。
2. **独立会话**：在干净 worktree 中开新 session，按本计划逐 Task 实施。
   - REQUIRED SUB-SKILL：`superpowers:executing-plans`。

无论哪种方式：

- 每个 Task 完成后立即 commit，且更新 `CHANGELOG.md`。
- 跨 Phase 不允许累计未通过测试；Phase 切换时跑一次 `pnpm -w turbo run build test typecheck lint`。
- 真实 GitLab smoke 必须在 Phase 8 完成后执行，并把结果记录回 `2026-05-11-issuepilot-smoke-runbook.md`。
