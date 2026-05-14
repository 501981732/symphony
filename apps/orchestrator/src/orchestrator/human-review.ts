export interface HumanReviewIssue {
  iid: number;
  title?: string;
  labels: readonly string[];
  state?: string;
}

export interface HumanReviewMergeRequest {
  iid: number;
  webUrl: string;
  state: string;
  sourceBranch: string;
  updatedAt?: string;
}

export interface HumanReviewGitLabSlice {
  listHumanReviewIssues(): Promise<HumanReviewIssue[]>;
  getIssue(iid: number): Promise<HumanReviewIssue>;
  findLatestIssuePilotWorkpadNote(
    iid: number,
  ): Promise<{ id: number; body: string } | null>;
  listMergeRequestsBySourceBranch(
    sourceBranch: string,
  ): Promise<HumanReviewMergeRequest[]>;
  createIssueNote(iid: number, body: string): Promise<{ id: number }>;
  closeIssue(
    iid: number,
    opts: {
      removeLabels: readonly string[];
      requireCurrent: readonly string[];
    },
  ): Promise<{ labels: string[]; state: string | undefined }>;
  transitionLabels(
    iid: number,
    opts: {
      add: readonly string[];
      remove: readonly string[];
      requireCurrent: readonly string[];
    },
  ): Promise<{ labels: string[] }>;
}

export interface HumanReviewEvent {
  type: string;
  issueIid: number;
  runId: string;
  ts: string;
  detail: Record<string, unknown>;
}

export interface HumanReviewInput {
  handoffLabel: string;
  reworkLabel: string;
  gitlab: HumanReviewGitLabSlice;
  onEvent: (event: HumanReviewEvent) => void;
}

export interface IssuePilotWorkpadRef {
  runId: string;
  branch: string;
}

const SCAN_RUN_ID = "human-review-scan";
const RUN_MARKER_RE = /<!--\s*issuepilot:run(?::|=)([^>\s]+)\s*-->/;
const BRANCH_LINE_RE = /^\s*-\s*Branch:\s*`?([^`\n]+?)`?\s*$/im;

export function parseIssuePilotWorkpad(
  body: string,
): IssuePilotWorkpadRef | null {
  const marker = RUN_MARKER_RE.exec(body);
  const branch = BRANCH_LINE_RE.exec(body);
  if (!marker?.[1] || !branch?.[1]) return null;

  const runId = marker[1].trim();
  const branchName = branch[1].trim();
  if (!runId || !branchName) return null;
  return { runId, branch: branchName };
}

export function chooseMergeRequest(
  rows: readonly HumanReviewMergeRequest[],
): HumanReviewMergeRequest | null {
  const ordered = [...rows].sort((a, b) => {
    const priorityDelta = statePriority(a.state) - statePriority(b.state);
    if (priorityDelta !== 0) return priorityDelta;
    return timestampMs(b.updatedAt) - timestampMs(a.updatedAt);
  });
  return ordered[0] ?? null;
}

export async function reconcileHumanReview(
  input: HumanReviewInput,
): Promise<void> {
  const issues = await input.gitlab.listHumanReviewIssues();
  emit(input, {
    type: "human_review_scan_started",
    issueIid: 0,
    runId: SCAN_RUN_ID,
    detail: { count: issues.length },
  });

  for (const issue of issues) {
    if (!hasLabel(issue, input.handoffLabel)) continue;
    await reconcileIssue(input, issue);
  }
}

async function reconcileIssue(
  input: HumanReviewInput,
  issue: HumanReviewIssue,
): Promise<void> {
  let parsed: IssuePilotWorkpadRef | null = null;

  try {
    const note = await input.gitlab.findLatestIssuePilotWorkpadNote(issue.iid);
    parsed = note ? parseIssuePilotWorkpad(note.body) : null;
    if (!parsed) {
      emit(input, {
        type: "human_review_mr_missing",
        issueIid: issue.iid,
        runId: SCAN_RUN_ID,
        detail: { reason: "missing_workpad" },
      });
      return;
    }
    const workpad = parsed;

    const candidates = (
      await input.gitlab.listMergeRequestsBySourceBranch(workpad.branch)
    ).filter((mr) => mr.sourceBranch === workpad.branch);
    const mr = chooseMergeRequest(candidates);

    if (!mr) {
      emit(input, {
        type: "human_review_mr_missing",
        issueIid: issue.iid,
        runId: workpad.runId,
        detail: { branch: workpad.branch },
      });
      return;
    }

    emit(input, {
      type: "human_review_mr_found",
      issueIid: issue.iid,
      runId: workpad.runId,
      detail: mrDetail(workpad.branch, mr),
    });

    const mrState = mr.state;
    if (mrState === "opened") {
      emit(input, {
        type: "human_review_mr_still_open",
        issueIid: issue.iid,
        runId: workpad.runId,
        detail: mrDetail(workpad.branch, mr),
      });
      return;
    }

    if (mrState === "merged") {
      await closeMergedIssue(input, issue.iid, workpad, mr);
      return;
    }

    if (mrState === "closed") {
      emit(input, {
        type: "human_review_mr_closed_unmerged",
        issueIid: issue.iid,
        runId: workpad.runId,
        detail: mrDetail(workpad.branch, mr),
      });
      const transitioned = await input.gitlab.transitionLabels(issue.iid, {
        add: [input.reworkLabel],
        remove: [input.handoffLabel],
        requireCurrent: [input.handoffLabel],
      });
      emit(input, {
        type: "human_review_rework_requested",
        issueIid: issue.iid,
        runId: workpad.runId,
        detail: {
          ...mrDetail(workpad.branch, mr),
          labels: transitioned.labels,
        },
      });
      return;
    }

    emit(input, {
      type: "human_review_reconcile_failed",
      issueIid: issue.iid,
      runId: workpad.runId,
      detail: {
        ...mrDetail(workpad.branch, mr),
        reason: "unsupported_mr_state",
      },
    });
  } catch (error) {
    emit(input, {
      type: "human_review_reconcile_failed",
      issueIid: issue.iid,
      runId: parsed?.runId ?? SCAN_RUN_ID,
      detail: {
        reason: "gitlab_error",
        message: error instanceof Error ? error.message : String(error),
        ...(parsed ? { branch: parsed.branch } : {}),
      },
    });
  }
}

async function closeMergedIssue(
  input: HumanReviewInput,
  issueIid: number,
  parsed: IssuePilotWorkpadRef,
  mr: HumanReviewMergeRequest,
): Promise<void> {
  emit(input, {
    type: "human_review_mr_merged",
    issueIid,
    runId: parsed.runId,
    detail: mrDetail(parsed.branch, mr),
  });

  const latest = await input.gitlab.getIssue(issueIid);
  if (latest.state !== "opened" || !hasLabel(latest, input.handoffLabel)) {
    emit(input, {
      type: "human_review_reconcile_failed",
      issueIid,
      runId: parsed.runId,
      detail: {
        ...mrDetail(parsed.branch, mr),
        reason: "issue_state_changed",
      },
    });
    return;
  }

  // Task 2 keeps final note creation simple; a closeIssue failure may
  // duplicate this note on retry.
  await input.gitlab.createIssueNote(issueIid, buildMergedFinalNote(parsed, mr));
  const closed = await input.gitlab.closeIssue(issueIid, {
    removeLabels: [input.handoffLabel],
    requireCurrent: [input.handoffLabel],
  });
  emit(input, {
    type: "human_review_issue_closed",
    issueIid,
    runId: parsed.runId,
    detail: {
      ...mrDetail(parsed.branch, mr),
      labels: closed.labels,
      state: closed.state,
    },
  });
}

function buildMergedFinalNote(
  parsed: IssuePilotWorkpadRef,
  mr: HumanReviewMergeRequest,
): string {
  return [
    `IssuePilot closing note: MR !${mr.iid} was merged.`,
    `- Branch: \`${parsed.branch}\``,
    `- MR: ${mr.webUrl}`,
  ].join("\n");
}

function mrDetail(
  branch: string,
  mr: HumanReviewMergeRequest,
): Record<string, unknown> {
  return {
    branch,
    mrIid: mr.iid,
    mrState: mr.state,
  };
}

function emit(
  input: HumanReviewInput,
  event: Omit<HumanReviewEvent, "ts">,
): void {
  input.onEvent({
    ...event,
    ts: new Date().toISOString(),
  });
}

function hasLabel(issue: HumanReviewIssue, label: string): boolean {
  return issue.labels.includes(label);
}

function statePriority(state: string): number {
  if (state === "opened") return 0;
  if (state === "merged") return 1;
  if (state === "closed") return 2;
  return 3;
}

function timestampMs(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}
