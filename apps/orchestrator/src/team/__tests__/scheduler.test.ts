import type { IssueRef } from "@issuepilot/shared-contracts";
import type { GitLabAdapter } from "@issuepilot/tracker-gitlab";
import type { WorkflowConfig } from "@issuepilot/workflow";
import { describe, expect, it, vi } from "vitest";

import type { LeaseStore, RunLease } from "../../runtime/leases.js";
import { createRuntimeState } from "../../runtime/state.js";
import type { TeamSchedulerConfig } from "../config.js";
import type { RegisteredProject } from "../registry.js";
import { claimTeamProjectOnce } from "../scheduler.js";

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
    projectPath: "/srv/issuepilot-config/projects/platform-web.yaml",
    workflowProfilePath: "/srv/issuepilot-config/workflows/default-web.md",
    effectiveWorkflowPath:
      "/srv/issuepilot-config/.generated/platform-web.workflow.md",
    enabled: true,
    workflow: workflow(),
    lastPollAt: null,
    activeRuns: 0,
  };
}

function issueRef(overrides: Partial<IssueRef> = {}): IssueRef {
  return {
    id: "gid://gitlab/Issue/1",
    iid: 1,
    title: "Fix checkout",
    url: "https://gitlab.example.com/group/platform-web/-/issues/1",
    projectId: "group/platform-web",
    labels: ["ai-ready"],
    ...overrides,
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

function makeLeaseStore(
  lease: RunLease | null,
  overrides: Partial<LeaseStore> = {},
): LeaseStore {
  return {
    acquire: vi.fn(async () => lease),
    release: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => null),
    expireStale: vi.fn(async () => []),
    active: vi.fn(async () => (lease ? [lease] : [])),
    activeCount: () => (lease ? 1 : 0),
    ...overrides,
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

  it("releases the lease and continues with the next candidate when transitionLabels fails", async () => {
    const gitlab = makeAdapter({
      listCandidateIssues: vi.fn(async () => [
        issueRef({ iid: 1 }),
        issueRef({ iid: 2, id: "gid://gitlab/Issue/2", title: "Other" }),
      ]),
      transitionLabels: vi
        .fn()
        .mockRejectedValueOnce(new Error("HTTP 409 stale label"))
        .mockResolvedValueOnce({ labels: ["ai-running"] }),
    });
    const state = createRuntimeState();
    const leaseStore = makeLeaseStore(exampleLease);
    const onClaimError = vi.fn();

    const claimed = await claimTeamProjectOnce({
      project: project(),
      gitlab,
      state,
      leaseStore,
      scheduler: schedulerConfig,
      onClaimError,
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.issueIid).toBe(2);
    expect(leaseStore.release).toHaveBeenCalledWith("lease-1");
    expect(gitlab.transitionLabels).toHaveBeenCalledTimes(2);
    expect(onClaimError).toHaveBeenCalledWith(
      expect.objectContaining({ issue: expect.objectContaining({ iid: 1 }) }),
    );
  });

  it("preserves the original transitionLabels error when release() itself throws", async () => {
    const transitionError = new Error("HTTP 502 bad gateway");
    const gitlab = makeAdapter({
      transitionLabels: vi.fn(async () => {
        throw transitionError;
      }),
    });
    const state = createRuntimeState();
    const leaseStore = makeLeaseStore(exampleLease, {
      release: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const onClaimError = vi.fn();

    await claimTeamProjectOnce({
      project: project(),
      gitlab,
      state,
      leaseStore,
      scheduler: schedulerConfig,
      onClaimError,
    });

    expect(onClaimError).toHaveBeenCalledWith(
      expect.objectContaining({ error: transitionError }),
    );
  });

  it("rolls back the lease and labels when getIssue fails after transitionLabels", async () => {
    const gitlab = makeAdapter({
      transitionLabels: vi
        .fn()
        .mockResolvedValueOnce({ labels: ["ai-running"] })
        .mockResolvedValueOnce({ labels: ["ai-ready"] }),
      getIssue: vi.fn(async () => {
        throw new Error("HTTP 503 fetching issue");
      }),
    });
    const state = createRuntimeState();
    const leaseStore = makeLeaseStore(exampleLease);
    const onClaimError = vi.fn();

    const claimed = await claimTeamProjectOnce({
      project: project(),
      gitlab,
      state,
      leaseStore,
      scheduler: schedulerConfig,
      onClaimError,
    });

    expect(claimed).toEqual([]);
    expect(leaseStore.release).toHaveBeenCalledWith("lease-1");
    expect(gitlab.transitionLabels).toHaveBeenCalledTimes(2);
    // Second call should revert ai-running back to the original active label.
    expect(gitlab.transitionLabels).toHaveBeenNthCalledWith(
      2,
      1,
      expect.objectContaining({
        add: ["ai-ready"],
        remove: ["ai-running"],
      }),
    );
    expect(onClaimError).toHaveBeenCalledWith(
      expect.objectContaining({
        issue: expect.objectContaining({ iid: 1 }),
        phase: "fetch-issue",
      }),
    );
  });
});
