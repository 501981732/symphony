# IssuePilot V2 团队运行时底座实施计划

Phase：V2 Phase 1
状态：已完成，已合入 `main`
对应 spec：`docs/superpowers/specs/2026-05-16-issuepilot-v2-phase1-team-runtime-foundation-design.md`
上级 spec：`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`
下一步：V2 Phase 2 Dashboard Operations

> **给执行 agent：** 执行本计划时必须使用子技能 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。步骤使用 checkbox（`- [ ]`）追踪。

**目标：** 交付 V2 team mode 的第一阶段底座：一个 daemon 可以加载多个项目 workflow，使用轻量 run lease 控制并发，并向 dashboard 暴露 project-aware state，同时保持 V1 `--workflow` 单项目入口兼容。

**架构：** 保留现有 V1 single-workflow daemon 作为稳定路径，在 `issuepilot run --config <issuepilot.team.yaml>` 后面新增并行 team-mode 入口。Team mode 增加 team config parser、project registry、file-backed lease store、project-aware shared contracts、server state 扩展和 dashboard project grouping。本计划不实现 dashboard 写操作、CI 回流、review sweep 或 workspace cleanup。

**技术栈：** TypeScript、Node.js 22、Commander、Fastify、Vitest、Next.js App Router、Tailwind、`yaml`、`zod`、现有 IssuePilot workspace packages。

---

## 范围检查

V2 设计包含多个独立子系统：team runtime foundation、dashboard operations、CI feedback、review feedback sweep 和 workspace retention。本计划只覆盖 `docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md` 中的 **Phase 1：团队运行时底座**。

本计划明确不做：

- `retry`、`stop`、`archive run` dashboard 操作。
- CI 状态读取或 `ai-rework` 自动回流。
- MR discussion review sweep。
- workspace retention cleanup。
- multi-worker 或跨机器锁。

## 文件结构

- 新建：`apps/orchestrator/src/team/config.ts`：解析和校验 `issuepilot.team.yaml`，补默认值，解析 project workflow path。
- 新建：`apps/orchestrator/src/team/__tests__/config.test.ts`：覆盖合法配置、重复 project id、非法 scheduler 值和相对路径解析。
- 新建：`apps/orchestrator/src/team/registry.ts`：加载 project workflow，生成 typed project registry，避免把 workflow 字段复制到 team config。
- 新建：`apps/orchestrator/src/team/__tests__/registry.test.ts`：覆盖 enabled / disabled project 和单项目 workflow 加载失败。
- 新建：`apps/orchestrator/src/runtime/leases.ts`：file-backed run lease store，支持 acquire / release / expire / active。
- 新建：`apps/orchestrator/src/runtime/__tests__/leases.test.ts`：覆盖同 issue 冲突、全局/单项目并发上限、过期和释放。
- 修改：`packages/shared-contracts/src/state.ts`：新增 `ProjectSummary`、`TeamRuntimeSummary`，并给 `/api/state` 增加可选 `projects` / `runtime`。
- 修改：`packages/shared-contracts/src/run.ts`：给 `RunRecord` 增加可选 `projectId` 和 `projectName`。
- 修改：`packages/shared-contracts/src/__tests__/state.test.ts`、`packages/shared-contracts/src/__tests__/run.test.ts`：补 contract shape 覆盖。
- 修改：`apps/orchestrator/src/cli.ts`：给 `issuepilot run` 增加 `--config <path>`，禁止和 `--workflow` 同时使用，并路由到 `startTeamDaemon`。
- 修改：`apps/orchestrator/src/__tests__/cli.test.ts`：覆盖 `--config`、冲突报错和 V1 兼容。
- 新建：`apps/orchestrator/src/team/daemon.ts`：启动一个 Fastify server，为 enabled projects 建立 team runtime shell，共享 state / event bus / lease store。
- 新建：`apps/orchestrator/src/team/__tests__/daemon.test.ts`：用 fake dependencies 验证 two-project team daemon startup 和 server deps。
- 新建：`apps/orchestrator/src/team/scheduler.ts`：实现 team-mode claim foundation，先拿 lease，再 transition label，并写 project-aware run record。
- 新建：`apps/orchestrator/src/team/__tests__/scheduler.test.ts`：覆盖 lease 成功 claim、lease 失败不 transition label。
- 修改：`apps/orchestrator/src/server/index.ts`：接受 project summaries 并返回 project-aware `/api/state`，保持 `/api/runs` 和 `/api/runs/:runId` 兼容。
- 修改：`apps/orchestrator/src/server/__tests__/server.test.ts`：覆盖 V1 和 team mode state endpoint。
- 修改：`apps/dashboard/lib/api.ts`：消费扩展后的 `OrchestratorStateSnapshot`。
- 修改：`apps/dashboard/components/overview/overview-page.tsx`：新增 project grouping，不改 detail route。
- 新建：`apps/dashboard/components/overview/project-list.tsx`：渲染紧凑 project rows。
- 新建：`apps/dashboard/components/overview/project-list.test.tsx`：覆盖 dashboard project grouping。
- 修改：`apps/dashboard/components/overview/overview-page.test.tsx`：覆盖 team-mode rendering。
- 修改：`apps/dashboard/app/page.tsx`：更新 unreachable fallback 文案，使用 `WORKFLOW.md` 和 `--config`。
- 修改：`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`：代码落地后补 Phase 1 plan 链接。

## 任务 1：共享团队运行时契约

**文件：**
- 修改：`packages/shared-contracts/src/state.ts`
- 修改：`packages/shared-contracts/src/run.ts`
- 修改：`packages/shared-contracts/src/__tests__/state.test.ts`
- 修改：`packages/shared-contracts/src/__tests__/run.test.ts`

- [ ] **步骤 1：写失败的 state contract 测试**

在 `packages/shared-contracts/src/__tests__/state.test.ts` 追加：

```ts
it("accepts a team runtime snapshot with project summaries", () => {
  const snapshot: OrchestratorStateSnapshot = {
    service: {
      status: "ready",
      workflowPath: "/srv/issuepilot/team.yaml",
      gitlabProject: "team",
      pollIntervalMs: 10000,
      concurrency: 2,
      lastConfigReloadAt: "2026-05-15T00:00:00.000Z",
      lastPollAt: "2026-05-15T00:00:01.000Z",
    },
    summary: {
      running: 1,
      retrying: 0,
      "human-review": 1,
      failed: 0,
      blocked: 0,
    },
    runtime: {
      mode: "team",
      maxConcurrentRuns: 2,
      activeLeases: 1,
      projectCount: 2,
    },
    projects: [
      {
        id: "platform-web",
        name: "Platform Web",
        workflowPath: "/srv/platform-web/WORKFLOW.md",
        gitlabProject: "group/platform-web",
        enabled: true,
        activeRuns: 1,
        lastPollAt: "2026-05-15T00:00:01.000Z",
      },
      {
        id: "infra-tools",
        name: "Infra Tools",
        workflowPath: "/srv/infra-tools/WORKFLOW.md",
        gitlabProject: "group/infra-tools",
        enabled: true,
        activeRuns: 0,
        lastPollAt: null,
      },
    ],
  };

  expect(snapshot.runtime?.mode).toBe("team");
  expect(snapshot.projects?.map((project) => project.id)).toEqual([
    "platform-web",
    "infra-tools",
  ]);
});
```

在 `packages/shared-contracts/src/__tests__/run.test.ts` 追加：

```ts
it("allows runs to carry team project metadata", () => {
  const run: RunRecord = {
    runId: "run-1",
    status: "running",
    attempt: 1,
    issue: {
      id: "1",
      iid: 1,
      title: "Fix checkout",
      url: "https://gitlab.example.com/group/platform-web/-/issues/1",
      projectId: "group/platform-web",
      labels: ["ai-running"],
    },
    projectId: "platform-web",
    projectName: "Platform Web",
    startedAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:01.000Z",
  };

  expect(run.projectId).toBe("platform-web");
  expect(run.projectName).toBe("Platform Web");
});
```

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @issuepilot/shared-contracts test -- src/__tests__/state.test.ts src/__tests__/run.test.ts
```

期望：失败，错误指向 `runtime`、`projects`、`projectId` 或 `projectName` 尚未定义。

- [ ] **步骤 3：扩展 shared contracts**

在 `packages/shared-contracts/src/state.ts` 中新增：

```ts
export interface ProjectSummary {
  id: string;
  name: string;
  workflowPath: string;
  gitlabProject: string;
  enabled: boolean;
  activeRuns: number;
  lastPollAt: string | null;
  lastError?: string;
}

export interface TeamRuntimeSummary {
  mode: "single" | "team";
  maxConcurrentRuns: number;
  activeLeases: number;
  projectCount: number;
}
```

将 `OrchestratorStateSnapshot` 扩展为包含：

```ts
  runtime?: TeamRuntimeSummary;
  projects?: ProjectSummary[];
```

在 `packages/shared-contracts/src/run.ts` 的 `RunRecord` 中加入：

```ts
  projectId?: string;
  projectName?: string;
```

如果 `RunRecord` 已经带有 `branch`、`workspacePath`、`startedAt` 等字段，只补上这两个 project metadata 字段。

- [ ] **步骤 4：运行 focused 测试**

```bash
pnpm --filter @issuepilot/shared-contracts test -- src/__tests__/state.test.ts src/__tests__/run.test.ts
```

期望：PASS。

- [ ] **步骤 5：提交**

```bash
git add packages/shared-contracts/src/state.ts packages/shared-contracts/src/run.ts packages/shared-contracts/src/__tests__/state.test.ts packages/shared-contracts/src/__tests__/run.test.ts
git commit -m "feat(contracts): add team runtime state"
```

## 任务 2：团队配置解析器

**文件：**
- 新建：`apps/orchestrator/src/team/config.ts`
- 新建：`apps/orchestrator/src/team/__tests__/config.test.ts`
- 修改：`apps/orchestrator/package.json`

- [ ] **步骤 1：给 orchestrator 增加依赖**

在 `apps/orchestrator/package.json` 的 `dependencies` 中加入：

```json
"yaml": "^2.8.4",
"zod": "^4.4.3"
```

- [ ] **步骤 2：写失败的 parser 测试**

创建 `apps/orchestrator/src/team/__tests__/config.test.ts`：

```ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  TeamConfigError,
  loadTeamConfig,
  parseTeamConfig,
} from "../config.js";

describe("team config", () => {
  it("parses defaults and resolves workflow paths relative to the config file", () => {
    const config = parseTeamConfig(
      [
        "version: 1",
        "projects:",
        "  - id: platform-web",
        "    name: Platform Web",
        "    workflow: ./platform-web/WORKFLOW.md",
        "  - id: infra-tools",
        "    name: Infra Tools",
        "    workflow: /srv/infra-tools/WORKFLOW.md",
        "    enabled: false",
      ].join("\n"),
      "/srv/issuepilot/issuepilot.team.yaml",
    );

    expect(config.server).toEqual({ host: "127.0.0.1", port: 4738 });
    expect(config.scheduler).toEqual({
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerProject: 1,
      leaseTtlMs: 900000,
      pollIntervalMs: 10000,
    });
    expect(config.projects[0]?.workflowPath).toBe(
      "/srv/issuepilot/platform-web/WORKFLOW.md",
    );
    expect(config.projects[1]?.enabled).toBe(false);
  });

  it("rejects duplicate project ids", () => {
    expect(() =>
      parseTeamConfig(
        [
          "version: 1",
          "projects:",
          "  - id: platform-web",
          "    name: One",
          "    workflow: ./one/WORKFLOW.md",
          "  - id: platform-web",
          "    name: Two",
          "    workflow: ./two/WORKFLOW.md",
        ].join("\n"),
        "/srv/issuepilot/issuepilot.team.yaml",
      ),
    ).toThrow(new TeamConfigError("duplicate project id: platform-web", "projects"));
  });

  it("rejects unsupported max concurrency", () => {
    expect(() =>
      parseTeamConfig(
        [
          "version: 1",
          "scheduler:",
          "  max_concurrent_runs: 6",
          "projects:",
          "  - id: platform-web",
          "    name: Platform Web",
          "    workflow: ./platform-web/WORKFLOW.md",
        ].join("\n"),
        "/srv/issuepilot/issuepilot.team.yaml",
      ),
    ).toThrow(/scheduler.max_concurrent_runs/);
  });

  it("loads a config file from disk", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "team-config-"));
    const configPath = path.join(tmpDir, "issuepilot.team.yaml");
    await fs.writeFile(
      configPath,
      [
        "version: 1",
        "projects:",
        "  - id: platform-web",
        "    name: Platform Web",
        "    workflow: ./WORKFLOW.md",
      ].join("\n"),
    );

    const config = await loadTeamConfig(configPath);

    expect(config.source.path).toBe(configPath);
    expect(config.projects[0]?.workflowPath).toBe(path.join(tmpDir, "WORKFLOW.md"));
  });
});
```

- [ ] **步骤 3：运行测试确认失败**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/team/__tests__/config.test.ts
```

期望：失败，因为 `apps/orchestrator/src/team/config.ts` 尚不存在。

- [ ] **步骤 4：实现 parser**

创建 `apps/orchestrator/src/team/config.ts`，实现这些导出：

```ts
export class TeamConfigError extends Error {
  override readonly name = "TeamConfigError";
  constructor(
    message: string,
    public readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface TeamProjectConfig {
  id: string;
  name: string;
  workflowPath: string;
  enabled: boolean;
}

export interface TeamSchedulerConfig {
  maxConcurrentRuns: number;
  maxConcurrentRunsPerProject: number;
  leaseTtlMs: number;
  pollIntervalMs: number;
}

export interface TeamConfig {
  version: 1;
  server: { host: string; port: number };
  scheduler: TeamSchedulerConfig;
  projects: TeamProjectConfig[];
  retention: {
    successfulRunDays: number;
    failedRunDays: number;
    maxWorkspaceGb: number;
  };
  source: { path: string; sha256: string; loadedAt: string };
}
```

实现细节：

- 使用 `YAML.parse(raw)` 解析。
- 使用 `zod` 校验：
  - `version` 必须是 `1`。
  - `scheduler.max_concurrent_runs` 允许 `1..5`，默认 `2`。
  - `scheduler.max_concurrent_runs_per_project` 允许 `1..5`，默认 `1`。
  - `scheduler.lease_ttl_ms` 最小 `60000`，默认 `900000`。
  - `scheduler.poll_interval_ms` 最小 `1000`，默认 `10000`。
  - `projects` 至少一个。
  - `project.id` 只允许 lowercase letters、numbers 和 hyphen。
- 相对 `workflow` 路径按 config 文件所在目录解析成绝对路径。
- 重复 `project.id` 抛 `TeamConfigError("duplicate project id: <id>", "projects")`。
- `loadTeamConfig(configPath)` 读取文件并调用 `parseTeamConfig(raw, resolvedPath)`。

- [ ] **步骤 5：运行 focused 测试**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/team/__tests__/config.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

期望：PASS。

- [ ] **步骤 6：提交**

```bash
git add apps/orchestrator/package.json apps/orchestrator/src/team/config.ts apps/orchestrator/src/team/__tests__/config.test.ts
git commit -m "feat(orchestrator): parse team runtime config"
```

## 任务 3：文件型租约存储

**文件：**
- 新建：`apps/orchestrator/src/runtime/leases.ts`
- 新建：`apps/orchestrator/src/runtime/__tests__/leases.test.ts`

- [ ] **步骤 1：写失败的 lease store 测试**

创建 `apps/orchestrator/src/runtime/__tests__/leases.test.ts`，覆盖：

```ts
it("acquires and releases a lease", async () => {
  const store = await createStore();
  const lease = await store.acquire({
    projectId: "platform-web",
    issueId: "1",
    runId: "run-1",
    branchName: "ai/1-fix",
    ttlMs: 60000,
    maxConcurrentRuns: 2,
    maxConcurrentRunsPerProject: 1,
  });

  expect(lease?.status).toBe("active");
  expect(await store.active()).toHaveLength(1);
  await store.release(lease!.leaseId);
  expect(await store.active()).toHaveLength(0);
});
```

同时补三个测试：

- 同一 `projectId + issueId` 第二次 acquire 返回 `null`。
- 全局并发和单项目并发达到上限时返回 `null`。
- `expireStale()` 将超过 `expiresAt` 的 active lease 标记为 `expired`，且 `active()` 不再返回它。

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/runtime/__tests__/leases.test.ts
```

期望：失败，因为 `apps/orchestrator/src/runtime/leases.ts` 尚不存在。

- [ ] **步骤 3：实现 lease store**

创建 `apps/orchestrator/src/runtime/leases.ts`，导出：

```ts
export interface RunLease {
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

export interface LeaseStore {
  acquire(input: AcquireLeaseInput): Promise<RunLease | null>;
  release(leaseId: string): Promise<void>;
  heartbeat(leaseId: string, ttlMs: number): Promise<RunLease | null>;
  expireStale(): Promise<RunLease[]>;
  active(): Promise<RunLease[]>;
}
```

实现要求：

- JSON 文件结构为 `{ "leases": RunLease[] }`。
- 文件不存在时按空数组处理。
- 写入时先写临时文件，再 `rename` 到目标路径。
- `active()` 只返回 `status === "active"` 且未过期的 lease。
- `acquire()` 先把过期 lease 标为 `expired`，再检查全局上限、单项目上限和同 issue 冲突。
- `release()` 只把 active lease 标为 `released`，不删除历史记录。
- `heartbeat()` 更新 `heartbeatAt` 和 `expiresAt`。

- [ ] **步骤 4：运行 focused lease 测试**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/runtime/__tests__/leases.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

期望：PASS。

- [ ] **步骤 5：提交**

```bash
git add apps/orchestrator/src/runtime/leases.ts apps/orchestrator/src/runtime/__tests__/leases.test.ts
git commit -m "feat(runtime): add file backed run leases"
```

## 任务 4：项目注册表

**文件：**
- 新建：`apps/orchestrator/src/team/registry.ts`
- 新建：`apps/orchestrator/src/team/__tests__/registry.test.ts`

- [ ] **步骤 1：写失败的 registry 测试**

创建 `apps/orchestrator/src/team/__tests__/registry.test.ts`，覆盖：

```ts
it("loads enabled projects and reports disabled projects as summaries", async () => {
  const loader = {
    loadOnce: vi.fn(async (workflowPath: string) =>
      workflow("group/platform-web", workflowPath),
    ),
  } as unknown as WorkflowLoader;

  const registry = await createProjectRegistry(teamConfig(), loader);

  expect(loader.loadOnce).toHaveBeenCalledWith("/srv/platform-web/WORKFLOW.md");
  expect(registry.enabledProjects()).toHaveLength(1);
  expect(registry.project("platform-web")?.workflow.tracker.projectId).toBe(
    "group/platform-web",
  );
  expect(registry.summaries()[0]).toMatchObject({
    id: "platform-web",
    gitlabProject: "group/platform-web",
    enabled: true,
  });
  expect(registry.summaries()[1]).toMatchObject({
    id: "infra-tools",
    gitlabProject: "",
    enabled: false,
  });
});
```

再补一个测试：当 `workflowLoader.loadOnce()` 抛错时，该 project 出现在 `summaries()` 中，`enabled: false` 且 `lastError` 为错误消息。

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/team/__tests__/registry.test.ts
```

期望：失败，因为 `apps/orchestrator/src/team/registry.ts` 尚不存在。

- [ ] **步骤 3：实现 registry**

创建 `apps/orchestrator/src/team/registry.ts`，导出：

```ts
export interface RegisteredProject {
  id: string;
  name: string;
  workflowPath: string;
  enabled: true;
  workflow: WorkflowConfig;
  lastPollAt: string | null;
  activeRuns: number;
}

export interface ProjectRegistry {
  enabledProjects(): RegisteredProject[];
  project(projectId: string): RegisteredProject | undefined;
  summaries(): ProjectSummary[];
  updateProjectPoll(projectId: string, at: string): void;
  updateProjectActiveRuns(projectId: string, activeRuns: number): void;
}
```

实现要求：

- disabled project 不调用 `workflowLoader.loadOnce()`。
- enabled project 加载 workflow 成功后进入 `enabledProjects()`。
- enabled project 加载失败后在 `summaries()` 中以 `enabled: false` + `lastError` 出现。
- `summaries()` 输出顺序与 team config 中 `projects` 顺序一致。

- [ ] **步骤 4：运行 registry 测试**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/team/__tests__/registry.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

期望：PASS。

- [ ] **步骤 5：提交**

```bash
git add apps/orchestrator/src/team/registry.ts apps/orchestrator/src/team/__tests__/registry.test.ts
git commit -m "feat(orchestrator): load team project registry"
```

## 任务 5：CLI 团队模式入口

**文件：**
- 修改：`apps/orchestrator/src/cli.ts`
- 修改：`apps/orchestrator/src/__tests__/cli.test.ts`
- 新建：`apps/orchestrator/src/team/daemon.ts`

- [ ] **步骤 1：补 `--config` CLI 测试**

在 `apps/orchestrator/src/__tests__/cli.test.ts` 追加：

```ts
it("run starts team daemon when --config is provided", async () => {
  const configPath = path.join(tmpDir, "issuepilot.team.yaml");
  fs.writeFileSync(configPath, "version: 1\nprojects: []\n");
  const wait = vi.fn(async () => {});
  const startTeamDaemon = vi.fn(async () => ({
    host: "127.0.0.1",
    port: 4738,
    url: "http://127.0.0.1:4738",
    stop: vi.fn(async () => {}),
    wait,
  }));
  const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const cli = buildCli({ startTeamDaemon });

  await cli.parseAsync(["run", "--config", configPath], { from: "user" });

  expect(startTeamDaemon).toHaveBeenCalledWith({
    configPath,
    host: "127.0.0.1",
    port: 4738,
  });
  expect(mockLog).toHaveBeenCalledWith(
    "IssuePilot team daemon ready: http://127.0.0.1:4738",
  );
  expect(wait).toHaveBeenCalled();
  mockLog.mockRestore();
});
```

再追加冲突测试：`issuepilot run --workflow WORKFLOW.md --config issuepilot.team.yaml` 应设置 `process.exitCode = 1`，并打印 `Error: --workflow and --config cannot be used together`。

- [ ] **步骤 2：运行 CLI 测试确认失败**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/__tests__/cli.test.ts
```

期望：失败，因为 `buildCli` 尚不接受 `startTeamDaemon`，`run` 也没有 `--config`。

- [ ] **步骤 3：添加 team daemon placeholder**

创建 `apps/orchestrator/src/team/daemon.ts`：

```ts
export interface TeamDaemonHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
  wait(): Promise<void>;
}

export interface StartTeamDaemonOptions {
  configPath: string;
  host?: string | undefined;
  port?: number | undefined;
}

export async function startTeamDaemon(
  options: StartTeamDaemonOptions,
): Promise<TeamDaemonHandle> {
  throw new Error(
    `team mode is not implemented yet for config ${options.configPath}`,
  );
}
```

- [ ] **步骤 4：接入 CLI**

在 `apps/orchestrator/src/cli.ts` 中：

- import `startTeamDaemon` 和 `TeamDaemonHandle`。
- 在 `CliDeps` 增加 `startTeamDaemon` 注入点。
- 给 `run` command 增加 `.option("--config <path>", "Path to V2 team config file")`。
- 在 action 开头拒绝 `--workflow` 和 `--config` 同时出现。
- 当 `--config` 存在时：
  - resolve 成绝对路径。
  - 不存在则打印 `Error: team config file not found: <path>`。
  - 调 `teamDaemonStarter({ configPath, port, host })`。
  - 成功打印 `IssuePilot team daemon ready: <url>`。
  - `await handle.wait()` 后 return。
- 不传 `--config` 时保持现有 `--workflow` 行为不变。

- [ ] **步骤 5：运行 CLI 测试**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/__tests__/cli.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

期望：PASS。

- [ ] **步骤 6：提交**

```bash
git add apps/orchestrator/src/cli.ts apps/orchestrator/src/__tests__/cli.test.ts apps/orchestrator/src/team/daemon.ts
git commit -m "feat(cli): add team config run mode"
```

## 任务 6：项目感知服务状态

**文件：**
- 修改：`apps/orchestrator/src/server/index.ts`
- 修改：`apps/orchestrator/src/server/__tests__/server.test.ts`

- [ ] **步骤 1：补失败的 `/api/state` 测试**

在 `apps/orchestrator/src/server/__tests__/server.test.ts` 追加测试：调用 `createServer()` 时传入 `runtime` 和 `projects`，请求 `/api/state` 后断言返回：

```ts
expect(response.json()).toMatchObject({
  service: {
    workflowPath: "/srv/issuepilot.team.yaml",
    gitlabProject: "team",
    concurrency: 2,
  },
  runtime: {
    mode: "team",
    activeLeases: 1,
    projectCount: 2,
  },
  projects: [
    { id: "platform-web", activeRuns: 1 },
    { id: "infra-tools", activeRuns: 0 },
  ],
});
```

- [ ] **步骤 2：运行 server 测试确认失败**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/server/__tests__/server.test.ts
```

期望：失败，因为 `ServerDeps` 尚不接受 `runtime` 和 `projects`。

- [ ] **步骤 3：扩展 server deps**

在 `apps/orchestrator/src/server/index.ts` 中 import：

```ts
import type {
  ProjectSummary,
  TeamRuntimeSummary,
} from "@issuepilot/shared-contracts";
```

在 `ServerDeps` 加：

```ts
  runtime?: TeamRuntimeSummary;
  projects?: ProjectSummary[];
```

在 `/api/state` response 中附加：

```ts
      ...(deps.runtime ? { runtime: deps.runtime } : {}),
      ...(deps.projects ? { projects: deps.projects } : {}),
```

- [ ] **步骤 4：运行 server 测试**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/server/__tests__/server.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

期望：PASS。

- [ ] **步骤 5：提交**

```bash
git add apps/orchestrator/src/server/index.ts apps/orchestrator/src/server/__tests__/server.test.ts
git commit -m "feat(server): expose team runtime state"
```

## 任务 7：团队 Daemon 启动

**文件：**
- 修改：`apps/orchestrator/src/team/daemon.ts`
- 新建：`apps/orchestrator/src/team/__tests__/daemon.test.ts`

- [ ] **步骤 1：写 team daemon 启动测试**

创建 `apps/orchestrator/src/team/__tests__/daemon.test.ts`，用 fake `loadTeamConfig`、fake `createProjectRegistry` 和 fake `createServer` 断言：

- `startTeamDaemon({ configPath, host, port })` 返回 `http://host:port`。
- `createServer()` 收到：
  - `workflowPath: config.source.path`
  - `gitlabProject: "team"`
  - `concurrency: config.scheduler.maxConcurrentRuns`
  - `runtime.mode: "team"`
  - `projects: registry.summaries()`
- `handle.stop()` 会调用 `app.close()`。

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/team/__tests__/daemon.test.ts
```

期望：失败，因为 `startTeamDaemon` 仍是 placeholder。

- [ ] **步骤 3：实现 team daemon shell**

替换 `apps/orchestrator/src/team/daemon.ts`，实现：

```ts
export interface StartTeamDaemonDeps {
  loadTeamConfig?: ((configPath: string) => Promise<TeamConfig>) | undefined;
  createProjectRegistry?:
    | ((
        config: TeamConfig,
        workflowLoader: ReturnType<typeof createWorkflowLoader>,
      ) => Promise<ProjectRegistry>)
    | undefined;
  createServer?: typeof createServer | undefined;
  state?: RuntimeState | undefined;
}
```

启动流程：

1. `configPath = path.resolve(options.configPath)`。
2. `config = await loadTeamConfig(configPath)`。
3. `workflowLoader = createWorkflowLoader()`。
4. `registry = await createProjectRegistry(config, workflowLoader)`。
5. `state = deps.state ?? createRuntimeState()`。
6. `eventBus = createEventBus()`。
7. `createServer()` 时传入 project-aware state：

```ts
{
  state,
  eventBus,
  workflowPath: config.source.path,
  gitlabProject: "team",
  handoffLabel: "human-review",
  pollIntervalMs: config.scheduler.pollIntervalMs,
  concurrency: config.scheduler.maxConcurrentRuns,
  runtime: {
    mode: "team",
    maxConcurrentRuns: config.scheduler.maxConcurrentRuns,
    activeLeases: 0,
    projectCount: registry.summaries().length,
  },
  projects: registry.summaries(),
  readEvents: async () => [],
  readLogsTail: async () => [],
}
```

本任务只启动 project-aware API shell，不开始真实 GitLab poll。

- [ ] **步骤 4：运行 team daemon 测试**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/team/__tests__/daemon.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

期望：PASS。

- [ ] **步骤 5：提交**

```bash
git add apps/orchestrator/src/team/daemon.ts apps/orchestrator/src/team/__tests__/daemon.test.ts
git commit -m "feat(orchestrator): start team daemon shell"
```

## 任务 8：团队调度 Claim 底座

**文件：**
- 新建：`apps/orchestrator/src/team/scheduler.ts`
- 新建：`apps/orchestrator/src/team/__tests__/scheduler.test.ts`
- 修改：`apps/orchestrator/src/team/daemon.ts`

- [ ] **步骤 1：写失败的 scheduler 测试**

创建 `apps/orchestrator/src/team/__tests__/scheduler.test.ts`，覆盖：

```ts
it("claims one project issue only after acquiring a lease", async () => {
  const claimed = await claimTeamProjectOnce({
    project: project(),
    gitlab,
    state,
    leaseStore,
    scheduler: {
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerProject: 1,
      leaseTtlMs: 900000,
      pollIntervalMs: 10000,
    },
  });

  expect(claimed).toHaveLength(1);
  expect(leaseStore.acquire).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: "platform-web",
      issueId: "1",
      runId: expect.any(String),
    }),
  );
  expect(state.getRun(claimed[0]!.runId)).toMatchObject({
    projectId: "platform-web",
    projectName: "Platform Web",
    leaseId: "lease-1",
    status: "claimed",
  });
});
```

再补一个测试：当 `leaseStore.acquire()` 返回 `null` 时，不调用 `gitlab.transitionLabels()`，返回 `[]`。

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/team/__tests__/scheduler.test.ts
```

期望：失败，因为 `apps/orchestrator/src/team/scheduler.ts` 尚不存在。

- [ ] **步骤 3：实现 claim foundation**

创建 `apps/orchestrator/src/team/scheduler.ts`，导出：

```ts
export interface TeamClaimInput {
  project: RegisteredProject;
  gitlab: Pick<
    GitLabAdapter,
    "listCandidateIssues" | "getIssue" | "transitionLabels"
  >;
  state: RuntimeState;
  leaseStore: LeaseStore;
  scheduler: TeamSchedulerConfig;
}

export async function claimTeamProjectOnce(
  input: TeamClaimInput,
): Promise<Array<{ runId: string }>>;
```

实现顺序必须是：

1. 调 `gitlab.listCandidateIssues()` 获取候选 issue。
2. 对每个 candidate 先生成 `runId` 和 branch name。
3. 先调用 `leaseStore.acquire()`。
4. acquire 返回 `null` 时跳过该 issue，不 transition labels。
5. acquire 成功后再调用 `gitlab.transitionLabels()`。
6. 调 `gitlab.getIssue()` 获取完整 issue。
7. `state.setRun()` 写入 `projectId`、`projectName`、`leaseId`、`status: "claimed"` 和 branch。

- [ ] **步骤 4：运行 scheduler 测试**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/team/__tests__/scheduler.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

期望：PASS。

- [ ] **步骤 5：提交**

```bash
git add apps/orchestrator/src/team/scheduler.ts apps/orchestrator/src/team/__tests__/scheduler.test.ts
git commit -m "feat(orchestrator): add team claim leases"
```

## 任务 9：控制台项目概览

**文件：**
- 新建：`apps/dashboard/components/overview/project-list.tsx`
- 新建：`apps/dashboard/components/overview/project-list.test.tsx`
- 修改：`apps/dashboard/components/overview/overview-page.tsx`
- 修改：`apps/dashboard/components/overview/overview-page.test.tsx`
- 修改：`apps/dashboard/app/page.tsx`

- [ ] **步骤 1：写失败的 ProjectList 测试**

创建 `apps/dashboard/components/overview/project-list.test.tsx`：

```tsx
import type { ProjectSummary } from "@issuepilot/shared-contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectList } from "./project-list";

describe("ProjectList", () => {
  it("renders project status rows", () => {
    const projects: ProjectSummary[] = [
      {
        id: "platform-web",
        name: "Platform Web",
        workflowPath: "/srv/platform-web/WORKFLOW.md",
        gitlabProject: "group/platform-web",
        enabled: true,
        activeRuns: 1,
        lastPollAt: "2026-05-15T00:00:00.000Z",
      },
      {
        id: "infra-tools",
        name: "Infra Tools",
        workflowPath: "/srv/infra-tools/WORKFLOW.md",
        gitlabProject: "group/infra-tools",
        enabled: false,
        activeRuns: 0,
        lastPollAt: null,
        lastError: "workflow missing tracker.project_id",
      },
    ];

    render(<ProjectList projects={projects} />);

    expect(screen.getByText("Platform Web")).toBeInTheDocument();
    expect(screen.getByText("group/platform-web")).toBeInTheDocument();
    expect(screen.getByText("1 active")).toBeInTheDocument();
    expect(screen.getByText("Infra Tools")).toBeInTheDocument();
    expect(screen.getByText("disabled")).toBeInTheDocument();
    expect(
      screen.getByText("workflow missing tracker.project_id"),
    ).toBeInTheDocument();
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @issuepilot/dashboard test -- components/overview/project-list.test.tsx
```

期望：失败，因为 `project-list.tsx` 尚不存在。

- [ ] **步骤 3：实现 `ProjectList`**

创建 `apps/dashboard/components/overview/project-list.tsx`：

```tsx
import type { ProjectSummary } from "@issuepilot/shared-contracts";

import { Badge } from "../ui/badge";
import { Card } from "../ui/card";

interface ProjectListProps {
  projects: ProjectSummary[];
}

function formatLastPoll(value: string | null): string {
  if (!value) return "not polled";
  return new Date(value).toLocaleString();
}

export function ProjectList({ projects }: ProjectListProps) {
  if (projects.length === 0) {
    return (
      <Card className="p-4 text-sm text-slate-500">
        No team projects configured.
      </Card>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {projects.map((project) => (
        <Card key={project.id} className="flex flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-slate-900">
                {project.name}
              </h3>
              <p className="truncate text-xs text-slate-500">
                {project.gitlabProject || project.workflowPath}
              </p>
            </div>
            <Badge variant={project.enabled ? "default" : "secondary"}>
              {project.enabled ? `${project.activeRuns} active` : "disabled"}
            </Badge>
          </div>
          <div className="text-xs text-slate-500">
            Last poll: {formatLastPoll(project.lastPollAt)}
          </div>
          {project.lastError && (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {project.lastError}
            </p>
          )}
        </Card>
      ))}
    </div>
  );
}
```

- [ ] **步骤 4：接入 overview**

在 `apps/dashboard/components/overview/overview-page.tsx` 中 import：

```tsx
import { ProjectList } from "./project-list";
```

在 Summary 和 Runs 之间加入：

```tsx
      {snapshot.projects && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Projects
          </h2>
          <ProjectList projects={snapshot.projects} />
        </section>
      )}
```

在 `apps/dashboard/app/page.tsx` 中把 fallback 命令更新为：

```tsx
<code className="font-mono">
  issuepilot run --workflow /path/to/target-project/WORKFLOW.md
</code>
{" "}
or team mode with{" "}
<code className="font-mono">
  issuepilot run --config /path/to/issuepilot.team.yaml
</code>
```

- [ ] **步骤 5：扩展 overview rendering 测试**

在 `apps/dashboard/components/overview/overview-page.test.tsx` 添加包含 `snapshot.projects` 的 rendering 测试，断言页面出现 `Projects` 和 `Platform Web`。

- [ ] **步骤 6：运行 dashboard 测试**

```bash
pnpm --filter @issuepilot/dashboard test -- components/overview/project-list.test.tsx components/overview/overview-page.test.tsx
pnpm --filter @issuepilot/dashboard typecheck
```

期望：PASS。

- [ ] **步骤 7：提交**

```bash
git add apps/dashboard/components/overview/project-list.tsx apps/dashboard/components/overview/project-list.test.tsx apps/dashboard/components/overview/overview-page.tsx apps/dashboard/components/overview/overview-page.test.tsx apps/dashboard/app/page.tsx
git commit -m "feat(dashboard): show team projects overview"
```

## 任务 10：文档和验证

**文件：**
- 修改：`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`
- 修改：`README.md`
- 修改：`README.zh-CN.md`

- [ ] **步骤 1：在 V2 spec 增加 Phase 1 plan 链接**

在 `docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md` 的 `### Phase 1：团队运行时底座` 下追加：

```md

实施计划：

- `docs/superpowers/plans/2026-05-15-issuepilot-v2-team-runtime-foundation.md`
```

- [ ] **步骤 2：在 README 标注 team mode 仍是 V2 foundation**

在 `README.md` 的 `### V2 — Team-operable release` 下添加第一条：

```md
- 🚧 Phase 1 foundation: experimental `issuepilot run --config
  /path/to/issuepilot.team.yaml` team mode for multi-project loading,
  lease-backed scheduling, and project-aware dashboard state.
```

在 `README.zh-CN.md` 的 `### V2 — 团队可运营版本` 下添加第一条：

```md
- 🚧 Phase 1 foundation：实验性 `issuepilot run --config
  /path/to/issuepilot.team.yaml` team mode，用于多项目加载、lease-backed
  调度和 project-aware dashboard state。
```

- [ ] **步骤 3：运行 focused verification**

```bash
pnpm --filter @issuepilot/shared-contracts test -- src/__tests__/state.test.ts src/__tests__/run.test.ts
pnpm --filter @issuepilot/orchestrator test -- src/team/__tests__/config.test.ts src/runtime/__tests__/leases.test.ts src/team/__tests__/registry.test.ts src/team/__tests__/daemon.test.ts src/team/__tests__/scheduler.test.ts src/__tests__/cli.test.ts src/server/__tests__/server.test.ts
pnpm --filter @issuepilot/dashboard test -- components/overview/project-list.test.tsx components/overview/overview-page.test.tsx
pnpm --filter @issuepilot/orchestrator typecheck
pnpm --filter @issuepilot/dashboard typecheck
pnpm --filter @issuepilot/shared-contracts typecheck
git diff --check
```

期望：全部 PASS。

- [ ] **步骤 4：运行 release safety checks**

```bash
pnpm lint
pnpm typecheck
pnpm test
```

期望：全部 PASS。如果当前 session 时间不足，至少运行 Step 3 的 package-scoped focused commands，并在最终说明里明确 root checks 未运行。

- [ ] **步骤 5：提交**

```bash
git add README.md README.zh-CN.md docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md
git commit -m "docs(issuepilot): document V2 team foundation"
```

## 自审

Spec 覆盖：

- V2 §6 team config：Task 2 覆盖。
- V2 §7 lease-backed scheduling：Task 3 和 Task 8 覆盖。
- V2 §12 shared contracts 和 project-aware API state：Task 1 和 Task 6 覆盖。
- V2 §14 第一阶段测试策略：Task 1-10 覆盖。
- V2 §15 兼容性：Task 5 保留 `--workflow` 并新增 `--config`。
- V2 §16 Phase 1：Task 1-10 覆盖。

刻意延后：

- dashboard operations：下一份 V2 plan。
- CI feedback：第三份 V2 plan。
- review feedback sweep：第四份 V2 plan。
- workspace retention：第五份 V2 plan。

占位扫描：

- 本计划不包含 `TBD`、`TODO` 或开放式“后续补充”实现步骤。
- 每个代码改动步骤都给出具体文件、具体命令和可验证预期。

类型一致性：

- `TeamConfig`、`TeamSchedulerConfig`、`ProjectSummary`、`TeamRuntimeSummary`、`RunLease` 和 `RegisteredProject` 都在后续任务使用前定义。
- CLI 使用 `startTeamDaemon`，与 `apps/orchestrator/src/team/daemon.ts` 导出一致。
- dashboard 消费 `snapshot.projects`，与 Task 1 的 shared contract 扩展一致。
