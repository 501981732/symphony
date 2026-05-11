import { randomUUID } from "node:crypto";
import type { RuntimeState } from "../runtime/state.js";
import type { ConcurrencySlots } from "../runtime/slots.js";

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
      await input.gitlab.transitionLabels(issue.iid, {
        add: [input.runningLabel],
        remove: input.activeLabels,
        requireCurrent: matchedLabel ? [matchedLabel] : undefined,
      });
    } catch {
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
