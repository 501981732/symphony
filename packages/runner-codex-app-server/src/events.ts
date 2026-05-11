import { randomUUID } from "node:crypto";

export interface EventContext {
  runId: string;
  issue: {
    id: string;
    iid: number;
    title: string;
    url: string;
    projectId: string;
  };
  threadId?: string | undefined;
  turnId?: string | undefined;
}

export interface NormalizedEvent {
  id: string;
  runId: string;
  issue: EventContext["issue"];
  type: string;
  message: string;
  threadId?: string | undefined;
  turnId?: string | undefined;
  data?: unknown;
  createdAt: string;
}

const METHOD_MAP: Record<string, string> = {
  "turn/notification": "notification",
  "tool/started": "tool_call_started",
  "tool/completed": "tool_call_completed",
  "tool/failed": "tool_call_failed",
  "turn/completed": "turn_completed",
  "turn/failed": "turn_failed",
  "turn/cancelled": "turn_cancelled",
  "turn/timeout": "turn_timeout",
  "turn/input_required": "turn_input_required",
  "approval/request": "approval_required",
};

function makeEvent(
  type: string,
  message: string,
  ctx: EventContext,
  data?: unknown,
): NormalizedEvent {
  return {
    id: randomUUID(),
    runId: ctx.runId,
    issue: ctx.issue,
    type,
    message,
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    data,
    createdAt: new Date().toISOString(),
  };
}

export function normalizeNotification(
  method: string,
  params: unknown,
  ctx: EventContext,
): NormalizedEvent {
  const eventType = METHOD_MAP[method];
  const p = (params ?? {}) as Record<string, unknown>;

  if (!eventType) {
    return makeEvent(
      "malformed_message",
      `Unrecognized method: ${method}`,
      ctx,
      params,
    );
  }

  const message =
    typeof p["message"] === "string"
      ? p["message"]
      : `${eventType}: ${JSON.stringify(params)}`;

  return makeEvent(eventType, message, ctx, params);
}

export function handleApprovalRequest(
  approvalPolicy: string,
  ctx: EventContext,
): { approved: boolean; event: NormalizedEvent } {
  if (approvalPolicy === "never") {
    return {
      approved: true,
      event: makeEvent(
        "approval_auto_approved",
        "Auto-approved under policy=never",
        ctx,
      ),
    };
  }

  return {
    approved: false,
    event: makeEvent(
      "approval_required",
      "Manual approval required",
      ctx,
    ),
  };
}

const NON_INTERACTIVE_REPLY =
  "This is a non-interactive IssuePilot run. Operator input is unavailable. " +
  "If blocked, record the blocker and mark the issue ai-blocked.";

export function handleInputRequired(ctx: EventContext): {
  reply: string;
  event: NormalizedEvent;
} {
  return {
    reply: NON_INTERACTIVE_REPLY,
    event: makeEvent(
      "turn_input_required",
      "Auto-replied with non-interactive message",
      ctx,
    ),
  };
}
