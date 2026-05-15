import type { WorkflowConfig } from "@issuepilot/workflow";
import { describe, expect, it, vi } from "vitest";

import type { TeamConfig } from "../config.js";
import { createProjectRegistry } from "../registry.js";

interface WorkflowLoaderLike {
  loadOnce: (workflowPath: string) => Promise<WorkflowConfig>;
}

function workflow(projectId: string, workflowPath: string): WorkflowConfig {
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
    pollIntervalMs: 10_000,
    promptTemplate: "Fix {{ issue.title }}",
    source: {
      path: workflowPath,
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
    projects: [
      {
        id: "platform-web",
        name: "Platform Web",
        workflowPath: "/srv/platform-web/WORKFLOW.md",
        enabled: true,
        ci: null,
      },
      {
        id: "infra-tools",
        name: "Infra Tools",
        workflowPath: "/srv/infra-tools/WORKFLOW.md",
        enabled: false,
        ci: null,
      },
    ],
    retention: {
      successfulRunDays: 7,
      failedRunDays: 14,
      maxWorkspaceGb: 20,
    },
    ci: null,
    source: {
      path: "/srv/issuepilot/issuepilot.team.yaml",
      sha256: "sha",
      loadedAt: new Date(0).toISOString(),
    },
  };
}

describe("project registry", () => {
  it("loads enabled projects and reports disabled projects as summaries", async () => {
    const loader: WorkflowLoaderLike = {
      loadOnce: vi.fn(async (workflowPath: string) =>
        workflow("group/platform-web", workflowPath),
      ),
    };

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
      disabledReason: "config",
    });
  });

  it("captures workflow load failures as disabled project summaries", async () => {
    const loader: WorkflowLoaderLike = {
      loadOnce: vi.fn(async () => {
        throw new Error("workflow missing tracker.project_id");
      }),
    };

    const config: TeamConfig = {
      ...teamConfig(),
      projects: [
        {
          id: "platform-web",
          name: "Platform Web",
          workflowPath: "/srv/platform-web/WORKFLOW.md",
          enabled: true,
          ci: null,
        },
      ],
    };

    const registry = await createProjectRegistry(config, loader);

    expect(registry.enabledProjects()).toHaveLength(0);
    expect(registry.summaries()[0]).toMatchObject({
      id: "platform-web",
      enabled: false,
      disabledReason: "load-error",
      lastError: "workflow missing tracker.project_id",
    });
  });

  it("uses workflow.ci verbatim when neither team nor project ci is set", async () => {
    const loader: WorkflowLoaderLike = {
      loadOnce: vi.fn(async (workflowPath: string) => {
        const wf = workflow("group/platform-web", workflowPath);
        wf.ci = {
          enabled: true,
          onFailure: "human-review",
          waitForPipeline: false,
        };
        return wf;
      }),
    };

    const registry = await createProjectRegistry(teamConfig(), loader);

    expect(registry.project("platform-web")?.workflow.ci).toEqual({
      enabled: true,
      onFailure: "human-review",
      waitForPipeline: false,
    });
  });

  it("applies team.ci as the override when project.ci is null", async () => {
    const loader: WorkflowLoaderLike = {
      loadOnce: vi.fn(async (workflowPath: string) =>
        workflow("group/platform-web", workflowPath),
      ),
    };

    const config: TeamConfig = {
      ...teamConfig(),
      ci: {
        enabled: true,
        onFailure: "human-review",
        waitForPipeline: false,
      },
    };

    const registry = await createProjectRegistry(config, loader);

    // workflow.ci ships with `{ enabled: false, onFailure: "ai-rework",
    // waitForPipeline: true }`; team.ci must fully replace it.
    expect(registry.project("platform-web")?.workflow.ci).toEqual({
      enabled: true,
      onFailure: "human-review",
      waitForPipeline: false,
    });
  });

  it("project.ci wins over team.ci when both are present", async () => {
    const loader: WorkflowLoaderLike = {
      loadOnce: vi.fn(async (workflowPath: string) =>
        workflow("group/platform-web", workflowPath),
      ),
    };

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

    const registry = await createProjectRegistry(config, loader);

    expect(registry.project("platform-web")?.workflow.ci).toEqual({
      enabled: true,
      onFailure: "ai-rework",
      waitForPipeline: true,
    });
  });
});
