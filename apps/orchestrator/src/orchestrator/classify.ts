export interface Classification {
  kind: "blocked" | "failed" | "retryable";
  reason: string;
  code: string;
}

const BLOCKED_CATEGORIES = new Set(["auth", "permission"]);
const RETRYABLE_CATEGORIES = new Set(["transient", "rate_limit"]);

export function classifyError(err: unknown): Classification {
  // Named typed errors first — these carry more structure than the runner
  // outcome shape and can shadow it (e.g. `GitLabError` also has a numeric
  // `.status`, but we want it routed by `.category`, not by the lifecycle
  // status branch below). Order matters: do the typed-error branches
  // BEFORE the runner-outcome branch.
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

    // Fall through to the runner-outcome branch below for shape-only
    // discriminated objects (the lifecycle re-throws plain `{ status:
    // "timeout" | "failed" | ... }` records that have no `.name`).
    if (typeof e.name !== "string" || e.name === "Error") {
      // Plain Error or no name — fall through to runner outcome check.
    } else if (
      typeof (err as { status?: unknown }).status !== "string"
    ) {
      // Anything else with a non-string status is NOT a runner outcome;
      // bail out as a generic failed.
      return {
        kind: "failed",
        reason: e.message,
        code: "unknown",
      };
    }
  }

  if (
    err &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "string"
  ) {
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

  if (err instanceof Error) {
    return { kind: "failed", reason: err.message, code: "unknown" };
  }

  return { kind: "failed", reason: String(err), code: "unknown" };
}
