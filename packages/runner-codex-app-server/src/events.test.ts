import { describe, it, expect } from "vitest";
import {
  normalizeNotification,
  handleApprovalRequest,
  handleInputRequired,
} from "./events.js";

const baseCtx = {
  runId: "r1",
  issue: {
    id: "gid://gitlab/Issue/1",
    iid: 1,
    title: "Fix bug",
    url: "https://gitlab.example.com/issues/1",
    projectId: "group/project",
  },
  threadId: "t1",
  turnId: "u1",
};

describe("normalizeNotification", () => {
  it("maps turn/notification to notification event", () => {
    const event = normalizeNotification(
      "turn/notification",
      { message: "Starting analysis" },
      baseCtx,
    );
    expect(event.type).toBe("notification");
    expect(event.message).toBe("Starting analysis");
    expect(event.runId).toBe("r1");
    expect(event.threadId).toBe("t1");
    expect(event.turnId).toBe("u1");
    expect(event.createdAt).toBeTruthy();
  });

  it("maps tool/started to tool_call_started", () => {
    const event = normalizeNotification(
      "tool/started",
      { toolName: "gitlab_create_issue_note" },
      baseCtx,
    );
    expect(event.type).toBe("tool_call_started");
  });

  it("maps tool/completed to tool_call_completed", () => {
    const event = normalizeNotification(
      "tool/completed",
      { toolName: "gitlab_get_issue", result: { ok: true } },
      baseCtx,
    );
    expect(event.type).toBe("tool_call_completed");
  });

  it("maps tool/failed to tool_call_failed", () => {
    const event = normalizeNotification(
      "tool/failed",
      { toolName: "unknown_tool", error: "not supported" },
      baseCtx,
    );
    expect(event.type).toBe("tool_call_failed");
  });

  it("maps unrecognized methods to malformed_message", () => {
    const event = normalizeNotification(
      "something/weird",
      { data: "test" },
      baseCtx,
    );
    expect(event.type).toBe("malformed_message");
  });
});

describe("handleApprovalRequest", () => {
  it("returns auto_approved with approvalPolicy never", () => {
    const result = handleApprovalRequest("never", baseCtx);
    expect(result.approved).toBe(true);
    expect(result.event.type).toBe("approval_auto_approved");
  });

  it("returns approval_required with approvalPolicy on-request", () => {
    const result = handleApprovalRequest("on-request", baseCtx);
    expect(result.approved).toBe(false);
    expect(result.event.type).toBe("approval_required");
  });
});

describe("handleInputRequired", () => {
  it("returns non-interactive reply and event", () => {
    const result = handleInputRequired(baseCtx);
    expect(result.reply).toContain("non-interactive");
    expect(result.event.type).toBe("turn_input_required");
  });
});
