import { type IssueRef } from "./issue.js";

/**
 * Canonical list of every event type the orchestrator + runner + tracker
 * may emit. Sourced from spec §10 and plan Phase 1 §1.4. Keep alphabetical
 * groupings (lifecycle / turns / tools / approvals / runtime / git / run /
 * retry) to make grep easier.
 *
 * Adding a new event type is a breaking change for downstream consumers
 * (dashboard, observability JSONL readers) — bump the package version and
 * call it out in CHANGELOG.
 */
export const EVENT_TYPE_VALUES = [
  // Run lifecycle (claim → completion)
  "run_started",
  "claim_succeeded",
  "claim_failed",
  "run_completed",
  "run_failed",
  "run_blocked",
  // Dispatch pipeline
  "dispatch_start",
  "mirror_ready",
  "worktree_ready",
  "hook_afterCreate_done",
  "hook_beforeRun_done",
  "hook_afterRun_done",
  "agent_completed",
  "dispatch_completed",
  "dispatch_failed",
  // Workspace bootstrap
  "workspace_ready",
  "workspace_failed",
  // Codex session + turns
  "session_started",
  "turn_started",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
  "turn_timeout",
  // Tools
  "tool_call_started",
  "tool_call_completed",
  "tool_call_failed",
  "unsupported_tool_call",
  // Approvals & input
  "approval_required",
  "approval_auto_approved",
  "turn_input_required",
  // Codex runner events after daemon namespacing
  "codex_session_started",
  "codex_turn_started",
  "codex_turn_completed",
  "codex_turn_failed",
  "codex_turn_cancelled",
  "codex_turn_timeout",
  "codex_tool_call_started",
  "codex_tool_call_completed",
  "codex_tool_call_failed",
  "codex_unsupported_tool_call",
  "codex_approval_required",
  "codex_approval_auto_approved",
  "codex_turn_input_required",
  "codex_notification",
  "codex_malformed_message",
  // Runner runtime
  "notification",
  "malformed_message",
  "port_exit",
  // GitLab side-effects
  "gitlab_push",
  "gitlab_mr_created",
  "gitlab_mr_updated",
  "gitlab_note_created",
  "gitlab_note_updated",
  "gitlab_workpad_note_created",
  "gitlab_workpad_note_updated",
  "gitlab_labels_transitioned",
  // Reconciliation + retry
  "reconciliation_started",
  "reconciliation_completed",
  "reconcile_no_commits",
  "retry_scheduled",
  // Human review reconciliation
  "human_review_scan_started",
  "human_review_mr_found",
  "human_review_mr_missing",
  "human_review_mr_still_open",
  "human_review_mr_merged",
  "human_review_issue_closed",
  "human_review_mr_closed_unmerged",
  "human_review_rework_requested",
  "human_review_reconcile_failed",
] as const;

export type EventType = (typeof EVENT_TYPE_VALUES)[number];

export const isEventType = (value: unknown): value is EventType =>
  typeof value === "string" &&
  (EVENT_TYPE_VALUES as readonly string[]).includes(value);

/** Subset of {@link IssueRef} that travels with every event payload. */
export type EventIssueRef = Pick<
  IssueRef,
  "id" | "iid" | "title" | "url" | "projectId"
>;

/**
 * Wire-level event published by the orchestrator over SSE and persisted to
 * the JSONL event store. `data` is intentionally `unknown` — concrete event
 * payload schemas live next to the producer.
 */
export interface IssuePilotEvent {
  /** UUID v4 string assigned at publish time. */
  id: string;
  runId: string;
  issue: EventIssueRef;
  type: EventType;
  /** Human-readable summary; never includes secrets. */
  message: string;
  /** Codex thread id, when the event originates inside a runner session. */
  threadId?: string;
  /** Codex turn id, when applicable. */
  turnId?: string;
  /** Free-form structured payload — always run through redact() first. */
  data?: unknown;
  /** ISO-8601 timestamp captured at publish time. */
  createdAt: string;
}
