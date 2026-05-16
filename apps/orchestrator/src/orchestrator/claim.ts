import { randomUUID } from "node:crypto";

import type { ConcurrencySlots } from "../runtime/slots.js";
import type { RuntimeState } from "../runtime/state.js";

interface IssueRef {
  id: string;
  iid: number;
  title: string;
  url: string;
  projectId: string;
  labels: string[];
}

interface GitLabSlice {
  listCandidateIssues(opts: {
    activeLabels: string[];
    excludeLabels: string[];
  }): Promise<IssueRef[]>;
  transitionLabels(
    iid: number,
    opts: { add: string[]; remove: string[]; requireCurrent?: string[] },
  ): Promise<{ labels: string[] }>;
}

export interface ClaimInput {
  gitlab: GitLabSlice;
  state: RuntimeState;
  slots: ConcurrencySlots;
  activeLabels: string[];
  runningLabel: string;
  excludeLabels: string[];
  /**
   * Logical project bucket for the RunRecord. V1 single-workflow callers
   * default to `"default"` so the dashboard can group V1 runs alongside V2
   * team-mode runs (which use real project ids from `issuepilot.team.yaml`).
   * Spec §1 & §11 require a non-empty `projectId` on every run; this default
   * keeps existing single-workflow deployments compliant without forcing a
   * config migration.
   */
  projectId?: string;
  projectName?: string;
  /**
   * Invoked when `transitionLabels` throws while we are trying to claim an
   * issue. The orchestrator wires this to inspect the error and, if it looks
   * like a GitLab permission/auth failure (HTTP 401/403), escalate the issue
   * into `ai-blocked` so it cannot be silently re-polled forever (spec §21
   * point 12). Implementations must swallow their own errors — they run on a
   * best-effort path inside the claim loop.
   */
  onClaimError?: (opts: {
    issue: IssueRef;
    error: unknown;
  }) => Promise<void> | void;
}

export interface ClaimedIssue {
  runId: string;
  iid: number;
  issue: IssueRef;
}

interface PriorReviewState {
  latestReviewFeedback?: unknown;
  lastDiscussionCursor?: string;
}

function findPriorReviewState(
  state: RuntimeState,
  iid: number,
): PriorReviewState {
  let candidate: { record: ReturnType<RuntimeState["allRuns"]>[number]; startedAt: string } | undefined;
  for (const run of state.allRuns()) {
    const runIssue = (run as { issue?: { iid?: number } }).issue;
    if (runIssue?.iid !== iid) continue;
    const startedAt = (run as { startedAt?: string }).startedAt ?? "";
    if (!candidate || startedAt > candidate.startedAt) {
      candidate = { record: run, startedAt };
    }
  }
  if (!candidate) return {};
  const record = candidate.record as {
    latestReviewFeedback?: unknown;
    lastDiscussionCursor?: string;
  };
  const out: PriorReviewState = {};
  if (record.latestReviewFeedback) {
    out.latestReviewFeedback = record.latestReviewFeedback;
  }
  if (record.lastDiscussionCursor) {
    out.lastDiscussionCursor = record.lastDiscussionCursor;
  }
  return out;
}

export async function claimCandidates(
  input: ClaimInput,
): Promise<ClaimedIssue[]> {
  if (input.slots.available() === 0) return [];

  const candidates = await input.gitlab.listCandidateIssues({
    activeLabels: input.activeLabels,
    excludeLabels: input.excludeLabels,
  });

  const claimed: ClaimedIssue[] = [];

  for (const issue of candidates) {
    if (input.slots.available() === 0) break;

    const matchedLabel = input.activeLabels.find((l) =>
      issue.labels.includes(l),
    );

    try {
      const transitionOpts: {
        add: string[];
        remove: string[];
        requireCurrent?: string[];
      } = {
        add: [input.runningLabel],
        remove: input.activeLabels,
      };
      if (matchedLabel) {
        transitionOpts.requireCurrent = [matchedLabel];
      }
      await input.gitlab.transitionLabels(issue.iid, transitionOpts);
    } catch (err) {
      if (input.onClaimError) {
        try {
          await input.onClaimError({ issue, error: err });
        } catch {
          // best-effort callback; never fail the claim loop because the
          // escalation hook itself misbehaved.
        }
      }
      continue;
    }

    const runId = randomUUID();
    input.slots.tryAcquire(runId);

    // Phase 4: when a human-reviewer cycles an issue back to ai-rework,
    // the issue gets a *new* run id but we still want the new agent
    // attempt to see the most recent review feedback collected on the
    // previous run. We look up the most recent prior run for the same
    // iid and forward `latestReviewFeedback` + `lastDiscussionCursor`.
    // Without this carry-forward the sweep cursor would also reset and
    // the dispatcher would re-inject the same comments on every claim.
    const carryForward = findPriorReviewState(input.state, issue.iid);

    input.state.setRun(runId, {
      runId,
      status: "claimed",
      attempt: 1,
      issue,
      branch: "",
      workspacePath: "",
      projectId: input.projectId ?? "default",
      ...(input.projectName ? { projectName: input.projectName } : {}),
      ...(carryForward.latestReviewFeedback
        ? { latestReviewFeedback: carryForward.latestReviewFeedback }
        : {}),
      ...(carryForward.lastDiscussionCursor
        ? { lastDiscussionCursor: carryForward.lastDiscussionCursor }
        : {}),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    claimed.push({ runId, iid: issue.iid, issue });
  }

  return claimed;
}
