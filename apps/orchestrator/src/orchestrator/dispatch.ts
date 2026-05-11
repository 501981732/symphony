import type { RuntimeState, RunEntry } from "../runtime/state.js";
import type { Classification } from "./classify.js";
import { classifyError } from "./classify.js";
import { shouldRetry } from "./retry.js";

export interface DispatchDeps {
  state: RuntimeState;
  maxAttempts: number;

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
    script?: string | undefined;
    env?: Record<string, string> | undefined;
  }): Promise<{ exitCode?: number | undefined; stdout: string; stderr: string }>;

  renderPrompt(opts: {
    template: string;
    vars: Record<string, string>;
  }): string;

  runAgent(opts: {
    cwd: string;
    prompt: string;
  }): Promise<{ status: string; summary?: string | undefined; validation?: string | undefined; risks?: string | undefined }>;

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
  }): Promise<void>;

  onEvent(event: { type: string; runId: string; ts: string; detail: Record<string, unknown> }): void;
  onFailure(runId: string, classification: Classification, attempt: number): Promise<void>;
}

export interface DispatchInput {
  runId: string;
  issue: {
    iid: number;
    title: string;
    url: string;
    projectId: string;
  };
  remoteUrl: string;
  repoCacheRoot: string;
  worktreeRoot: string;
  branch: string;
  baseBranch: string;
  promptTemplate: string;
  hooks?: {
    afterCreate?: string | undefined;
    beforeRun?: string | undefined;
    afterRun?: string | undefined;
  } | undefined;
}

function now(): string {
  return new Date().toISOString();
}

export async function dispatch(
  input: DispatchInput,
  deps: DispatchDeps,
): Promise<void> {
  const { runId } = input;

  try {
    deps.state.setRun(runId, {
      ...deps.state.getRun(runId)!,
      status: "running",
      updatedAt: now(),
    });

    deps.onEvent({ type: "dispatch_start", runId, ts: now(), detail: { iid: input.issue.iid } });

    const { mirrorPath } = await deps.ensureMirror({
      remoteUrl: input.remoteUrl,
      repoCacheRoot: input.repoCacheRoot,
    });
    deps.onEvent({ type: "mirror_ready", runId, ts: now(), detail: { mirrorPath } });

    const { worktreePath, created } = await deps.ensureWorktree({
      mirrorPath,
      branch: input.branch,
      baseBranch: input.baseBranch,
      worktreeRoot: input.worktreeRoot,
    });
    deps.onEvent({ type: "worktree_ready", runId, ts: now(), detail: { worktreePath, created } });

    deps.state.setRun(runId, {
      ...deps.state.getRun(runId)!,
      workspacePath: worktreePath,
      updatedAt: now(),
    });

    if (created && input.hooks?.afterCreate) {
      await deps.runHook({ cwd: worktreePath, script: input.hooks.afterCreate });
      deps.onEvent({ type: "hook_afterCreate_done", runId, ts: now(), detail: {} });
    }

    if (input.hooks?.beforeRun) {
      await deps.runHook({ cwd: worktreePath, script: input.hooks.beforeRun });
      deps.onEvent({ type: "hook_beforeRun_done", runId, ts: now(), detail: {} });
    }

    const prompt = deps.renderPrompt({
      template: input.promptTemplate,
      vars: {
        issue_title: input.issue.title,
        issue_url: input.issue.url,
        issue_iid: String(input.issue.iid),
        branch: input.branch,
      },
    });

    const outcome = await deps.runAgent({
      cwd: worktreePath,
      prompt,
    });
    deps.onEvent({ type: "agent_completed", runId, ts: now(), detail: { status: outcome.status } });

    let hookErr: unknown;
    if (input.hooks?.afterRun) {
      try {
        await deps.runHook({ cwd: worktreePath, script: input.hooks.afterRun });
        deps.onEvent({ type: "hook_afterRun_done", runId, ts: now(), detail: {} });
      } catch (e) {
        hookErr = e;
      }
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
    });

    deps.state.setRun(runId, {
      ...deps.state.getRun(runId)!,
      status: "completed",
      updatedAt: now(),
    });
    deps.onEvent({ type: "dispatch_completed", runId, ts: now(), detail: {} });

    if (hookErr) throw hookErr;
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
      deps.state.setRun(runId, {
        ...deps.state.getRun(runId)!,
        status: "retrying",
        attempt: attempt + 1,
        updatedAt: now(),
      });
      deps.onEvent({
        type: "retry_scheduled",
        runId,
        ts: now(),
        detail: { attempt: attempt + 1, reason: classification.reason },
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
        detail: { kind: classification.kind, code: classification.code, reason: classification.reason },
      });
    }
  }
}
