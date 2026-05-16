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

  it("renders V2 Phase 5 workspace usage + next cleanup when provided", () => {
    render(
      <ServiceHeader
        snapshot={{
          ...snapshot,
          service: {
            ...snapshot.service,
            workspaceUsageGb: 12.4,
            nextCleanupAt: "2026-05-12T06:00:00.000Z",
          },
        }}
      />,
    );

    expect(screen.getByText(/Workspace usage/i)).toBeInTheDocument();
    expect(screen.getByText(/12\.4\s*GB/i)).toBeInTheDocument();
    expect(screen.getByText(/Next cleanup/i)).toBeInTheDocument();
    expect(screen.getByText("2026-05-12 06:00:00Z")).toBeInTheDocument();
  });

  it("omits workspace usage / next cleanup when unset", () => {
    render(<ServiceHeader snapshot={snapshot} />);
    expect(screen.queryByText(/Workspace usage/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Next cleanup/i)).not.toBeInTheDocument();
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
