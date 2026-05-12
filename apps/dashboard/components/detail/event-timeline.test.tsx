// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { IssuePilotEvent } from "@issuepilot/shared-contracts";

import { EventTimeline } from "./event-timeline";

const issue = {
  id: "gid://gitlab/Issue/1",
  iid: 1,
  title: "t",
  url: "https://x",
  projectId: "p",
};

function event(over: Partial<IssuePilotEvent>): IssuePilotEvent {
  return {
    id: over.id ?? "e",
    runId: "r1",
    issue,
    type: "notification",
    message: "msg",
    createdAt: "2026-05-12T05:00:00.000Z",
    ...over,
  };
}

describe("EventTimeline", () => {
  it("renders events sorted by createdAt ascending", () => {
    render(
      <EventTimeline
        events={[
          event({
            id: "second",
            createdAt: "2026-05-12T05:00:10.000Z",
            message: "second",
          }),
          event({
            id: "first",
            createdAt: "2026-05-12T05:00:00.000Z",
            message: "first",
          }),
        ]}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("first");
    expect(items[1]).toHaveTextContent("second");
  });

  it("renders empty state when no events", () => {
    render(<EventTimeline events={[]} />);
    expect(screen.getByText(/no events yet/i)).toBeInTheDocument();
  });

  it("includes serialized event data block", () => {
    render(
      <EventTimeline
        events={[
          event({
            id: "data-evt",
            message: "with data",
            data: { foo: "bar" },
          }),
        ]}
      />,
    );
    expect(screen.getByText(/foo/i)).toBeInTheDocument();
    expect(screen.getByText(/bar/i)).toBeInTheDocument();
  });
});
