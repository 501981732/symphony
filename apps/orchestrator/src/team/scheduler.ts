import { randomUUID } from "node:crypto";

import type { GitLabAdapter } from "@issuepilot/tracker-gitlab";

import type { LeaseStore } from "../runtime/leases.js";
import type { RuntimeState } from "../runtime/state.js";
import type { TeamSchedulerConfig } from "./config.js";
import type { RegisteredProject } from "./registry.js";

/**
 * Inputs required for a single team-mode claim pass over one project. The
 * GitLab adapter is intentionally narrowed to the three methods we need so
 * tests can stub them out without faking the entire surface.
 */
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

export interface TeamClaimedRun {
  runId: string;
  issueIid: number;
  leaseId: string;
}

function deriveBranchName(
  workflowPrefix: string,
  issueIid: number,
  issueTitle: string,
): string {
  const slug = issueTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = slug.length > 0 ? `-${slug}` : "";
  return `${workflowPrefix}/${issueIid}${suffix}`;
}

/**
 * Run a single claim pass for one team project. The order is critical: the
 * lease store must agree we have the slot before we mutate GitLab labels —
 * otherwise concurrent runners can race past the cap and leave the issue
 * stuck on `ai-running` with no claimant.
 */
export async function claimTeamProjectOnce(
  input: TeamClaimInput,
): Promise<TeamClaimedRun[]> {
  const { project, gitlab, state, leaseStore, scheduler } = input;
  const workflow = project.workflow;

  const candidates = await gitlab.listCandidateIssues({
    activeLabels: workflow.tracker.activeLabels,
    excludeLabels: [
      workflow.tracker.runningLabel,
      workflow.tracker.failedLabel,
      workflow.tracker.blockedLabel,
    ],
  });

  const claimed: TeamClaimedRun[] = [];

  for (const issue of candidates) {
    const runId = randomUUID();
    const branchName = deriveBranchName(
      workflow.git.branchPrefix,
      issue.iid,
      issue.title,
    );

    const lease = await leaseStore.acquire({
      projectId: project.id,
      issueId: String(issue.iid),
      runId,
      branchName,
      ttlMs: scheduler.leaseTtlMs,
      maxConcurrentRuns: scheduler.maxConcurrentRuns,
      maxConcurrentRunsPerProject: scheduler.maxConcurrentRunsPerProject,
    });
    if (!lease) continue;

    const matchedLabel = workflow.tracker.activeLabels.find((label) =>
      issue.labels.includes(label),
    );

    try {
      const transitionOpts: {
        add: string[];
        remove: string[];
        requireCurrent?: string[];
      } = {
        add: [workflow.tracker.runningLabel],
        remove: [...workflow.tracker.activeLabels],
      };
      if (matchedLabel) transitionOpts.requireCurrent = [matchedLabel];
      await gitlab.transitionLabels(issue.iid, transitionOpts);
    } catch (err) {
      await leaseStore.release(lease.leaseId);
      throw err;
    }

    const fullIssue = await gitlab.getIssue(issue.iid);
    const now = new Date().toISOString();
    state.setRun(runId, {
      runId,
      status: "claimed",
      attempt: 1,
      issue: fullIssue,
      branch: branchName,
      workspacePath: "",
      projectId: project.id,
      projectName: project.name,
      leaseId: lease.leaseId,
      startedAt: now,
      updatedAt: now,
    });

    claimed.push({ runId, issueIid: issue.iid, leaseId: lease.leaseId });
  }

  return claimed;
}
