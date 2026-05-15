import type { IssueRef } from "@issuepilot/shared-contracts";
import type { GitLabAdapter } from "@issuepilot/tracker-gitlab";
import type { WorkflowConfig } from "@issuepilot/workflow";
import { describe, expect, it, vi } from "vitest";

import {
  createLeaseStore as createRealLeaseStore,
  type LeaseStore,
  type RunLease,
} from "../../runtime/leases.js";
import { createRuntimeState } from "../../runtime/state.js";
import type { TeamSchedulerConfig } from "../config.js";
import type { RegisteredProject } from "../registry.js";
import { claimTeamProjectOnce } from "../scheduler.js";

// Silence the unused import: cover the real factory so it remains exercised
// by the test bundle even though we use a fake store for these unit tests.
void createRealLeaseStore;

function workflow(): WorkflowConfig {
  return {
    tracker: {
      kind: "gitlab",
      baseUrl: "https://gitlab.example.com",
      projectId: "group/platform-web",
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
    pollIntervalMs: 10_000,
    promptTemplate: "Fix {{ issue.title }}",
    source: {
      path: "/srv/platform-web/WORKFLOW.md",
      sha256: "sha",
      loadedAt: new Date(0).toISOString(),
    },
  };
}

function project(): RegisteredProject {
  return {
    id: "platform-web",
    name: "Platform Web",
    workflowPath: "/srv/platform-web/WORKFLOW.md",
    enabled: true,
    workflow: workflow(),
    lastPollAt: null,
    activeRuns: 0,
  };
}

function issueRef(): IssueRef {
  return {
    id: "gid://gitlab/Issue/1",
    iid: 1,
    title: "Fix checkout",
    url: "https://gitlab.example.com/group/platform-web/-/issues/1",
    projectId: "group/platform-web",
    labels: ["ai-ready"],
  };
}

const schedulerConfig: TeamSchedulerConfig = {
  maxConcurrentRuns: 2,
  maxConcurrentRunsPerProject: 1,
  leaseTtlMs: 900_000,
  pollIntervalMs: 10_000,
};

function makeAdapter(
  overrides: Partial<
    Pick<
      GitLabAdapter,
      "listCandidateIssues" | "getIssue" | "transitionLabels"
    >
  > = {},
) {
  return {
    listCandidateIssues:
      overrides.listCandidateIssues ?? vi.fn(async () => [issueRef()]),
    getIssue:
      overrides.getIssue ??
      vi.fn(async () => ({
        ...issueRef(),
        description: "do the thing",
        state: "opened",
      })),
    transitionLabels:
      overrides.transitionLabels ??
      vi.fn(async () => ({ labels: ["ai-running"] })),
  };
}

function makeLeaseStore(lease: RunLease | null): LeaseStore {
  return {
    acquire: vi.fn(async () => lease),
    release: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => null),
    expireStale: vi.fn(async () => []),
    active: vi.fn(async () => (lease ? [lease] : [])),
  };
}

const exampleLease: RunLease = {
  leaseId: "lease-1",
  projectId: "platform-web",
  issueId: "1",
  runId: "run-1",
  branchName: "issuepilot/1-fix-checkout",
  acquiredAt: "2026-05-15T00:00:00.000Z",
  expiresAt: "2026-05-15T00:15:00.000Z",
  heartbeatAt: "2026-05-15T00:00:00.000Z",
  owner: "test",
  status: "active",
};

describe("claimTeamProjectOnce", () => {
  it("claims one project issue only after acquiring a lease", async () => {
    const gitlab = makeAdapter();
    const state = createRuntimeState();
    const leaseStore = makeLeaseStore(exampleLease);

    const claimed = await claimTeamProjectOnce({
      project: project(),
      gitlab,
      state,
      leaseStore,
      scheduler: schedulerConfig,
    });

    expect(claimed).toHaveLength(1);
    expect(leaseStore.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "platform-web",
        issueId: "1",
        runId: expect.any(String),
      }),
    );
    expect(gitlab.transitionLabels).toHaveBeenCalledTimes(1);
    expect(state.getRun(claimed[0]!.runId)).toMatchObject({
      projectId: "platform-web",
      projectName: "Platform Web",
      leaseId: "lease-1",
      status: "claimed",
    });
  });

  it("skips the issue without transitioning labels when the lease cannot be acquired", async () => {
    const gitlab = makeAdapter();
    const state = createRuntimeState();
    const leaseStore = makeLeaseStore(null);

    const claimed = await claimTeamProjectOnce({
      project: project(),
      gitlab,
      state,
      leaseStore,
      scheduler: schedulerConfig,
    });

    expect(claimed).toEqual([]);
    expect(gitlab.transitionLabels).not.toHaveBeenCalled();
  });
});
