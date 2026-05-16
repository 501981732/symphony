import type { ReviewFeedbackSummary } from "@issuepilot/shared-contracts";

import type { RuntimeState } from "../runtime/state.js";

import type { Classification } from "./classify.js";
import { classifyError } from "./classify.js";
import { shouldRetry } from "./retry.js";

export interface DispatchDeps {
  state: RuntimeState;
  maxAttempts: number;
  retryBackoffMs: number;

  ensureMirror(opts: {
    remoteUrl: string;
    repoCacheRoot: string;
  }): Promise<{ mirrorPath: string }>;

  ensureWorktree(opts: {
    mirrorPath: string;
    branch: string;
    baseBranch: string;
    worktreeRoot: string;
  }): Promise<{ worktreePath: string; created: boolean }>;

  runHook(opts: {
    cwd: string;
    name: "after_create" | "before_run" | "after_run";
    script?: string | undefined;
    env?: Record<string, string> | undefined;
  }): Promise<{
    exitCode?: number | undefined;
    stdout: string;
    stderr: string;
  }>;

  renderPrompt(opts: {
    template: string;
    vars: Record<string, unknown>;
  }): string | Promise<string>;

  runAgent(opts: { cwd: string; prompt: string }): Promise<{
    status: string;
    summary?: string | undefined;
    validation?: string | undefined;
    risks?: string | undefined;
    noCodeChangeReason?: string | undefined;
  }>;

  reconcile(opts: {
    runId: string;
    iid: number;
    branch: string;
    baseBranch: string;
    workspacePath: string;
    attempt: number;
    agentSummary?: string | undefined;
    agentValidation?: string | undefined;
    agentRisks?: string | undefined;
    noCodeChangeReason?: string | undefined;
    issueUrl: string;
    issueIdentifier: string;
    runningLabel: string;
    handoffLabel: string;
    reworkLabel: string;
  }): Promise<void>;

  onEvent(event: {
    type: string;
    runId: string;
    ts: string;
    detail: Record<string, unknown>;
  }): void;
  onFailure(
    runId: string,
    classification: Classification,
    attempt: number,
  ): Promise<void>;
}

export interface DispatchInput {
  runId: string;
  issue: {
    id?: string | undefined;
    iid: number;
    title: string;
    url: string;
    projectId: string;
    description?: string | undefined;
    labels?: string[] | undefined;
    author?: string | undefined;
    assignees?: string[] | undefined;
  };
  remoteUrl: string;
  repoCacheRoot: string;
  worktreeRoot: string;
  branch: string;
  baseBranch: string;
  runningLabel: string;
  handoffLabel: string;
  reworkLabel: string;
  promptTemplate: string;
  hooks?:
    | {
        afterCreate?: string | undefined;
        beforeRun?: string | undefined;
        afterRun?: string | undefined;
      }
    | undefined;
}

function now(): string {
  return new Date().toISOString();
}

function addMs(date: Date, ms: number): string {
  return new Date(date.getTime() + ms).toISOString();
}

/**
 * Build the standardised `## Review feedback` block that dispatch
 * prepends to the agent prompt on `ai-rework` retries (attempt > 1).
 * The block is deliberately separate from the user-supplied workflow
 * template: operators do not have to remember to add it themselves,
 * and the agent receives the reviewer comments in a consistent shape
 * regardless of which workflow file claimed the issue. Templates can
 * still opt into a custom rendering via the `review_feedback` Liquid
 * alias (see `packages/workflow`); when they do, the prepended block
 * is duplicated but never goes missing.
 */
function buildReviewFeedbackBlock(summary: ReviewFeedbackSummary): string {
  const lines: string[] = [
    "## Review feedback",
    "",
    `Reviewer comments collected from MR !${summary.mrIid} since the previous attempt.`,
    `Address them in this run rather than asking the reviewer to repeat themselves.`,
    `MR: ${summary.mrUrl}`,
    "",
  ];
  for (const c of summary.comments) {
    lines.push(`- @${c.author} (${c.createdAt}): ${c.body}`);
  }
  lines.push("");
  lines.push("---");
  return lines.join("\n");
}

export async function dispatch(
  input: DispatchInput,
  deps: DispatchDeps,
): Promise<void> {
  const { runId } = input;

  try {
    const currentRun = deps.state.getRun(runId)!;
    const { nextRetryAt: _nextRetryAt, ...runWithoutRetrySchedule } =
      currentRun;
    deps.state.setRun(runId, {
      ...runWithoutRetrySchedule,
      status: "running",
      updatedAt: now(),
    });

    deps.onEvent({
      type: "dispatch_start",
      runId,
      ts: now(),
      detail: { iid: input.issue.iid },
    });

    const { mirrorPath } = await deps.ensureMirror({
      remoteUrl: input.remoteUrl,
      repoCacheRoot: input.repoCacheRoot,
    });
    deps.onEvent({
      type: "mirror_ready",
      runId,
      ts: now(),
      detail: { mirrorPath },
    });

    const { worktreePath, created } = await deps.ensureWorktree({
      mirrorPath,
      branch: input.branch,
      baseBranch: input.baseBranch,
      worktreeRoot: input.worktreeRoot,
    });
    deps.onEvent({
      type: "worktree_ready",
      runId,
      ts: now(),
      detail: { worktreePath, created },
    });

    deps.state.setRun(runId, {
      ...deps.state.getRun(runId)!,
      workspacePath: worktreePath,
      updatedAt: now(),
    });

    if (created && input.hooks?.afterCreate) {
      await deps.runHook({
        cwd: worktreePath,
        name: "after_create",
        script: input.hooks.afterCreate,
      });
      deps.onEvent({
        type: "hook_afterCreate_done",
        runId,
        ts: now(),
        detail: {},
      });
    }

    if (input.hooks?.beforeRun) {
      await deps.runHook({
        cwd: worktreePath,
        name: "before_run",
        script: input.hooks.beforeRun,
      });
      deps.onEvent({
        type: "hook_beforeRun_done",
        runId,
        ts: now(),
        detail: {},
      });
    }

    const runBeforePrompt = deps.state.getRun(runId);
    const promptAttempt = runBeforePrompt?.attempt ?? 1;
    const latestReviewFeedback = runBeforePrompt?.["latestReviewFeedback"] as
      | ReviewFeedbackSummary
      | undefined;

    const vars: Record<string, unknown> = {
      issue: {
        id: input.issue.id ?? String(input.issue.iid),
        iid: input.issue.iid,
        identifier: `${input.issue.projectId}#${input.issue.iid}`,
        title: input.issue.title,
        description: input.issue.description ?? "",
        labels: input.issue.labels ?? [],
        url: input.issue.url,
        author: input.issue.author ?? "",
        assignees: input.issue.assignees ?? [],
      },
      attempt: promptAttempt,
      workspace: { path: worktreePath },
      git: { branch: input.branch },
    };
    if (latestReviewFeedback) {
      vars["reviewFeedback"] = latestReviewFeedback;
    }

    let prompt = await deps.renderPrompt({
      template: input.promptTemplate,
      vars,
    });

    // V2 Phase 4: when the run is in an `ai-rework` retry (attempt > 1)
    // and the sweep produced a summary, prepend a standardised block so
    // the agent always gets the reviewer comments in the same shape.
    // The first attempt path is intentionally left alone — reviewer
    // comments only become meaningful after the initial MR has landed.
    if (latestReviewFeedback && promptAttempt > 1) {
      prompt = `${buildReviewFeedbackBlock(latestReviewFeedback)}\n\n${prompt}`;
    }

    const outcome = await deps.runAgent({
      cwd: worktreePath,
      prompt,
    });
    deps.onEvent({
      type: "agent_completed",
      runId,
      ts: now(),
      detail: { status: outcome.status },
    });

    if (input.hooks?.afterRun) {
      await deps.runHook({
        cwd: worktreePath,
        name: "after_run",
        script: input.hooks.afterRun,
      });
      deps.onEvent({
        type: "hook_afterRun_done",
        runId,
        ts: now(),
        detail: {},
      });
    }

    if (outcome.status !== "completed") {
      throw outcome;
    }

    await deps.reconcile({
      runId,
      iid: input.issue.iid,
      branch: input.branch,
      baseBranch: input.baseBranch,
      workspacePath: worktreePath,
      attempt: deps.state.getRun(runId)?.attempt ?? 1,
      agentSummary: outcome.summary,
      agentValidation: outcome.validation,
      agentRisks: outcome.risks,
      noCodeChangeReason: outcome.noCodeChangeReason,
      issueUrl: input.issue.url,
      issueIdentifier: `${input.issue.projectId}#${input.issue.iid}`,
      runningLabel: input.runningLabel,
      handoffLabel: input.handoffLabel,
      reworkLabel: input.reworkLabel,
    });

    deps.state.setRun(runId, {
      ...deps.state.getRun(runId)!,
      status: "completed",
      updatedAt: now(),
    });
    deps.onEvent({ type: "dispatch_completed", runId, ts: now(), detail: {} });
  } catch (err) {
    const run = deps.state.getRun(runId);
    const attempt = run?.attempt ?? 1;
    const classification = classifyError(err);
    const decision = shouldRetry({
      kind: classification.kind,
      attempt,
      maxAttempts: deps.maxAttempts,
    });

    if (decision.retry) {
      const nextRetryAt = addMs(new Date(), deps.retryBackoffMs);
      deps.state.setRun(runId, {
        ...deps.state.getRun(runId)!,
        status: "retrying",
        attempt: attempt + 1,
        nextRetryAt,
        updatedAt: now(),
      });
      deps.onEvent({
        type: "retry_scheduled",
        runId,
        ts: now(),
        detail: {
          attempt: attempt + 1,
          nextRetryAt,
          reason: classification.reason,
        },
      });
    } else {
      const finalStatus = decision.finalStatus ?? "failed";
      deps.state.setRun(runId, {
        ...deps.state.getRun(runId)!,
        status: finalStatus,
        updatedAt: now(),
      });
      await deps.onFailure(runId, classification, attempt);
      deps.onEvent({
        type: "dispatch_failed",
        runId,
        ts: now(),
        detail: {
          kind: classification.kind,
          code: classification.code,
          reason: classification.reason,
        },
      });
    }
  }
}
