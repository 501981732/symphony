import { describe, it, expect, expectTypeOf } from "vitest";

import {
  EVENT_TYPE_VALUES,
  isEventType,
  type EventType,
  type IssuePilotEvent,
} from "../events.js";

const REQUIRED_EVENT_TYPES = [
  "run_started",
  "claim_succeeded",
  "claim_failed",
  "workspace_ready",
  "workspace_failed",
  "session_started",
  "turn_started",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
  "turn_timeout",
  "tool_call_started",
  "tool_call_completed",
  "tool_call_failed",
  "approval_required",
  "approval_auto_approved",
  "turn_input_required",
  "notification",
  "unsupported_tool_call",
  "malformed_message",
  "port_exit",
  "gitlab_push",
  "gitlab_mr_created",
  "gitlab_mr_updated",
  "gitlab_note_created",
  "gitlab_note_updated",
  "gitlab_labels_transitioned",
  "reconciliation_started",
  "reconciliation_completed",
  "run_completed",
  "run_failed",
  "run_blocked",
  "dispatch_start",
  "mirror_ready",
  "worktree_ready",
  "hook_afterCreate_done",
  "hook_beforeRun_done",
  "hook_afterRun_done",
  "agent_completed",
  "dispatch_completed",
  "dispatch_failed",
  "retry_scheduled",
  "reconcile_no_commits",
  "gitlab_workpad_note_created",
  "gitlab_workpad_note_updated",
  "codex_session_started",
  "codex_turn_started",
  "codex_turn_completed",
  "codex_tool_call_started",
  "codex_tool_call_completed",
  "codex_turn_input_required",
  "codex_notification",
  "codex_malformed_message",
  "human_review_scan_started",
  "human_review_mr_found",
  "human_review_mr_missing",
  "human_review_mr_still_open",
  "human_review_mr_merged",
  "human_review_issue_closed",
  "human_review_mr_closed_unmerged",
  "human_review_rework_requested",
  "human_review_reconcile_failed",
  "operator_action_requested",
  "operator_action_succeeded",
  "operator_action_failed",
  "ci_status_observed",
  "ci_status_rework_triggered",
  "ci_status_lookup_failed",
] as const;

describe("@issuepilot/shared-contracts/events", () => {
  it("EVENT_TYPE_VALUES covers every type listed in spec §10 + plan Phase 1", () => {
    const known = new Set<string>(EVENT_TYPE_VALUES);
    for (const t of REQUIRED_EVENT_TYPES) {
      expect(known.has(t), `missing event type: ${t}`).toBe(true);
    }
  });

  it("EVENT_TYPE_VALUES has no duplicates", () => {
    expect(new Set(EVENT_TYPE_VALUES).size).toBe(EVENT_TYPE_VALUES.length);
  });

  it("isEventType narrows known event names", () => {
    expect(isEventType("turn_completed")).toBe(true);
    expect(isEventType("gitlab_mr_created")).toBe(true);
    expect(isEventType("nope")).toBe(false);
    expect(isEventType(null)).toBe(false);
  });

  it("isEventType narrows new operator action types", () => {
    expect(isEventType("operator_action_requested")).toBe(true);
    expect(isEventType("operator_action_succeeded")).toBe(true);
    expect(isEventType("operator_action_failed")).toBe(true);
  });

  it("isEventType narrows new ci feedback types (V2 Phase 3)", () => {
    expect(isEventType("ci_status_observed")).toBe(true);
    expect(isEventType("ci_status_rework_triggered")).toBe(true);
    expect(isEventType("ci_status_lookup_failed")).toBe(true);
  });

  it("IssuePilotEvent requires id / runId / issue / type / message / createdAt", () => {
    expectTypeOf<IssuePilotEvent>()
      .toHaveProperty("id")
      .toEqualTypeOf<string>();
    expectTypeOf<IssuePilotEvent>()
      .toHaveProperty("runId")
      .toEqualTypeOf<string>();
    expectTypeOf<IssuePilotEvent>()
      .toHaveProperty("type")
      .toEqualTypeOf<EventType>();
    expectTypeOf<IssuePilotEvent>()
      .toHaveProperty("message")
      .toEqualTypeOf<string>();
    expectTypeOf<IssuePilotEvent>()
      .toHaveProperty("createdAt")
      .toEqualTypeOf<string>();
  });
});
