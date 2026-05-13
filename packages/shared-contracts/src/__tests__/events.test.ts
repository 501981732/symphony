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
  "retry_scheduled",
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
