import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { parseWorkflowFile, WorkflowConfigError } from "../parse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  path.join(here, "..", "..", "tests", "fixtures", name);

describe("parseWorkflowFile", () => {
  it("解析合法 front matter 并返回 prompt body", async () => {
    const cfg = await parseWorkflowFile(fixture("workflow.valid.md"));

    expect(cfg.tracker.kind).toBe("gitlab");
    expect(cfg.tracker.baseUrl).toBe("https://gitlab.example.com");
    expect(cfg.tracker.projectId).toBe("group/project");
    expect(cfg.tracker.tokenEnv).toBe("ISSUEPILOT_TEST_TOKEN");
    expect(cfg.tracker.activeLabels).toEqual(["ai-ready", "ai-rework"]);
    expect(cfg.tracker.runningLabel).toBe("ai-running");
    expect(cfg.tracker.handoffLabel).toBe("human-review");
    expect(cfg.tracker.failedLabel).toBe("ai-failed");
    expect(cfg.tracker.blockedLabel).toBe("ai-blocked");
    expect(cfg.tracker.reworkLabel).toBe("ai-rework");
    expect(cfg.tracker.mergingLabel).toBe("ai-merging");

    expect(cfg.workspace.root).toBe("~/.issuepilot/workspaces");
    expect(cfg.workspace.strategy).toBe("worktree");
    expect(cfg.workspace.repoCacheRoot).toBe("~/.issuepilot/repos");

    expect(cfg.git.repoUrl).toBe("git@gitlab.example.com:group/project.git");
    expect(cfg.git.baseBranch).toBe("main");
    expect(cfg.git.branchPrefix).toBe("ai");

    expect(cfg.agent.runner).toBe("codex-app-server");
    expect(cfg.agent.maxConcurrentAgents).toBe(1);
    expect(cfg.agent.maxTurns).toBe(10);
    expect(cfg.agent.maxAttempts).toBe(2);
    expect(cfg.agent.retryBackoffMs).toBe(30_000);

    expect(cfg.codex.command).toBe("codex app-server");
    expect(cfg.codex.approvalPolicy).toBe("never");
    expect(cfg.codex.threadSandbox).toBe("workspace-write");
    expect(cfg.codex.turnTimeoutMs).toBe(3_600_000);
    expect(cfg.codex.turnSandboxPolicy).toEqual({ type: "workspaceWrite" });

    expect(cfg.hooks.afterCreate).toMatch(/pnpm install/);
    expect(cfg.hooks.beforeRun).toMatch(/git fetch origin/);
    expect(cfg.hooks.afterRun).toMatch(/pnpm test/);

    expect(cfg.ci).toEqual({
      enabled: false,
      onFailure: "ai-rework",
      waitForPipeline: true,
    });

    expect(cfg.promptTemplate).toMatch(/Issue: \{\{ issue.identifier \}\}/);
    expect(cfg.promptTemplate).toMatch(/You are the AI engineer/);

    expect(cfg.source.path).toBe(fixture("workflow.valid.md"));
    expect(cfg.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => new Date(cfg.source.loadedAt)).not.toThrow();
  });

  it("最小 front matter 会被默认值补齐", async () => {
    const cfg = await parseWorkflowFile(fixture("workflow.minimal.md"));

    expect(cfg.tracker.activeLabels).toEqual(["ai-ready", "ai-rework"]);
    expect(cfg.tracker.runningLabel).toBe("ai-running");
    expect(cfg.tracker.handoffLabel).toBe("human-review");
    expect(cfg.tracker.failedLabel).toBe("ai-failed");
    expect(cfg.tracker.blockedLabel).toBe("ai-blocked");
    expect(cfg.tracker.reworkLabel).toBe("ai-rework");
    expect(cfg.tracker.mergingLabel).toBe("ai-merging");

    expect(cfg.workspace.root).toBe("~/.issuepilot/workspaces");
    expect(cfg.workspace.strategy).toBe("worktree");
    expect(cfg.workspace.repoCacheRoot).toBe("~/.issuepilot/repos");

    expect(cfg.git.baseBranch).toBe("main");
    expect(cfg.git.branchPrefix).toBe("ai");

    expect(cfg.agent.runner).toBe("codex-app-server");
    expect(cfg.agent.maxConcurrentAgents).toBe(1);
    expect(cfg.agent.maxTurns).toBe(10);
    expect(cfg.agent.maxAttempts).toBe(2);
    expect(cfg.agent.retryBackoffMs).toBe(30_000);

    expect(cfg.codex.command).toBe("codex app-server");
    expect(cfg.codex.approvalPolicy).toBe("never");
    expect(cfg.codex.threadSandbox).toBe("workspace-write");
    expect(cfg.codex.turnTimeoutMs).toBe(3_600_000);
    expect(cfg.codex.turnSandboxPolicy).toEqual({ type: "workspaceWrite" });

    expect(cfg.hooks.afterCreate).toBeUndefined();
    expect(cfg.hooks.beforeRun).toBeUndefined();
    expect(cfg.hooks.afterRun).toBeUndefined();

    expect(cfg.ci).toEqual({
      enabled: false,
      onFailure: "ai-rework",
      waitForPipeline: true,
    });
  });

  it("ci.enabled 与 on_failure 自定义值会被透传", async () => {
    const cfg = await parseWorkflowFile(fixture("workflow.ci-enabled.md"));

    expect(cfg.ci).toEqual({
      enabled: true,
      onFailure: "human-review",
      waitForPipeline: false,
    });
  });

  it("ci.on_failure 仅接受 ai-rework / human-review 枚举", async () => {
    await expect(
      parseWorkflowFile(fixture("workflow.ci-bad-on-failure.md")),
    ).rejects.toMatchObject({
      name: "WorkflowConfigError",
      path: "ci.on_failure",
    });
  });

  it("缺少 tracker 时抛 WorkflowConfigError 且包含字段路径", async () => {
    await expect(
      parseWorkflowFile(fixture("workflow.missing-tracker.md")),
    ).rejects.toMatchObject({
      name: "WorkflowConfigError",
      path: "tracker",
    });
  });

  it("缺少 tracker 时抛出的错误是 WorkflowConfigError 类型", async () => {
    await expect(
      parseWorkflowFile(fixture("workflow.missing-tracker.md")),
    ).rejects.toBeInstanceOf(WorkflowConfigError);
  });

  it("YAML 解析失败时抛出 WorkflowConfigError 且 path 指向 front-matter", async () => {
    await expect(
      parseWorkflowFile(fixture("workflow.bad-yaml.md")),
    ).rejects.toMatchObject({
      name: "WorkflowConfigError",
      path: "<front-matter>",
    });
  });

  it("不存在的文件抛 WorkflowConfigError 且 path = <file>", async () => {
    await expect(
      parseWorkflowFile(fixture("workflow.does-not-exist.md")),
    ).rejects.toMatchObject({
      name: "WorkflowConfigError",
      path: "<file>",
    });
  });

  it("拒绝 workflow 将 Codex sandbox 提升到 danger-full-access", async () => {
    await expect(
      parseWorkflowFile(fixture("workflow.danger-sandbox.md")),
    ).rejects.toMatchObject({
      name: "WorkflowConfigError",
      path: "codex.thread_sandbox",
    });
  });

  it("拒绝非法 tracker.token_env 名称", async () => {
    await expect(
      parseWorkflowFile(fixture("workflow.invalid-token-env.md")),
    ).rejects.toMatchObject({
      name: "WorkflowConfigError",
      path: "tracker.token_env",
    });
  });
});
