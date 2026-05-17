# IssuePilot Central Workflow Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 V2 team mode 从 `projects[].workflow -> repo-owned WORKFLOW.md` 直接切换为中心化 `project + workflow_profile` 配置，不做旧实验 schema 兼容层。

**Architecture:** `issuepilot.team.yaml` 只声明 team runtime、defaults 和项目 registry；每个项目通过中心配置目录里的 `projects/*.yaml` 提供项目事实，通过 `workflows/*.md` 提供 prompt/profile。loader 将这些文件编译为内部 `WorkflowConfig`，现有 orchestrator、GitLab、workspace、runner 继续消费 effective workflow。

**Tech Stack:** TypeScript、Node.js 22、Commander、Fastify、Vitest、`yaml`、`zod`、`gray-matter`、现有 `@issuepilot/workflow` 与 `apps/orchestrator` team runtime。

---

## 范围检查

本计划只覆盖 `docs/superpowers/specs/2026-05-17-issuepilot-central-workflow-config-design.md` 的中心化 workflow 配置变更。

本计划明确不做：

- 不做鉴权层、权限模型、审批系统或多租户能力。
- 不保留 `projects[].workflow` 兼容加载。
- 不支持 team mode 从业务 repo 的完整 `WORKFLOW.md` 启动。
- 不做自动发现项目。
- 不把 token、OAuth refresh token 或 secret 写入配置文件。

本计划会破坏旧实验 schema。旧 team config fixture、README、USAGE、dashboard 文案和测试都必须同步改为中心配置写法。

## 文件结构

- 修改：`packages/workflow/src/parse.ts`：抽出 `parseWorkflowString(raw, sourcePath)`，让中心编译器可以复用现有 workflow front matter 校验。
- 修改：`packages/workflow/src/index.ts`：导出 `parseWorkflowString` 和中心编译器 API。
- 新建：`packages/workflow/src/central.ts`：解析中心 project file、workflow profile，编译 effective `WorkflowConfig`。
- 新建：`packages/workflow/src/__tests__/central.test.ts`：覆盖 project/profile 编译、字段覆盖、禁止 project 覆盖高风险运行字段。
- 修改：`packages/workflow/src/__tests__/parse.test.ts`：覆盖 `parseWorkflowString`。
- 修改：`apps/orchestrator/src/team/config.ts`：破坏式替换 team config schema，移除 `projects[].workflow`，新增 `defaults`、`projects[].project`、`projects[].workflow_profile`。
- 修改：`apps/orchestrator/src/team/__tests__/config.test.ts`：更新 schema 测试，明确旧 `workflow` 字段失败。
- 修改：`apps/orchestrator/src/team/registry.ts`：从 project/profile 编译 effective workflow，不再调用 `workflowLoader.loadOnce(project.workflowPath)`。
- 修改：`apps/orchestrator/src/team/__tests__/registry.test.ts`：用 fake central compiler 覆盖 enabled/disabled/load-error。
- 修改：`apps/orchestrator/src/team/daemon.ts`、`apps/orchestrator/src/team/__tests__/daemon.test.ts`：依赖新的 registry 输入和 source 字段。
- 修改：`apps/orchestrator/src/cli.ts`、`apps/orchestrator/src/__tests__/cli.test.ts`：`validate --config` 输出 project/profile 来源，新增 `render-workflow --config --project`。
- 修改：`packages/shared-contracts/src/state.ts`、`packages/shared-contracts/src/__tests__/state.test.ts`：让 project summary 展示 `projectPath`、`profilePath`、`effectiveWorkflowPath`。
- 修改：`apps/dashboard/components/overview/project-list.tsx` 与相关测试：显示 profile/project source，不再假设 workflow path 是业务 repo `WORKFLOW.md`。
- 修改：`README.md`、`README.zh-CN.md`、`USAGE.md`、`USAGE.zh-CN.md`：team mode 默认改成中心配置写法。
- 修改：`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`、`docs/superpowers/specs/2026-05-17-issuepilot-central-workflow-config-design.md`：实现完成后补 plan 链接和状态。

## Task 1: Workflow Parser Text Entrypoint

**Files:**
- Modify: `packages/workflow/src/parse.ts`
- Modify: `packages/workflow/src/index.ts`
- Modify: `packages/workflow/src/__tests__/parse.test.ts`

- [ ] **Step 1: Write the failing parser test**

Append to `packages/workflow/src/__tests__/parse.test.ts`:

```ts
it("parses workflow content from a generated source path", async () => {
  const raw = `---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
git:
  repo_url: "git@gitlab.example.com:group/project.git"
---

Handle issue {{ issue.identifier }}.
`;

  const cfg = parseWorkflowString(
    raw,
    "/srv/issuepilot-config/.generated/platform-web.workflow.md",
  );

  expect(cfg.source.path).toBe(
    "/srv/issuepilot-config/.generated/platform-web.workflow.md",
  );
  expect(cfg.tracker.projectId).toBe("group/project");
  expect(cfg.git.baseBranch).toBe("main");
  expect(cfg.promptTemplate).toContain("Handle issue");
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

```bash
pnpm --filter @issuepilot/workflow test -- src/__tests__/parse.test.ts
```

Expected: TypeScript or Vitest fails because `parseWorkflowString` is not exported.

- [ ] **Step 3: Extract the implementation**

In `packages/workflow/src/parse.ts`, keep `parseWorkflowFile(filePath)` but delegate to a new exported sync function:

```ts
export function parseWorkflowString(
  raw: string,
  sourcePath: string,
): WorkflowConfig {
  const parsed = parseFrontMatter(raw);
  const fm = validateFrontMatter(parsed.data);

  const promptTemplate = parsed.content.replace(/^\n+/, "");
  const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");

  return buildWorkflowConfig(fm, promptTemplate, {
    path: sourcePath,
    sha256,
    loadedAt: new Date().toISOString(),
  });
}
```

Move the existing object construction from `parseWorkflowFile` into:

```ts
function buildWorkflowConfig(
  fm: WorkflowFrontMatter,
  promptTemplate: string,
  source: WorkflowSource,
): WorkflowConfig {
  const tracker: TrackerConfig = {
    kind: fm.tracker.kind,
    baseUrl: fm.tracker.base_url,
    projectId: fm.tracker.project_id,
    ...(fm.tracker.token_env ? { tokenEnv: fm.tracker.token_env } : {}),
    activeLabels: fm.tracker.active_labels,
    runningLabel: fm.tracker.running_label,
    handoffLabel: fm.tracker.handoff_label,
    failedLabel: fm.tracker.failed_label,
    blockedLabel: fm.tracker.blocked_label,
    reworkLabel: fm.tracker.rework_label,
    mergingLabel: fm.tracker.merging_label,
  };

  const workspace: WorkspaceConfig = {
    root: fm.workspace.root,
    strategy: fm.workspace.strategy,
    repoCacheRoot: fm.workspace.repo_cache_root,
  };

  const git: GitConfig = {
    repoUrl: fm.git.repo_url,
    baseBranch: fm.git.base_branch,
    branchPrefix: fm.git.branch_prefix,
  };

  const agent: AgentConfig = {
    runner: fm.agent.runner,
    maxConcurrentAgents: fm.agent.max_concurrent_agents,
    maxTurns: fm.agent.max_turns,
    maxAttempts: fm.agent.max_attempts,
    retryBackoffMs: fm.agent.retry_backoff_ms,
  };

  const codex: CodexConfig = {
    command: fm.codex.command,
    approvalPolicy: fm.codex.approval_policy,
    threadSandbox: fm.codex.thread_sandbox,
    turnTimeoutMs: fm.codex.turn_timeout_ms,
    turnSandboxPolicy: { type: fm.codex.turn_sandbox_policy.type },
  };

  const hooks: HooksConfig = {};
  if (fm.hooks.after_create !== undefined) hooks.afterCreate = fm.hooks.after_create;
  if (fm.hooks.before_run !== undefined) hooks.beforeRun = fm.hooks.before_run;
  if (fm.hooks.after_run !== undefined) hooks.afterRun = fm.hooks.after_run;

  return {
    tracker,
    workspace,
    git,
    agent,
    codex,
    hooks,
    ci: {
      enabled: fm.ci.enabled,
      onFailure: fm.ci.on_failure,
      waitForPipeline: fm.ci.wait_for_pipeline,
    },
    retention: {
      successfulRunDays: fm.retention.successful_run_days,
      failedRunDays: fm.retention.failed_run_days,
      maxWorkspaceGb: fm.retention.max_workspace_gb,
      cleanupIntervalMs: fm.retention.cleanup_interval_ms,
    },
    pollIntervalMs: fm.poll_interval_ms,
    promptTemplate,
    source,
  };
}
```

Then make `parseWorkflowFile`:

```ts
export async function parseWorkflowFile(
  filePath: string,
): Promise<WorkflowConfig> {
  const raw = await readWorkflowFile(filePath);
  return parseWorkflowString(raw, filePath);
}
```

- [ ] **Step 4: Export the function**

In `packages/workflow/src/index.ts`:

```ts
export {
  parseWorkflowFile,
  parseWorkflowString,
  WorkflowConfigError,
} from "./parse.js";
```

- [ ] **Step 5: Run focused tests**

```bash
pnpm --filter @issuepilot/workflow test -- src/__tests__/parse.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/workflow/src/parse.ts packages/workflow/src/index.ts packages/workflow/src/__tests__/parse.test.ts
git commit -m "feat(workflow): parse generated workflow content"
```

## Task 2: Team Config Schema Replacement

**Files:**
- Modify: `apps/orchestrator/src/team/config.ts`
- Modify: `apps/orchestrator/src/team/__tests__/config.test.ts`

- [ ] **Step 1: Write failing schema tests**

Replace the main happy-path config test in `apps/orchestrator/src/team/__tests__/config.test.ts` with a central-config shape:

```ts
it("parses central team config project and profile paths", () => {
  const config = parseTeamConfig(
    `
version: 1
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
`,
    "/srv/issuepilot-config/issuepilot.team.yaml",
  );

  expect(config.defaults.labelsPath).toBe(
    "/srv/issuepilot-config/policies/labels.gitlab.yaml",
  );
  expect(config.projects[0]).toMatchObject({
    id: "platform-web",
    projectPath: "/srv/issuepilot-config/projects/platform-web.yaml",
    workflowProfilePath: "/srv/issuepilot-config/workflows/default-web.md",
    enabled: true,
  });
});
```

Add a no-compatibility test:

```ts
it("rejects legacy projects[].workflow in team mode", () => {
  expect(() =>
    parseTeamConfig(
      `
version: 1
projects:
  - id: platform-web
    name: Platform Web
    workflow: /srv/repos/platform-web/WORKFLOW.md
`,
      "/srv/issuepilot-config/issuepilot.team.yaml",
    ),
  ).toThrow(/projects.0.workflow/);
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/team/__tests__/config.test.ts
```

Expected: FAIL because `TeamProjectConfig` still exposes `workflowPath` and schema still expects `workflow`.

- [ ] **Step 3: Replace TeamProjectConfig**

In `apps/orchestrator/src/team/config.ts`:

```ts
export interface TeamDefaultsConfig {
  labelsPath: string | null;
  codexPath: string | null;
  workspaceRoot: string;
  repoCacheRoot: string;
}

export interface TeamProjectConfig {
  id: string;
  name: string;
  projectPath: string;
  workflowProfilePath: string;
  enabled: boolean;
  ci: TeamCiConfig | null;
}
```

Use strict schemas so legacy keys fail instead of being silently stripped:

```ts
const rawDefaultsSchema = z
  .strictObject({
    labels: z.string().min(1).optional(),
    codex: z.string().min(1).optional(),
    workspace_root: z.string().min(1).optional(),
    repo_cache_root: z.string().min(1).optional(),
  })
  .optional();

const rawProjectSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .regex(projectIdPattern, "must be lowercase letters, digits and hyphens"),
  name: z.string().min(1),
  project: z.string().min(1),
  workflow_profile: z.string().min(1),
  enabled: z.boolean().optional(),
  ci: rawProjectCiSchema,
});
```

Add `defaults` to `rawConfigSchema` and returned `TeamConfig`:

```ts
defaults: rawDefaultsSchema,
```

Normalize paths with the config directory:

```ts
function resolveConfigPath(configDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(configDir, value);
}
```

Build `defaults`:

```ts
const defaults: TeamDefaultsConfig = {
  labelsPath: parsed.defaults?.labels
    ? resolveConfigPath(configDir, parsed.defaults.labels)
    : null,
  codexPath: parsed.defaults?.codex
    ? resolveConfigPath(configDir, parsed.defaults.codex)
    : null,
  workspaceRoot:
    parsed.defaults?.workspace_root ?? DEFAULT_WORKSPACE_ROOT,
  repoCacheRoot:
    parsed.defaults?.repo_cache_root ?? DEFAULT_REPO_CACHE_ROOT,
};
```

Build projects:

```ts
const projects: TeamProjectConfig[] = parsed.projects.map((p) => ({
  id: p.id,
  name: p.name,
  projectPath: resolveConfigPath(configDir, p.project),
  workflowProfilePath: resolveConfigPath(configDir, p.workflow_profile),
  enabled: p.enabled ?? true,
  ci: p.ci
    ? {
        enabled: p.ci.enabled ?? false,
        onFailure: p.ci.on_failure ?? "ai-rework",
        waitForPipeline: p.ci.wait_for_pipeline ?? true,
      }
    : null,
}));
```

- [ ] **Step 4: Improve zod error paths**

If strict object errors report `projects.0`, convert unrecognized key messages to include the key:

```ts
function errorPathForIssue(issue: z.core.$ZodIssue): string {
  const base = humanisePath(issue.path);
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.join(".");
    return base ? `${base}.${keys}` : keys;
  }
  return base || "(root)";
}
```

Use `errorPathForIssue(first)` when creating `TeamConfigError`.

- [ ] **Step 5: Run focused tests**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/team/__tests__/config.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/team/config.ts apps/orchestrator/src/team/__tests__/config.test.ts
git commit -m "feat(team): require central project profile config"
```

## Task 3: Central Workflow Compiler

**Files:**
- Create: `packages/workflow/src/central.ts`
- Create: `packages/workflow/src/__tests__/central.test.ts`
- Modify: `packages/workflow/src/index.ts`

- [ ] **Step 1: Write compiler tests**

Create `packages/workflow/src/__tests__/central.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  CentralWorkflowConfigError,
  compileCentralWorkflowProject,
} from "../central.js";

describe("central workflow config compiler", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "issuepilot-central-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("compiles project facts and workflow profile into WorkflowConfig", async () => {
    const projectPath = path.join(dir, "platform-web.yaml");
    const profilePath = path.join(dir, "default-web.md");

    await writeFile(
      projectPath,
      `
tracker:
  kind: gitlab
  base_url: https://gitlab.example.com
  project_id: group/platform-web
git:
  repo_url: git@gitlab.example.com:group/platform-web.git
  base_branch: main
  branch_prefix: ai
agent:
  max_turns: 12
  max_attempts: 3
`,
      "utf8",
    );

    await writeFile(
      profilePath,
      `---
agent:
  runner: codex-app-server
  max_concurrent_agents: 1
codex:
  approval_policy: never
  thread_sandbox: workspace-write
ci:
  enabled: true
  on_failure: ai-rework
  wait_for_pipeline: true
---

Work on {{ project.tracker.project_id }} issue {{ issue.identifier }}.
`,
      "utf8",
    );

    const workflow = await compileCentralWorkflowProject({
      projectId: "platform-web",
      projectPath,
      workflowProfilePath: profilePath,
      defaults: {
        labelsPath: null,
        codexPath: null,
        workspaceRoot: "~/.issuepilot/workspaces",
        repoCacheRoot: "~/.issuepilot/repos",
      },
      generatedSourcePath: path.join(dir, ".generated/platform-web.workflow.md"),
    });

    expect(workflow.tracker.projectId).toBe("group/platform-web");
    expect(workflow.git.repoUrl).toBe("git@gitlab.example.com:group/platform-web.git");
    expect(workflow.agent.maxTurns).toBe(12);
    expect(workflow.ci.enabled).toBe(true);
    expect(workflow.promptTemplate).toContain("{{ project.tracker.project_id }}");
    expect(workflow.source.path).toContain(".generated/platform-web.workflow.md");
  });

  it("rejects project files that override high-risk runtime fields", async () => {
    const projectPath = path.join(dir, "bad-project.yaml");
    const profilePath = path.join(dir, "default-web.md");

    await writeFile(
      projectPath,
      `
tracker:
  kind: gitlab
  base_url: https://gitlab.example.com
  project_id: group/platform-web
  token_env: GITLAB_TOKEN
git:
  repo_url: git@gitlab.example.com:group/platform-web.git
`,
      "utf8",
    );
    await writeFile(profilePath, "---\n---\nPrompt\n", "utf8");

    await expect(
      compileCentralWorkflowProject({
        projectId: "platform-web",
        projectPath,
        workflowProfilePath: profilePath,
        defaults: {
          labelsPath: null,
          codexPath: null,
          workspaceRoot: "~/.issuepilot/workspaces",
          repoCacheRoot: "~/.issuepilot/repos",
        },
        generatedSourcePath: path.join(dir, ".generated/platform-web.workflow.md"),
      }),
    ).rejects.toMatchObject({
      name: "CentralWorkflowConfigError",
      path: "project.tracker.token_env",
    } satisfies Partial<CentralWorkflowConfigError>);
  });
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
pnpm --filter @issuepilot/workflow test -- src/__tests__/central.test.ts
```

Expected: FAIL because `central.ts` does not exist.

- [ ] **Step 3: Implement central compiler types and error**

Create `packages/workflow/src/central.ts`:

```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import matter from "gray-matter";
import YAML from "yaml";
import { z, ZodError } from "zod";

import { parseWorkflowString, WorkflowConfigError } from "./parse.js";
import type { WorkflowConfig } from "./types.js";

export class CentralWorkflowConfigError extends Error {
  override readonly name = "CentralWorkflowConfigError";
  constructor(
    message: string,
    public readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface CentralWorkflowDefaults {
  labelsPath: string | null;
  codexPath: string | null;
  workspaceRoot: string;
  repoCacheRoot: string;
}

export interface CompileCentralWorkflowProjectInput {
  projectId: string;
  projectPath: string;
  workflowProfilePath: string;
  defaults: CentralWorkflowDefaults;
  generatedSourcePath: string;
}
```

- [ ] **Step 4: Implement schemas**

In `central.ts`:

```ts
const ProjectFileSchema = z.strictObject({
  tracker: z.strictObject({
    kind: z.literal("gitlab"),
    base_url: z.string().url(),
    project_id: z.string().min(1),
  }),
  git: z.strictObject({
    repo_url: z.string().min(1),
    base_branch: z.string().min(1).default("main"),
    branch_prefix: z.string().min(1).default("ai"),
  }),
  agent: z
    .strictObject({
      max_turns: z.number().int().min(1).optional(),
      max_attempts: z.number().int().min(1).optional(),
      retry_backoff_ms: z.number().int().min(0).optional(),
    })
    .optional(),
  ci: z
    .strictObject({
      enabled: z.boolean().optional(),
      on_failure: z.enum(["ai-rework", "human-review"]).optional(),
      wait_for_pipeline: z.boolean().optional(),
    })
    .optional(),
});

const ProfileFrontMatterSchema = z.strictObject({
  tracker: z
    .strictObject({
      active_labels: z.array(z.string().min(1)).optional(),
      running_label: z.string().min(1).optional(),
      handoff_label: z.string().min(1).optional(),
      failed_label: z.string().min(1).optional(),
      blocked_label: z.string().min(1).optional(),
      rework_label: z.string().min(1).optional(),
      merging_label: z.string().min(1).optional(),
    })
    .optional(),
  agent: z
    .strictObject({
      runner: z.literal("codex-app-server").optional(),
      max_concurrent_agents: z.number().int().min(1).optional(),
      max_turns: z.number().int().min(1).optional(),
      max_attempts: z.number().int().min(1).optional(),
      retry_backoff_ms: z.number().int().min(0).optional(),
    })
    .optional(),
  codex: z
    .strictObject({
      command: z.string().min(1).optional(),
      approval_policy: z.enum(["never", "untrusted", "on-request"]).optional(),
      thread_sandbox: z.enum(["workspace-write", "read-only"]).optional(),
      turn_timeout_ms: z.number().int().min(1000).optional(),
      turn_sandbox_policy: z
        .strictObject({
          type: z.enum(["workspaceWrite", "readOnly"]).optional(),
        })
        .optional(),
    })
    .optional(),
  hooks: z
    .strictObject({
      after_create: z.string().min(1).optional(),
      before_run: z.string().min(1).optional(),
      after_run: z.string().min(1).optional(),
    })
    .optional(),
  ci: z
    .strictObject({
      enabled: z.boolean().optional(),
      on_failure: z.enum(["ai-rework", "human-review"]).optional(),
      wait_for_pipeline: z.boolean().optional(),
    })
    .optional(),
  poll_interval_ms: z.number().int().min(1000).optional(),
});
```

- [ ] **Step 5: Implement compile function**

In `central.ts`:

```ts
export async function compileCentralWorkflowProject(
  input: CompileCentralWorkflowProjectInput,
): Promise<WorkflowConfig> {
  const [projectRaw, profileRaw] = await Promise.all([
    readText(input.projectPath, "project"),
    readText(input.workflowProfilePath, "profile"),
  ]);

  const project = parseProjectFile(projectRaw);
  const profile = parseProfileFile(profileRaw);

  const frontMatter = {
    tracker: {
      kind: project.tracker.kind,
      base_url: project.tracker.base_url,
      project_id: project.tracker.project_id,
      active_labels: profile.data.tracker?.active_labels ?? ["ai-ready", "ai-rework"],
      running_label: profile.data.tracker?.running_label ?? "ai-running",
      handoff_label: profile.data.tracker?.handoff_label ?? "human-review",
      failed_label: profile.data.tracker?.failed_label ?? "ai-failed",
      blocked_label: profile.data.tracker?.blocked_label ?? "ai-blocked",
      rework_label: profile.data.tracker?.rework_label ?? "ai-rework",
      merging_label: profile.data.tracker?.merging_label ?? "ai-merging",
    },
    workspace: {
      root: input.defaults.workspaceRoot,
      strategy: "worktree",
      repo_cache_root: input.defaults.repoCacheRoot,
    },
    git: project.git,
    agent: {
      runner: profile.data.agent?.runner ?? "codex-app-server",
      max_concurrent_agents: profile.data.agent?.max_concurrent_agents ?? 1,
      max_turns:
        project.agent?.max_turns ?? profile.data.agent?.max_turns ?? 10,
      max_attempts:
        project.agent?.max_attempts ?? profile.data.agent?.max_attempts ?? 2,
      retry_backoff_ms:
        project.agent?.retry_backoff_ms ??
        profile.data.agent?.retry_backoff_ms ??
        30000,
    },
    codex: profile.data.codex ?? {},
    hooks: profile.data.hooks ?? {},
    ci: project.ci ?? profile.data.ci ?? {},
    poll_interval_ms: profile.data.poll_interval_ms ?? 10000,
  };

  const generatedRaw = `---\n${YAML.stringify(frontMatter).trimEnd()}\n---\n\n${profile.content.replace(/^\n+/, "")}`;

  try {
    return parseWorkflowString(generatedRaw, input.generatedSourcePath);
  } catch (err) {
    if (err instanceof WorkflowConfigError) {
      throw new CentralWorkflowConfigError(err.message, `effective.${err.path}`, {
        cause: err,
      });
    }
    throw err;
  }
}
```

Add helpers:

```ts
async function readText(path: string, label: "project" | "profile"): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw new CentralWorkflowConfigError(
      `failed to read ${label} file: ${err instanceof Error ? err.message : String(err)}`,
      label === "project" ? "project" : "profile",
      { cause: err },
    );
  }
}

function parseProjectFile(raw: string): z.infer<typeof ProjectFileSchema> {
  const parsed = YAML.parse(raw);
  try {
    return ProjectFileSchema.parse(parsed);
  } catch (err) {
    throw zodError("project", err);
  }
}

function parseProfileFile(raw: string): {
  data: z.infer<typeof ProfileFrontMatterSchema>;
  content: string;
} {
  const parsed = matter(raw);
  try {
    return {
      data: ProfileFrontMatterSchema.parse(parsed.data),
      content: parsed.content,
    };
  } catch (err) {
    throw zodError("profile", err);
  }
}

function zodError(prefix: string, err: unknown): CentralWorkflowConfigError {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const path = [prefix, ...(first?.path ?? [])].join(".");
    return new CentralWorkflowConfigError(
      `${path}: ${first?.message ?? "invalid central workflow config"}`,
      path,
      { cause: err },
    );
  }
  return new CentralWorkflowConfigError(String(err), prefix, { cause: err });
}
```

- [ ] **Step 6: Export compiler API**

In `packages/workflow/src/index.ts`:

```ts
export {
  CentralWorkflowConfigError,
  compileCentralWorkflowProject,
  type CentralWorkflowDefaults,
  type CompileCentralWorkflowProjectInput,
} from "./central.js";
```

- [ ] **Step 7: Run focused tests**

```bash
pnpm --filter @issuepilot/workflow test -- src/__tests__/central.test.ts src/__tests__/parse.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/workflow/src/central.ts packages/workflow/src/index.ts packages/workflow/src/__tests__/central.test.ts packages/workflow/src/__tests__/parse.test.ts
git commit -m "feat(workflow): compile central project profiles"
```

## Task 4: Registry Wiring

**Files:**
- Modify: `apps/orchestrator/src/team/registry.ts`
- Modify: `apps/orchestrator/src/team/__tests__/registry.test.ts`
- Modify: `apps/orchestrator/src/team/daemon.ts`
- Modify: `apps/orchestrator/src/team/__tests__/daemon.test.ts`

- [ ] **Step 1: Write failing registry tests**

In `apps/orchestrator/src/team/__tests__/registry.test.ts`, update fake config objects to use:

```ts
projects: [
  {
    id: "platform-web",
    name: "Platform Web",
    projectPath: "/srv/issuepilot-config/projects/platform-web.yaml",
    workflowProfilePath: "/srv/issuepilot-config/workflows/default-web.md",
    enabled: true,
    ci: null,
  },
],
defaults: {
  labelsPath: null,
  codexPath: null,
  workspaceRoot: "~/.issuepilot/workspaces",
  repoCacheRoot: "~/.issuepilot/repos",
},
```

Replace the workflow loader fake with a compiler fake:

```ts
const compileCentralWorkflowProject = vi.fn(async () => workflowConfig());
const registry = await createProjectRegistry(config, {
  compileCentralWorkflowProject,
});
expect(compileCentralWorkflowProject).toHaveBeenCalledWith(
  expect.objectContaining({
    projectId: "platform-web",
    projectPath: "/srv/issuepilot-config/projects/platform-web.yaml",
    workflowProfilePath: "/srv/issuepilot-config/workflows/default-web.md",
  }),
);
```

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/team/__tests__/registry.test.ts src/team/__tests__/daemon.test.ts
```

Expected: FAIL because registry still expects `WorkflowLoaderLike`.

- [ ] **Step 3: Replace registry dependency**

In `apps/orchestrator/src/team/registry.ts`:

```ts
import {
  compileCentralWorkflowProject as defaultCompileCentralWorkflowProject,
  type CompileCentralWorkflowProjectInput,
} from "@issuepilot/workflow";

export interface CentralWorkflowCompilerLike {
  compileCentralWorkflowProject(
    input: CompileCentralWorkflowProjectInput,
  ): Promise<WorkflowConfig>;
}
```

Change `RegisteredProject`:

```ts
export interface RegisteredProject {
  id: string;
  name: string;
  projectPath: string;
  workflowProfilePath: string;
  effectiveWorkflowPath: string;
  enabled: true;
  workflow: WorkflowConfig;
  lastPollAt: string | null;
  activeRuns: number;
}
```

In `createProjectRegistry`, call:

```ts
const effectiveWorkflowPath = path.join(
  path.dirname(config.source.path),
  ".generated",
  `${projectConfig.id}.workflow.md`,
);

const loadedWorkflow = await compiler.compileCentralWorkflowProject({
  projectId: projectConfig.id,
  projectPath: projectConfig.projectPath,
  workflowProfilePath: projectConfig.workflowProfilePath,
  defaults: config.defaults,
  generatedSourcePath: effectiveWorkflowPath,
});
```

Keep effective CI override:

```ts
const workflow: WorkflowConfig = {
  ...loadedWorkflow,
  ci: resolveEffectiveCi(loadedWorkflow.ci, config.ci, projectConfig.ci),
};
```

- [ ] **Step 4: Update project summaries**

Return new source fields in `summaryFor`:

```ts
return {
  id: project.id,
  name: project.name,
  projectPath: project.projectPath,
  profilePath: project.workflowProfilePath,
  effectiveWorkflowPath: project.effectiveWorkflowPath,
  gitlabProject: project.workflow.tracker.projectId,
  enabled: true,
  activeRuns: project.activeRuns,
  lastPollAt: project.lastPollAt,
};
```

For disabled/load-error entries:

```ts
const base: ProjectSummary = {
  id: entry.config.id,
  name: entry.config.name,
  projectPath: entry.config.projectPath,
  profilePath: entry.config.workflowProfilePath,
  effectiveWorkflowPath: "",
  gitlabProject: "",
  enabled: false,
  activeRuns: 0,
  lastPollAt: null,
  disabledReason: entry.state.reason,
};
```

- [ ] **Step 5: Update daemon dependency injection**

In `apps/orchestrator/src/team/daemon.ts`, remove `workflowLoader` from team registry construction and pass compiler dependency:

```ts
const registry = await createProjectRegistry(config, {
  compileCentralWorkflowProject:
    deps.compileCentralWorkflowProject ?? defaultCompileCentralWorkflowProject,
});
```

Update `StartTeamDaemonDeps` accordingly.

- [ ] **Step 6: Run focused tests**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/team/__tests__/registry.test.ts src/team/__tests__/daemon.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/orchestrator/src/team/registry.ts apps/orchestrator/src/team/__tests__/registry.test.ts apps/orchestrator/src/team/daemon.ts apps/orchestrator/src/team/__tests__/daemon.test.ts
git commit -m "feat(team): load central project profiles"
```

## Task 5: CLI Validate and Render Workflow

**Files:**
- Modify: `apps/orchestrator/src/cli.ts`
- Modify: `apps/orchestrator/src/__tests__/cli.test.ts`

- [ ] **Step 1: Write failing CLI tests**

In `apps/orchestrator/src/__tests__/cli.test.ts`, update `validate --config` expectations:

```ts
expect(stdout).toContain("project=/srv/issuepilot-config/projects/platform-web.yaml");
expect(stdout).toContain("profile=/srv/issuepilot-config/workflows/default-web.md");
```

Add a render command test:

```ts
it("render-workflow prints the effective workflow for one team project", async () => {
  const compileCentralWorkflowProject = vi.fn(async () => workflowConfig());
  const cli = createCli({
    loadTeamConfig: async () => teamConfig(),
    compileCentralWorkflowProject,
  });

  await cli.parseAsync(
    [
      "render-workflow",
      "--config",
      "/srv/issuepilot-config/issuepilot.team.yaml",
      "--project",
      "platform-web",
    ],
    { from: "user" },
  );

  expect(stdout).toContain("tracker:");
  expect(stdout).toContain("project_id: group/platform-web");
  expect(stdout).not.toContain("token");
});
```

- [ ] **Step 2: Run focused CLI tests and confirm failure**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/__tests__/cli.test.ts
```

Expected: FAIL because output and `render-workflow` do not exist.

- [ ] **Step 3: Update validate output**

In the `validate --config` branch of `apps/orchestrator/src/cli.ts`, print:

```ts
console.log(`Team config loaded: ${config.source.path}`);
console.log("Projects:");
for (const p of config.projects) {
  const flag = p.enabled ? "enabled" : "disabled";
  console.log(`  - [${flag}] ${p.id}`);
  console.log(`    project=${p.projectPath}`);
  console.log(`    profile=${p.workflowProfilePath}`);
}
```

- [ ] **Step 4: Add render command**

Add a command:

```ts
program
  .command("render-workflow")
  .description("Render one effective workflow from issuepilot.team.yaml.")
  .requiredOption("--config <path>", "Path to issuepilot.team.yaml")
  .requiredOption("--project <id>", "Team project id")
  .action(async (opts) => {
    const config = await loadTeamConfig(path.resolve(opts.config));
    const project = config.projects.find((p) => p.id === opts.project);
    if (!project) {
      console.error(`Error: project not found in team config: ${opts.project}`);
      process.exitCode = 1;
      return;
    }
    const workflow = await compileCentralWorkflowProject({
      projectId: project.id,
      projectPath: project.projectPath,
      workflowProfilePath: project.workflowProfilePath,
      defaults: config.defaults,
      generatedSourcePath: path.join(
        path.dirname(config.source.path),
        ".generated",
        `${project.id}.workflow.md`,
      ),
    });
    console.log(renderWorkflowYaml(workflow));
  });
```

Add a local helper that does not print secrets:

```ts
function renderWorkflowYaml(workflow: WorkflowConfig): string {
  return YAML.stringify({
    tracker: {
      kind: workflow.tracker.kind,
      base_url: workflow.tracker.baseUrl,
      project_id: workflow.tracker.projectId,
      active_labels: workflow.tracker.activeLabels,
      running_label: workflow.tracker.runningLabel,
      handoff_label: workflow.tracker.handoffLabel,
      failed_label: workflow.tracker.failedLabel,
      blocked_label: workflow.tracker.blockedLabel,
      rework_label: workflow.tracker.reworkLabel,
      merging_label: workflow.tracker.mergingLabel,
    },
    workspace: {
      root: workflow.workspace.root,
      strategy: workflow.workspace.strategy,
      repo_cache_root: workflow.workspace.repoCacheRoot,
    },
    git: {
      repo_url: workflow.git.repoUrl,
      base_branch: workflow.git.baseBranch,
      branch_prefix: workflow.git.branchPrefix,
    },
    agent: {
      runner: workflow.agent.runner,
      max_concurrent_agents: workflow.agent.maxConcurrentAgents,
      max_turns: workflow.agent.maxTurns,
      max_attempts: workflow.agent.maxAttempts,
      retry_backoff_ms: workflow.agent.retryBackoffMs,
    },
    codex: {
      command: workflow.codex.command,
      approval_policy: workflow.codex.approvalPolicy,
      thread_sandbox: workflow.codex.threadSandbox,
      turn_timeout_ms: workflow.codex.turnTimeoutMs,
      turn_sandbox_policy: workflow.codex.turnSandboxPolicy,
    },
    ci: {
      enabled: workflow.ci.enabled,
      on_failure: workflow.ci.onFailure,
      wait_for_pipeline: workflow.ci.waitForPipeline,
    },
  });
}
```

- [ ] **Step 5: Run focused CLI tests**

```bash
pnpm --filter @issuepilot/orchestrator test -- src/__tests__/cli.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/cli.ts apps/orchestrator/src/__tests__/cli.test.ts
git commit -m "feat(cli): render central effective workflows"
```

## Task 6: Shared State and Dashboard Source Display

**Files:**
- Modify: `packages/shared-contracts/src/state.ts`
- Modify: `packages/shared-contracts/src/__tests__/state.test.ts`
- Modify: `apps/dashboard/components/overview/project-list.tsx`
- Modify: `apps/dashboard/components/overview/project-list.test.tsx`
- Modify: `apps/dashboard/components/overview/service-header.tsx`
- Modify: `apps/dashboard/components/overview/service-header.test.tsx`

- [ ] **Step 1: Write failing contract and UI tests**

Update `ProjectSummary` tests to expect:

```ts
projectPath: "/srv/issuepilot-config/projects/platform-web.yaml",
profilePath: "/srv/issuepilot-config/workflows/default-web.md",
effectiveWorkflowPath: "/srv/issuepilot-config/.generated/platform-web.workflow.md",
```

Update dashboard project-list tests to expect the profile filename:

```ts
expect(screen.getByText("default-web.md")).toBeInTheDocument();
expect(screen.getByText("platform-web.yaml")).toBeInTheDocument();
```

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
pnpm --filter @issuepilot/shared-contracts test -- src/__tests__/state.test.ts
pnpm --filter @issuepilot/dashboard test -- components/overview/project-list.test.tsx components/overview/service-header.test.tsx
```

Expected: FAIL because state and UI still use `workflowPath`.

- [ ] **Step 3: Extend shared contract**

In `packages/shared-contracts/src/state.ts`, replace project source field:

```ts
export interface ProjectSummary {
  id: string;
  name: string;
  projectPath: string;
  profilePath: string;
  effectiveWorkflowPath: string;
  gitlabProject: string;
  enabled: boolean;
  activeRuns: number;
  lastPollAt: string | null;
  disabledReason?: "config" | "load-error";
  lastError?: string;
}
```

If keeping `workflowPath` temporarily causes fewer edits, keep it only as `effectiveWorkflowPath` alias in runtime objects, not as public source-of-truth text.

- [ ] **Step 4: Update dashboard rendering**

In `apps/dashboard/components/overview/project-list.tsx`, render filenames:

```tsx
const profileName = project.profilePath.split("/").at(-1) ?? project.profilePath;
const projectName = project.projectPath.split("/").at(-1) ?? project.projectPath;
```

Display:

```tsx
<span title={project.profilePath}>{profileName}</span>
<span title={project.projectPath}>{projectName}</span>
```

Keep disabled/load-error badge behavior unchanged.

- [ ] **Step 5: Run focused tests**

```bash
pnpm --filter @issuepilot/shared-contracts test -- src/__tests__/state.test.ts
pnpm --filter @issuepilot/dashboard test -- components/overview/project-list.test.tsx components/overview/service-header.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared-contracts/src/state.ts packages/shared-contracts/src/__tests__/state.test.ts apps/dashboard/components/overview/project-list.tsx apps/dashboard/components/overview/project-list.test.tsx apps/dashboard/components/overview/service-header.tsx apps/dashboard/components/overview/service-header.test.tsx
git commit -m "feat(dashboard): show central workflow sources"
```

## Task 7: Docs, Fixtures, and Final Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `USAGE.md`
- Modify: `USAGE.zh-CN.md`
- Modify: `docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`
- Modify: `docs/superpowers/specs/2026-05-17-issuepilot-central-workflow-config-design.md`
- Modify: existing test fixtures under `apps/orchestrator/src/**/__tests__` as needed

- [ ] **Step 1: Update README/USAGE examples**

Replace team-mode examples that show:

```yaml
projects:
  - id: platform-web
    workflow: /srv/repos/platform-web/WORKFLOW.md
```

with:

```yaml
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
```

Add the project file example:

```yaml
tracker:
  kind: gitlab
  base_url: https://gitlab.example.com
  project_id: group/platform-web

git:
  repo_url: git@gitlab.example.com:group/platform-web.git
  base_branch: main
  branch_prefix: ai
```

Add the profile file example:

```md
---
agent:
  runner: codex-app-server
  max_concurrent_agents: 1
codex:
  approval_policy: never
  thread_sandbox: workspace-write
---

处理 `{{ project.tracker.project_id }}` 的 GitLab Issue。
```

- [ ] **Step 2: Update spec status**

In `docs/superpowers/specs/2026-05-17-issuepilot-central-workflow-config-design.md`, set:

```md
状态：已确认，实施计划已补充
对应计划：`docs/superpowers/plans/2026-05-17-issuepilot-central-workflow-config.md`
```

In V2 total spec, ensure the central config design row/link references this plan.

- [ ] **Step 3: Run repo searches**

```bash
rg -n "workflow: /srv|projects\\[\\]\\.workflow|repo-owned `WORKFLOW.md` 仍|兼容加载" README.md README.zh-CN.md USAGE.md USAGE.zh-CN.md docs/superpowers/specs apps/orchestrator/src packages/shared-contracts/src
```

Expected: no positive recommendation for `projects[].workflow`; only historical or explicit “not supported” references remain.

- [ ] **Step 4: Run focused package tests**

```bash
pnpm --filter @issuepilot/workflow test
pnpm --filter @issuepilot/orchestrator test -- src/team/__tests__/config.test.ts src/team/__tests__/registry.test.ts src/team/__tests__/daemon.test.ts src/__tests__/cli.test.ts
pnpm --filter @issuepilot/shared-contracts test
pnpm --filter @issuepilot/dashboard test -- components/overview/project-list.test.tsx components/overview/service-header.test.tsx
```

Expected: all PASS.

- [ ] **Step 5: Run typecheck/build for touched packages**

```bash
pnpm --filter @issuepilot/workflow typecheck
pnpm --filter @issuepilot/orchestrator typecheck
pnpm --filter @issuepilot/shared-contracts typecheck
pnpm --filter @issuepilot/dashboard typecheck
```

Expected: all PASS.

- [ ] **Step 6: Run whitespace validation**

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 7: Commit docs and fixture cleanup**

```bash
git add README.md README.zh-CN.md USAGE.md USAGE.zh-CN.md docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md docs/superpowers/specs/2026-05-17-issuepilot-central-workflow-config-design.md apps/orchestrator/src packages/shared-contracts/src apps/dashboard/components
git commit -m "docs(issuepilot): document central workflow config"
```

## Self-Review

Spec coverage:

- 中心配置仓库和 `issuepilot.team.yaml` 入口：Task 2、Task 3、Task 7。
- `projects[].workflow` 无兼容层：Task 2、Task 5、Task 7。
- project file + workflow profile 编译：Task 3、Task 4。
- 高风险运行字段只在中心配置/profile 控制：Task 3。
- `render-workflow` 排障能力：Task 5。
- dashboard/source 展示：Task 6。
- README/USAGE/spec 同步：Task 7。

Placeholder scan:

- 红旗扫描通过，没有使用禁用的任务描述。
- 每个代码变更任务都包含测试、实现轮廓、命令和提交边界。

Type consistency:

- Public team project fields统一为 `projectPath`、`workflowProfilePath`、`effectiveWorkflowPath`。
- Shared contract display fields统一为 `projectPath`、`profilePath`、`effectiveWorkflowPath`。
- Compiler API统一为 `compileCentralWorkflowProject(input)`。
