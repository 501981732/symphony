// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { OrchestratorStateSnapshot } from "@issuepilot/shared-contracts";

import { ServiceHeader } from "./service-header";

const snapshot: OrchestratorStateSnapshot = {
  service: {
    status: "ready",
    workflowPath: "/workspace/.agents/workflow.md",
    gitlabProject: "group/project",
    pollIntervalMs: 10_000,
    concurrency: 2,
    lastConfigReloadAt: "2026-05-12T05:00:00.000Z",
    lastPollAt: "2026-05-12T05:00:30.000Z",
  },
  summary: {
    running: 1,
    retrying: 0,
    "human-review": 3,
    failed: 0,
    blocked: 0,
  },
};

describe("ServiceHeader", () => {
  it("renders spec §14 fields", () => {
    render(<ServiceHeader snapshot={snapshot} />);

    expect(screen.getByText(/ready/i)).toBeInTheDocument();
    expect(screen.getByText(snapshot.service.workflowPath)).toBeInTheDocument();
    expect(
      screen.getByText(snapshot.service.gitlabProject),
    ).toBeInTheDocument();
    expect(screen.getByText("10000 ms")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders timestamps in a stable UTC format to avoid SSR hydration mismatch", () => {
    render(<ServiceHeader snapshot={snapshot} />);
    expect(screen.getByText("2026-05-12 05:00:00Z")).toBeInTheDocument();
    expect(screen.getByText("2026-05-12 05:00:30Z")).toBeInTheDocument();
  });

  it("falls back to em-dash when no last reload yet", () => {
    render(
      <ServiceHeader
        snapshot={{
          ...snapshot,
          service: {
            ...snapshot.service,
            lastConfigReloadAt: null,
            lastPollAt: null,
          },
        }}
      />,
    );
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });
});
