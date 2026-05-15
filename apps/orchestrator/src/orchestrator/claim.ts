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
    input.state.setRun(runId, {
      runId,
      status: "claimed",
      attempt: 1,
      issue,
      branch: "",
      workspacePath: "",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    claimed.push({ runId, iid: issue.iid, issue });
  }

  return claimed;
}
