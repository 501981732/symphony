// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { IssuePilotEvent } from "@issuepilot/shared-contracts";

import { renderWithIntl as render } from "../../test/intl";

import { ToolCallList } from "./tool-call-list";

const issue = {
  id: "gid://gitlab/Issue/1",
  iid: 1,
  title: "t",
  url: "https://x",
  projectId: "p",
};

function event(
  type: IssuePilotEvent["type"],
  overrides: Partial<IssuePilotEvent> = {},
): IssuePilotEvent {
  return {
    id: overrides.id ?? type,
    runId: "r1",
    issue,
    type,
    message: overrides.message ?? type,
    createdAt: overrides.createdAt ?? "2026-05-12T05:00:00.000Z",
    ...overrides,
  };
}

describe("ToolCallList", () => {
  it("renders only tool_call_* events", () => {
    render(
      <ToolCallList
        events={[
          event("tool_call_started", { message: "started msg" }),
          event("notification", { id: "n", message: "noise" }),
          event("tool_call_completed", { id: "ok", message: "ok msg" }),
          event("tool_call_failed", { id: "boom", message: "fail msg" }),
        ]}
      />,
    );

    expect(screen.getByText("started msg")).toBeInTheDocument();
    expect(screen.getByText("ok msg")).toBeInTheDocument();
    expect(screen.getByText("fail msg")).toBeInTheDocument();
    expect(screen.queryByText("noise")).not.toBeInTheDocument();
  });

  it("shows empty state when no tool events present", () => {
    render(
      <ToolCallList events={[event("notification", { message: "noise" })]} />,
    );
    expect(screen.getByText(/no tool calls yet/i)).toBeInTheDocument();
  });
});
