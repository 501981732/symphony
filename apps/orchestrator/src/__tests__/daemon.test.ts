import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { GitLabAdapter } from "@issuepilot/tracker-gitlab";
import type { WorkflowConfig } from "@issuepilot/workflow";
import { describe, expect, it, vi } from "vitest";

import { hostnameFromBaseUrl, splitCommand } from "../daemon.js";
import { startDaemon } from "../daemon.js";
import type { LoopDeps } from "../orchestrator/loop.js";
import { createRuntimeState } from "../runtime/state.js";

function createWorkflow(root: string): WorkflowConfig {
  return {
    tracker: {
      kind: "gitlab",
      baseUrl: "https://gitlab.example.com",
      projectId: "group/project",
      activeLabels: ["ai-ready", "ai-rework"],
      runningLabel: "ai-running",
      handoffLabel: "human-review",
      failedLabel: "ai-failed",
      blockedLabel: "ai-blocked",
      reworkLabel: "ai-rework",
      mergingLabel: "ai-merging",
    },
    workspace: {
      root,
      strategy: "worktree",
      repoCacheRoot: path.join(root, "repo-cache"),
    },
    git: {
      repoUrl: "git@gitlab.example.com:group/project.git",
      baseBranch: "main",
      branchPrefix: "issuepilot/",
    },
    agent: {
      runner: "codex-app-server",
      maxConcurrentAgents: 1,
      maxTurns: 1,
      maxAttempts: 1,
      retryBackoffMs: 1000,
    },
    codex: {
      command: "codex app-server",
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnTimeoutMs: 1000,
      turnSandboxPolicy: { type: "workspaceWrite" },
    },
    hooks: {},
    pollIntervalMs: 10_000,
    promptTemplate: "Fix issue {{issue.iid}}",
    source: {
      path: path.join(root, "workflow.md"),
      sha256: "test",
      loadedAt: "2026-05-14T00:00:00.000Z",
    },
  };
}

function createGitLabForHumanReviewScanPollution(): GitLabAdapter {
  let listCount = 0;
  return {
    listCandidateIssues: vi.fn(async () => {
      listCount += 1;
      if (listCount === 1) {
        return [
          {
            id: "7",
            iid: 7,
            title: "Needs review",
            url: "https://gitlab.example.com/group/project/-/issues/7",
            projectId: "group/project",
            labels: ["human-review"],
          },
        ];
      }
      return [];
    }),
    getIssue: vi.fn(async (iid: number) => ({
      id: String(iid),
      iid,
      title: "Needs review",
      url: `https://gitlab.example.com/group/project/-/issues/${iid}`,
      projectId: "group/project",
      labels: ["human-review"],
      description: "",
      state: "opened",
    })),
    findLatestIssuePilotWorkpadNote: vi.fn(async () => null),
    listMergeRequestsBySourceBranch: vi.fn(async () => []),
    createIssueNote: vi.fn(async () => ({ id: 1 })),
    closeIssue: vi.fn(async () => ({
      labels: [],
      state: "closed",
    })),
    transitionLabels: vi.fn(async () => ({
      labels: ["ai-rework"],
    })),
    updateIssueNote: vi.fn(async () => {}),
    findWorkpadNote: vi.fn(async () => null),
    createMergeRequest: vi.fn(async () => ({
      id: 1,
      iid: 1,
      webUrl: "https://gitlab.example.com/group/project/-/merge_requests/1",
    })),
    updateMergeRequest: vi.fn(async () => {}),
    getMergeRequest: vi.fn(async () => ({
      iid: 1,
      webUrl: "https://gitlab.example.com/group/project/-/merge_requests/1",
      state: "opened",
    })),
    listMergeRequestNotes: vi.fn(async () => []),
    getPipelineStatus: vi.fn(async () => "unknown"),
  };
}

describe("hostnameFromBaseUrl", () => {
  it("returns the bare hostname for an https URL", () => {
    expect(hostnameFromBaseUrl("https://gitlab.example.com")).toBe(
      "gitlab.example.com",
    );
  });

  it("strips a trailing path", () => {
    expect(hostnameFromBaseUrl("https://gitlab.example.com/")).toBe(
      "gitlab.example.com",
    );
    expect(hostnameFromBaseUrl("http://gitlab.local:8080/api/v4")).toBe(
      "gitlab.local",
    );
  });

  it("returns the input verbatim when it is not a URL", () => {
    expect(hostnameFromBaseUrl("gitlab.example.com")).toBe(
      "gitlab.example.com",
    );
  });
});

describe("splitCommand", () => {
  it("splits a simple command on whitespace", () => {
    expect(splitCommand("codex app-server")).toEqual({
      command: "codex",
      args: ["app-server"],
    });
  });

  it("preserves spaces inside double quotes", () => {
    expect(
      splitCommand('"/Users/User Name/.local/bin/codex" app-server'),
    ).toEqual({
      command: "/Users/User Name/.local/bin/codex",
      args: ["app-server"],
    });
  });

  it("preserves spaces inside single quotes", () => {
    expect(
      splitCommand("'/var/data with space/codex' app-server --foo bar"),
    ).toEqual({
      command: "/var/data with space/codex",
      args: ["app-server", "--foo", "bar"],
    });
  });

  it("supports mixed quoted + unquoted arguments", () => {
    expect(
      splitCommand("tsx '/tmp/My Folder/main.ts' /tmp/script.json"),
    ).toEqual({
      command: "tsx",
      args: ["/tmp/My Folder/main.ts", "/tmp/script.json"],
    });
  });

  it("collapses adjacent whitespace", () => {
    expect(splitCommand("  codex   app-server   ")).toEqual({
      command: "codex",
      args: ["app-server"],
    });
  });

  it("rejects an empty string", () => {
    expect(() => splitCommand("   ")).toThrow(/must not be empty/);
  });

  it("rejects an unbalanced quote", () => {
    expect(() => splitCommand('codex "app-server')).toThrow(/unbalanced/);
  });
});

describe("startDaemon human-review event publishing", () => {
  it("does not persist scan-level events under a previous issue-specific scan run", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "issuepilot-daemon-events-"),
    );
    const workflow = createWorkflow(root);
    let loopDeps: LoopDeps | undefined;
    const issueEventFile = path.join(
      root,
      ".issuepilot",
      "events",
      "group-project-7.jsonl",
    );

    const daemon = await startDaemon(
      { workflowPath: workflow.source.path },
      {
        workflowLoader: {
          loadOnce: vi.fn(async () => workflow),
          start: vi.fn(async () => ({
            stop: vi.fn(async () => {}),
          })),
          render: vi.fn(() => "prompt"),
        },
        createGitLab: vi.fn(async () =>
          createGitLabForHumanReviewScanPollution(),
        ),
        createServer: vi.fn(
          async () =>
            ({
              close: vi.fn(async () => {}),
            }) as never,
        ),
        startLoop: vi.fn((deps) => {
          loopDeps = deps;
          return {
            tick: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
          };
        }),
        state: createRuntimeState(),
      },
    );

    try {
      await loopDeps?.reconcileRunning();
      await vi.waitFor(async () => {
        const content = await fs.readFile(issueEventFile, "utf-8");
        expect(content).toContain("human_review_mr_missing");
      });

      await loopDeps?.reconcileRunning();

      await new Promise((resolve) => setTimeout(resolve, 20));
      const content = await fs.readFile(issueEventFile, "utf-8");
      const eventTypes = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { type: string }).type);
      expect(eventTypes).toEqual(["human_review_mr_missing"]);
    } finally {
      await daemon.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
