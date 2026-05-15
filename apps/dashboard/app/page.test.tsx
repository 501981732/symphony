// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import HomePage from "./page";
import { getState, listRuns } from "../lib/api";

vi.mock("../lib/api", () => ({
  getState: vi.fn(),
  listRuns: vi.fn(),
}));

describe("HomePage", () => {
  beforeEach(() => {
    vi.mocked(getState).mockReset();
    vi.mocked(listRuns).mockReset();
  });

  it("points users at workflow- and team-aware orchestrator startup commands when the API is unreachable", async () => {
    vi.mocked(getState).mockRejectedValue(new Error("fetch failed"));
    vi.mocked(listRuns).mockResolvedValue([]);

    render(await HomePage());

    expect(
      screen.getByText("IssuePilot orchestrator unreachable"),
    ).toBeInTheDocument();
    expect(screen.getByText("fetch failed")).toBeInTheDocument();
    expect(
      screen.getByText(
        "issuepilot run --workflow /path/to/target-project/WORKFLOW.md",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "issuepilot run --config /path/to/issuepilot.team.yaml",
      ),
    ).toBeInTheDocument();
  });

  it("fetches archived runs so the Show archived toggle has something to reveal", async () => {
    // RunsTable's `Show archived` toggle is gated on `runs.some(r =>
    // r.archivedAt)`, and the orchestrator default-hides archived runs.
    // Without `includeArchived: true` the toggle would never render even
    // when archived runs exist server-side. Lock the contract in place.
    vi.mocked(getState).mockResolvedValue({
      service: {
        status: "ready",
        workflowPath: "/tmp/workflow.md",
        gitlabProject: "group/project",
        pollIntervalMs: 5000,
        concurrency: 1,
        lastConfigReloadAt: null,
        lastPollAt: null,
      },
      summary: {
        running: 0,
        retrying: 0,
        "human-review": 0,
        failed: 0,
        blocked: 0,
      },
    });
    vi.mocked(listRuns).mockResolvedValue([]);

    await HomePage();

    expect(vi.mocked(listRuns)).toHaveBeenCalledWith({ includeArchived: true });
  });
});
