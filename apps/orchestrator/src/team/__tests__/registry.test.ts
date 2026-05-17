import type {
  CompileCentralWorkflowProjectInput,
  WorkflowConfig,
} from "@issuepilot/workflow";
import { describe, expect, it, vi } from "vitest";

import type { TeamConfig } from "../config.js";
import { createProjectRegistry } from "../registry.js";

function workflow(projectId: string, sourcePath: string): WorkflowConfig {
  return {
    tracker: {
      kind: "gitlab",
      baseUrl: "https://gitlab.example.com",
      projectId,
      tokenEnv: "GITLAB_TOKEN",
      activeLabels: ["ai-ready"],
      runningLabel: "ai-running",
      handoffLabel: "human-review",
      failedLabel: "ai-failed",
      blockedLabel: "ai-blocked",
      reworkLabel: "ai-rework",
      mergingLabel: "ai-merging",
    },
    workspace: {
      root: "/tmp/issuepilot",
      strategy: "worktree",
      repoCacheRoot: "/tmp/issuepilot/cache",
    },
    git: {
      repoUrl: "git@example.com:group/project.git",
      baseBranch: "main",
      branchPrefix: "issuepilot",
    },
    agent: {
      runner: "codex-app-server",
      maxConcurrentAgents: 1,
      maxTurns: 3,
      maxAttempts: 2,
      retryBackoffMs: 1_000,
    },
    codex: {
      command: "codex app-server",
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnTimeoutMs: 60_000,
      turnSandboxPolicy: { type: "workspaceWrite" },
    },
    hooks: {},
    ci: {
      enabled: false,
      onFailure: "ai-rework",
      waitForPipeline: true,
    },
    retention: {
      successfulRunDays: 7,
      failedRunDays: 30,
      maxWorkspaceGb: 50,
      cleanupIntervalMs: 3_600_000,
    },
    pollIntervalMs: 10_000,
    promptTemplate: "Fix {{ issue.title }}",
    source: {
      path: sourcePath,
      sha256: "sha",
      loadedAt: new Date(0).toISOString(),
    },
  };
}

function teamConfig(): TeamConfig {
  return {
    version: 1,
    server: { host: "127.0.0.1", port: 4738 },
    scheduler: {
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerProject: 1,
      leaseTtlMs: 900_000,
      pollIntervalMs: 10_000,
    },
    defaults: {
      labelsPath: null,
      codexPath: null,
      workspaceRoot: "~/.issuepilot/workspaces",
      repoCacheRoot: "~/.issuepilot/repos",
    },
    projects: [
      {
        id: "platform-web",
        name: "Platform Web",
        projectPath: "/srv/issuepilot-config/projects/platform-web.yaml",
        workflowProfilePath:
          "/srv/issuepilot-config/workflows/default-web.md",
        enabled: true,
        ci: null,
      },
      {
        id: "infra-tools",
        name: "Infra Tools",
        projectPath: "/srv/issuepilot-config/projects/infra-tools.yaml",
        workflowProfilePath:
          "/srv/issuepilot-config/workflows/default-node-lib.md",
        enabled: false,
        ci: null,
      },
    ],
    retention: {
      successfulRunDays: 7,
      failedRunDays: 14,
      maxWorkspaceGb: 20,
      cleanupIntervalMs: 3_600_000,
    },
    ci: null,
    source: {
      path: "/srv/issuepilot-config/issuepilot.team.yaml",
      sha256: "sha",
      loadedAt: new Date(0).toISOString(),
    },
  };
}

describe("project registry", () => {
  it("compiles enabled projects from central config and reports disabled projects as summaries", async () => {
    const compileCentralWorkflowProject = vi.fn(
      async (input: CompileCentralWorkflowProjectInput) =>
        workflow("group/platform-web", input.generatedSourcePath),
    );

    const registry = await createProjectRegistry(teamConfig(), {
      compileCentralWorkflowProject,
    });

    expect(compileCentralWorkflowProject).toHaveBeenCalledTimes(1);
    expect(compileCentralWorkflowProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "platform-web",
        projectPath: "/srv/issuepilot-config/projects/platform-web.yaml",
        workflowProfilePath:
          "/srv/issuepilot-config/workflows/default-web.md",
        generatedSourcePath:
          "/srv/issuepilot-config/.generated/platform-web.workflow.md",
        defaults: expect.objectContaining({
          workspaceRoot: "~/.issuepilot/workspaces",
          repoCacheRoot: "~/.issuepilot/repos",
        }),
      }),
    );
    expect(registry.enabledProjects()).toHaveLength(1);
    expect(registry.project("platform-web")?.workflow.tracker.projectId).toBe(
      "group/platform-web",
    );
    expect(registry.summaries()[0]).toMatchObject({
      id: "platform-web",
      projectPath: "/srv/issuepilot-config/projects/platform-web.yaml",
      profilePath: "/srv/issuepilot-config/workflows/default-web.md",
      effectiveWorkflowPath:
        "/srv/issuepilot-config/.generated/platform-web.workflow.md",
      gitlabProject: "group/platform-web",
      enabled: true,
    });
    expect(registry.summaries()[1]).toMatchObject({
      id: "infra-tools",
      projectPath: "/srv/issuepilot-config/projects/infra-tools.yaml",
      profilePath: "/srv/issuepilot-config/workflows/default-node-lib.md",
      effectiveWorkflowPath: "",
      gitlabProject: "",
      enabled: false,
      disabledReason: "config",
    });
  });

  it("captures workflow compile failures as disabled project summaries", async () => {
    const compileCentralWorkflowProject = vi.fn(async () => {
      throw new Error("project.tracker.project_id: required");
    });

    const config: TeamConfig = {
      ...teamConfig(),
      projects: [
        {
          id: "platform-web",
          name: "Platform Web",
          projectPath: "/srv/issuepilot-config/projects/platform-web.yaml",
          workflowProfilePath:
            "/srv/issuepilot-config/workflows/default-web.md",
          enabled: true,
          ci: null,
        },
      ],
    };

    const registry = await createProjectRegistry(config, {
      compileCentralWorkflowProject,
    });

    expect(registry.enabledProjects()).toHaveLength(0);
    expect(registry.summaries()[0]).toMatchObject({
      id: "platform-web",
      enabled: false,
      disabledReason: "load-error",
      lastError: "project.tracker.project_id: required",
    });
  });

  it("uses workflow.ci verbatim when neither team nor project ci is set", async () => {
    const compileCentralWorkflowProject = vi.fn(
      async (input: CompileCentralWorkflowProjectInput) => {
        const wf = workflow("group/platform-web", input.generatedSourcePath);
        wf.ci = {
          enabled: true,
          onFailure: "human-review",
          waitForPipeline: false,
        };
        return wf;
      },
    );

    const registry = await createProjectRegistry(teamConfig(), {
      compileCentralWorkflowProject,
    });

    expect(registry.project("platform-web")?.workflow.ci).toEqual({
      enabled: true,
      onFailure: "human-review",
      waitForPipeline: false,
    });
  });

  it("applies team.ci as the override when project.ci is null", async () => {
    const compileCentralWorkflowProject = vi.fn(
      async (input: CompileCentralWorkflowProjectInput) =>
        workflow("group/platform-web", input.generatedSourcePath),
    );

    const config: TeamConfig = {
      ...teamConfig(),
      ci: {
        enabled: true,
        onFailure: "human-review",
        waitForPipeline: false,
      },
    };

    const registry = await createProjectRegistry(config, {
      compileCentralWorkflowProject,
    });

    expect(registry.project("platform-web")?.workflow.ci).toEqual({
      enabled: true,
      onFailure: "human-review",
      waitForPipeline: false,
    });
  });

  it("project.ci wins over team.ci when both are present", async () => {
    const compileCentralWorkflowProject = vi.fn(
      async (input: CompileCentralWorkflowProjectInput) =>
        workflow("group/platform-web", input.generatedSourcePath),
    );

    const base = teamConfig();
    const config: TeamConfig = {
      ...base,
      ci: {
        enabled: true,
        onFailure: "human-review",
        waitForPipeline: false,
      },
      projects: base.projects.map((p) =>
        p.id === "platform-web"
          ? {
              ...p,
              ci: {
                enabled: true,
                onFailure: "ai-rework",
                waitForPipeline: true,
              },
            }
          : p,
      ),
    };

    const registry = await createProjectRegistry(config, {
      compileCentralWorkflowProject,
    });

    expect(registry.project("platform-web")?.workflow.ci).toEqual({
      enabled: true,
      onFailure: "ai-rework",
      waitForPipeline: true,
    });
  });
});
