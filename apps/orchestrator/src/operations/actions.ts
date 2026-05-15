import { randomUUID } from "node:crypto";

import type { EventBus } from "@issuepilot/observability";
import type { IssuePilotInternalEvent } from "@issuepilot/shared-contracts";

import type { RuntimeState } from "../runtime/state.js";
import type { RunCancelRegistry } from "../runtime/run-cancel-registry.js";

/**
 * The three operator-initiated actions exposed by the dashboard. See V2
 * spec §8 + the 2026-05-15 Phase 2 supplemental design spec for the full
 * state machine and audit-event contract.
 */
export type OperatorAction = "retry" | "stop" | "archive";

export type OperatorActionResult =
  | { ok: true }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "invalid_status" }
  | {
      ok: false;
      code: "cancel_failed";
      reason: "cancel_timeout" | "cancel_threw" | "not_registered";
      message?: string;
    }
  | { ok: false; code: "gitlab_failed" | "internal_error"; message?: string };

export interface OperatorActionDeps {
  state: RuntimeState;
  eventBus: EventBus<IssuePilotInternalEvent>;
  runCancelRegistry: RunCancelRegistry;
  gitlab: {
    transitionLabels(
      iid: number,
      labels: { add: string[]; remove: string[] },
    ): Promise<void>;
  };
  workflow: {
    tracker: {
      runningLabel: string;
      reworkLabel: string;
      failedLabel: string;
      blockedLabel: string;
    };
  };
  now?: () => Date;
}

export interface OperatorActionInput {
  runId: string;
  operator: string;
  cancelTimeoutMs?: number;
}

function nowIso(deps: OperatorActionDeps): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

interface IssueLike {
  id?: string;
  iid: number;
  title?: string;
  url?: string;
  projectId?: string;
}

function emit(
  deps: OperatorActionDeps,
  type:
    | "operator_action_requested"
    | "operator_action_succeeded"
    | "operator_action_failed",
  runId: string,
  data: Record<string, unknown>,
): void {
  const ts = nowIso(deps);
  const event: IssuePilotInternalEvent = {
    id: randomUUID(),
    runId,
    type,
    message: `${type}:${data["action"] ?? "unknown"}`,
    data,
    createdAt: ts,
    ts,
  };
  const run = deps.state.getRun(runId);
  const issue = run?.["issue"] as IssueLike | undefined;
  if (issue) {
    event.issue = {
      id: issue.id ?? String(issue.iid),
      iid: issue.iid,
      title: issue.title ?? "",
      url: issue.url ?? "",
      projectId: issue.projectId ?? "",
    };
  }
  deps.eventBus.publish(event);
}

export async function retryRun(
  input: OperatorActionInput,
  deps: OperatorActionDeps,
): Promise<OperatorActionResult> {
  const { runId, operator } = input;
  emit(deps, "operator_action_requested", runId, {
    action: "retry",
    operator,
  });
  const run = deps.state.getRun(runId);
  if (!run) {
    emit(deps, "operator_action_failed", runId, {
      action: "retry",
      operator,
      code: "not_found",
    });
    return { ok: false, code: "not_found" };
  }
  if (
    run.status !== "failed" &&
    run.status !== "blocked" &&
    run.status !== "retrying"
  ) {
    emit(deps, "operator_action_failed", runId, {
      action: "retry",
      operator,
      code: "invalid_status",
      currentStatus: run.status,
    });
    return { ok: false, code: "invalid_status" };
  }

  const previousAttempt = run.attempt;
  const previousStatus = run.status;
  const issue = run["issue"] as IssueLike | undefined;
  if (!issue) {
    emit(deps, "operator_action_failed", runId, {
      action: "retry",
      operator,
      code: "internal_error",
      message: "run is missing issue context",
    });
    return {
      ok: false,
      code: "internal_error",
      message: "run is missing issue context",
    };
  }

  deps.state.setRun(runId, {
    ...run,
    status: "claimed",
    attempt: run.attempt + 1,
    updatedAt: nowIso(deps),
  });

  try {
    await deps.gitlab.transitionLabels(issue.iid, {
      add: [deps.workflow.tracker.reworkLabel],
      remove: [
        deps.workflow.tracker.runningLabel,
        deps.workflow.tracker.failedLabel,
        deps.workflow.tracker.blockedLabel,
      ],
    });
  } catch (err) {
    const current = deps.state.getRun(runId);
    if (current) {
      deps.state.setRun(runId, {
        ...current,
        status: previousStatus,
        attempt: previousAttempt,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    emit(deps, "operator_action_failed", runId, {
      action: "retry",
      operator,
      code: "gitlab_failed",
      message,
    });
    return { ok: false, code: "gitlab_failed", message };
  }

  emit(deps, "operator_action_succeeded", runId, {
    action: "retry",
    operator,
    transitions: ["attempt_incremented", "labels_to_rework"],
  });
  return { ok: true };
}

export async function stopRun(
  input: OperatorActionInput,
  deps: OperatorActionDeps,
): Promise<OperatorActionResult> {
  const { runId, operator } = input;
  emit(deps, "operator_action_requested", runId, {
    action: "stop",
    operator,
  });
  const run = deps.state.getRun(runId);
  if (!run) {
    emit(deps, "operator_action_failed", runId, {
      action: "stop",
      operator,
      code: "not_found",
    });
    return { ok: false, code: "not_found" };
  }
  if (run.status !== "running") {
    emit(deps, "operator_action_failed", runId, {
      action: "stop",
      operator,
      code: "invalid_status",
      currentStatus: run.status,
    });
    return { ok: false, code: "invalid_status" };
  }

  const cancelResult = await deps.runCancelRegistry.cancel(runId, {
    ...(input.cancelTimeoutMs !== undefined
      ? { timeoutMs: input.cancelTimeoutMs }
      : {}),
  });

  if (cancelResult.ok) {
    emit(deps, "operator_action_succeeded", runId, {
      action: "stop",
      operator,
      transitions: ["interrupt_sent"],
    });
    return { ok: true };
  }

  // Best-effort: even when the cancel request fails (timeout, threw, or
  // not_registered), surface the in-flight state on the dashboard so the
  // operator sees the run is "stopping" while turnTimeoutMs takes over and
  // funnels it to `failed` via the dispatch cancelled/timeout path.
  const current = deps.state.getRun(runId);
  if (current) {
    deps.state.setRun(runId, {
      ...current,
      status: "stopping",
      updatedAt: nowIso(deps),
    });
  }
  const reason = cancelResult.reason ?? "cancel_threw";
  emit(deps, "operator_action_failed", runId, {
    action: "stop",
    operator,
    code: "cancel_failed",
    reason,
    ...(cancelResult.message ? { message: cancelResult.message } : {}),
  });
  return {
    ok: false,
    code: "cancel_failed",
    reason,
    ...(cancelResult.message ? { message: cancelResult.message } : {}),
  };
}

export async function archiveRun(
  input: OperatorActionInput,
  deps: OperatorActionDeps,
): Promise<OperatorActionResult> {
  const { runId, operator } = input;
  emit(deps, "operator_action_requested", runId, {
    action: "archive",
    operator,
  });
  const run = deps.state.getRun(runId);
  if (!run) {
    emit(deps, "operator_action_failed", runId, {
      action: "archive",
      operator,
      code: "not_found",
    });
    return { ok: false, code: "not_found" };
  }
  if (
    run.status !== "failed" &&
    run.status !== "blocked" &&
    run.status !== "completed"
  ) {
    emit(deps, "operator_action_failed", runId, {
      action: "archive",
      operator,
      code: "invalid_status",
      currentStatus: run.status,
    });
    return { ok: false, code: "invalid_status" };
  }

  deps.state.setRun(runId, {
    ...run,
    archivedAt: nowIso(deps),
    updatedAt: nowIso(deps),
  });
  emit(deps, "operator_action_succeeded", runId, {
    action: "archive",
    operator,
    transitions: ["archived"],
  });
  return { ok: true };
}
