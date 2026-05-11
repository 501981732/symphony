export interface Classification {
  kind: "blocked" | "failed" | "retryable";
  reason: string;
  code: string;
}

const BLOCKED_CATEGORIES = new Set(["auth", "permission"]);
const RETRYABLE_CATEGORIES = new Set(["transient", "rate_limit"]);

export function classifyError(err: unknown): Classification {
  if (err && typeof err === "object" && "status" in err) {
    const outcome = err as { status: string; reason?: string };
    if (outcome.status === "timeout") {
      return {
        kind: "retryable",
        reason: outcome.reason ?? "turn timed out",
        code: "turn_timeout",
      };
    }
    return {
      kind: "failed",
      reason: outcome.reason ?? outcome.status,
      code: `runner_${outcome.status}`,
    };
  }

  if (err instanceof Error || (err && typeof err === "object" && "name" in err)) {
    const e = err as Error & { category?: string; name: string };

    if (e.name === "GitLabError" && e.category) {
      if (BLOCKED_CATEGORIES.has(e.category)) {
        return { kind: "blocked", reason: e.message, code: e.category };
      }
      if (RETRYABLE_CATEGORIES.has(e.category)) {
        return { kind: "retryable", reason: e.message, code: e.category };
      }
      return { kind: "failed", reason: e.message, code: e.category };
    }

    if (e.name === "WorkspacePathError") {
      return { kind: "blocked", reason: e.message, code: "workspace_path" };
    }

    if (e.name === "WorkspaceDirtyError") {
      return { kind: "failed", reason: e.message, code: "workspace_dirty" };
    }

    if (e.name === "HookFailedError") {
      return { kind: "failed", reason: e.message, code: "hook_failed" };
    }

    if (e.name === "WorkflowConfigError") {
      return { kind: "blocked", reason: e.message, code: "workflow_config" };
    }

    return { kind: "failed", reason: e.message, code: "unknown" };
  }

  return { kind: "failed", reason: String(err), code: "unknown" };
}
