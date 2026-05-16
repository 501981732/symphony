// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { OrchestratorStateSnapshot } from "@issuepilot/shared-contracts";

import { renderWithIntl as render } from "../../test/intl";

import { ServiceHeader } from "./service-header";

/**
 * Tier-2 metadata (last config reload, workspace usage, next cleanup)
 * lives behind a "More details" disclosure since the V2.6 layout
 * refresh — operators rarely glance at it but tests still want to
 * lock the contract. Click the toggle and verify the toggle worked.
 */
function expandMoreDetails() {
  const button = screen.getByRole("button", { name: /more details/i });
  fireEvent.click(button);
}

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
    // lastPollAt is tier 1 (always visible)
    expect(screen.getByText("2026-05-12 05:00:30Z")).toBeInTheDocument();
    // lastConfigReloadAt moved to tier 2 disclosure in V2.6
    expandMoreDetails();
    expect(screen.getByText("2026-05-12 05:00:00Z")).toBeInTheDocument();
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

    expandMoreDetails();
    expect(screen.getByText(/Workspace usage/i)).toBeInTheDocument();
    expect(screen.getByText(/12\.4\s*GB/i)).toBeInTheDocument();
    expect(screen.getByText(/Next cleanup/i)).toBeInTheDocument();
    expect(screen.getByText("2026-05-12 06:00:00Z")).toBeInTheDocument();
  });

  it("omits workspace usage / next cleanup when unset", () => {
    render(<ServiceHeader snapshot={snapshot} />);
    // Tier-2 panel only mounts on expand; even after expanding the
    // unset workspace / cleanup fields must not render.
    expandMoreDetails();
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
    // Tier 1 contributes one — (lastPollAt). With tier 2 disclosed
    // we get a second — for lastConfigReloadAt.
    expandMoreDetails();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("collapses tier-2 metadata by default and reveals it via the More details disclosure", () => {
    render(<ServiceHeader snapshot={snapshot} />);
    // Tier-2 fields are NOT in the DOM until disclosed.
    expect(screen.queryByText(/Last config reload/i)).not.toBeInTheDocument();
    expandMoreDetails();
    expect(screen.getByText(/Last config reload/i)).toBeInTheDocument();
  });
});
