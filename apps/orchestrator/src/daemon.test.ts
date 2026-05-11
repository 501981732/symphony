import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowConfig, WorkflowLoader } from "@issuepilot/workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "./daemon.js";

describe("daemon startup", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "daemon-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function workflow(): WorkflowConfig {
    return {
      tracker: {
        kind: "gitlab",
        baseUrl: "https://gitlab.example.com",
        projectId: "group/project",
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
        root: tmpDir,
        strategy: "worktree",
        repoCacheRoot: join(tmpDir, "cache"),
      },
      git: {
        repoUrl: "git@example.com:group/project.git",
        baseBranch: "main",
        branchPrefix: "issuepilot",
      },
      agent: {
        runner: "codex-app-server",
        maxConcurrentAgents: 2,
        maxTurns: 3,
        maxAttempts: 2,
        retryBackoffMs: 1000,
      },
      codex: {
        command: "codex app-server",
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
        turnTimeoutMs: 60_000,
        turnSandboxPolicy: { type: "workspaceWrite" },
      },
      hooks: {},
      promptTemplate: "Fix {{ issue.title }}",
      source: {
        path: join(tmpDir, "workflow.md"),
        sha256: "sha",
        loadedAt: new Date(0).toISOString(),
      },
    };
  }

  it("loads workflow, starts API server, starts loop, and stops cleanly", async () => {
    const cfg = workflow();
    const watcher = {
      current: vi.fn(() => cfg),
      stop: vi.fn(async () => undefined),
    };
    const workflowLoader: WorkflowLoader = {
      loadOnce: vi.fn(async () => cfg),
      start: vi.fn(async () => watcher),
      render: vi.fn(async () => "prompt"),
    };
    const app = { close: vi.fn(async () => undefined) };
    const createServer = vi.fn(async () => app as never);
    const loop = { tick: vi.fn(), stop: vi.fn(async () => undefined) };
    const startLoop = vi.fn(() => loop);

    const handle = await startDaemon(
      {
        workflowPath: cfg.source.path,
        host: "127.0.0.1",
        port: 4789,
      },
      {
        workflowLoader,
        createGitLab: () =>
          ({
            listCandidateIssues: vi.fn(async () => []),
            getIssue: vi.fn(),
            transitionLabels: vi.fn(),
            createIssueNote: vi.fn(),
            updateIssueNote: vi.fn(),
            findWorkpadNote: vi.fn(),
            createMergeRequest: vi.fn(),
            updateMergeRequest: vi.fn(),
            getMergeRequest: vi.fn(),
            listMergeRequestNotes: vi.fn(),
            getPipelineStatus: vi.fn(),
          }) as never,
        createServer,
        startLoop,
      },
    );

    expect(workflowLoader.loadOnce).toHaveBeenCalledWith(cfg.source.path);
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowPath: cfg.source.path,
        gitlabProject: "group/project",
        concurrency: 2,
      }),
      { host: "127.0.0.1", port: 4789 },
    );
    expect(startLoop).toHaveBeenCalled();
    expect(handle.url).toBe("http://127.0.0.1:4789");

    await handle.stop();

    expect(loop.stop).toHaveBeenCalled();
    expect(watcher.stop).toHaveBeenCalled();
    expect(app.close).toHaveBeenCalled();
  });
});
