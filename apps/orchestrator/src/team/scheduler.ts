import { randomUUID } from "node:crypto";

import type { IssueRef } from "@issuepilot/shared-contracts";
import type { GitLabAdapter } from "@issuepilot/tracker-gitlab";

import type { LeaseStore, RunLease } from "../runtime/leases.js";
import type { RuntimeState } from "../runtime/state.js";

import type { TeamSchedulerConfig } from "./config.js";
import type { RegisteredProject } from "./registry.js";

/**
 * Phases of the team claim pipeline. Used by {@link OnClaimError} so the
 * caller can decide whether to escalate (e.g. transient transition errors
 * vs persistent fetch failures).
 */
export type TeamClaimErrorPhase =
  | "transition-labels"
  | "fetch-issue"
  | "rollback-labels"
  | "release-lease";

export type OnClaimError = (
  details: {
    issue: IssueRef;
    error: unknown;
    phase: TeamClaimErrorPhase;
  },
) => Promise<void> | void;

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
  /**
   * Best-effort hook fired when an individual claim step fails. The pass
   * always continues to the next candidate. Hook exceptions are swallowed.
   */
  onClaimError?: OnClaimError;
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

async function safeNotify(
  hook: OnClaimError | undefined,
  details: { issue: IssueRef; error: unknown; phase: TeamClaimErrorPhase },
): Promise<void> {
  if (!hook) return;
  try {
    await hook(details);
  } catch {
    // best-effort observability hook — never let it stall the claim loop.
  }
}

async function safeReleaseLease(
  leaseStore: LeaseStore,
  lease: RunLease,
  hook: OnClaimError | undefined,
  issue: IssueRef,
): Promise<void> {
  try {
    await leaseStore.release(lease.leaseId);
  } catch (releaseErr) {
    await safeNotify(hook, {
      issue,
      error: releaseErr,
      phase: "release-lease",
    });
  }
}

/**
 * Run a single claim pass for one team project. The order is critical: the
 * lease store must agree we have the slot before we mutate GitLab labels —
 * otherwise concurrent runners can race past the cap and leave the issue
 * stuck on `ai-running` with no claimant.
 *
 * Error handling mirrors V1 `apps/orchestrator/src/orchestrator/claim.ts`:
 * a single bad candidate (HTTP 4xx/5xx, network, GitLab race) is reported
 * via `onClaimError` and the loop moves on. Spec §13 requires that no
 * single project failure can take the daemon down.
 */
export async function claimTeamProjectOnce(
  input: TeamClaimInput,
): Promise<TeamClaimedRun[]> {
  const { project, gitlab, state, leaseStore, scheduler, onClaimError } = input;
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

    const transitionOpts: {
      add: string[];
      remove: string[];
      requireCurrent?: string[];
    } = {
      add: [workflow.tracker.runningLabel],
      remove: [...workflow.tracker.activeLabels],
    };
    if (matchedLabel) transitionOpts.requireCurrent = [matchedLabel];

    try {
      await gitlab.transitionLabels(issue.iid, transitionOpts);
    } catch (err) {
      await safeReleaseLease(leaseStore, lease, onClaimError, issue);
      await safeNotify(onClaimError, {
        issue,
        error: err,
        phase: "transition-labels",
      });
      continue;
    }

    let fullIssue;
    try {
      fullIssue = await gitlab.getIssue(issue.iid);
    } catch (err) {
      // Roll back the label transition we just made so the issue is not
      // stranded on ai-running with no claimant. Best-effort: if the
      // rollback itself fails we still release the lease and notify.
      try {
        const rollbackOpts: { add: string[]; remove: string[] } = {
          add: matchedLabel ? [matchedLabel] : [...workflow.tracker.activeLabels],
          remove: [workflow.tracker.runningLabel],
        };
        await gitlab.transitionLabels(issue.iid, rollbackOpts);
      } catch (rollbackErr) {
        await safeNotify(onClaimError, {
          issue,
          error: rollbackErr,
          phase: "rollback-labels",
        });
      }
      await safeReleaseLease(leaseStore, lease, onClaimError, issue);
      await safeNotify(onClaimError, {
        issue,
        error: err,
        phase: "fetch-issue",
      });
      continue;
    }

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
