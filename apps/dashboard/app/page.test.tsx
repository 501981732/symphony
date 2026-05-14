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

  it("points users at workflow-aware orchestrator startup commands when the API is unreachable", async () => {
    vi.mocked(getState).mockRejectedValue(new Error("fetch failed"));
    vi.mocked(listRuns).mockResolvedValue([]);

    render(await HomePage());

    expect(
      screen.getByText("IssuePilot orchestrator unreachable"),
    ).toBeInTheDocument();
    expect(screen.getByText("fetch failed")).toBeInTheDocument();
    expect(
      screen.getByText(
        "pnpm smoke --workflow /path/to/target-project/.agents/workflow.md",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "pnpm exec issuepilot run --workflow /path/to/target-project/.agents/workflow.md",
      ),
    ).toBeInTheDocument();
  });
});
