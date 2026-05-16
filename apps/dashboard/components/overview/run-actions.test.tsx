// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { RunActions, type RunActionsSnapshot } from "./run-actions";

function snapshot(overrides: Partial<RunActionsSnapshot> = {}): RunActionsSnapshot {
  return {
    runId: "r-1",
    status: "failed",
    ...overrides,
  };
}

describe("RunActions", () => {
  it("renders Retry and Archive for a failed run", () => {
    render(
      <RunActions
        run={snapshot({ status: "failed" })}
        onRetry={vi.fn()}
        onStop={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /archive/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /stop/i }),
    ).not.toBeInTheDocument();
  });

  it("renders Retry and Archive for a blocked run", () => {
    render(
      <RunActions
        run={snapshot({ status: "blocked" })}
        onRetry={vi.fn()}
        onStop={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /archive/i }),
    ).toBeInTheDocument();
  });

  it("renders Stop for a running run", () => {
    render(
      <RunActions
        run={snapshot({ status: "running" })}
        onRetry={vi.fn()}
        onStop={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /retry/i }),
    ).not.toBeInTheDocument();
  });

  it("renders Archive but not Retry/Stop for a completed run", () => {
    render(
      <RunActions
        run={snapshot({ status: "completed" })}
        onRetry={vi.fn()}
        onStop={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /archive/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /retry/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /stop/i }),
    ).not.toBeInTheDocument();
  });

  it("hides everything when the run is archived", () => {
    const { container } = render(
      <RunActions
        run={snapshot({ status: "failed", archivedAt: "2026-05-15T00:00:00Z" })}
        onRetry={vi.fn()}
        onStop={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("hides everything when no action applies (claimed)", () => {
    const { container } = render(
      <RunActions
        run={snapshot({ status: "claimed" })}
        onRetry={vi.fn()}
        onStop={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("invokes onRetry with runId when Retry is clicked", () => {
    const onRetry = vi.fn();
    render(
      <RunActions
        run={snapshot({ runId: "r-9", status: "failed" })}
        onRetry={onRetry}
        onStop={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledWith("r-9");
  });

  it("invokes onStop with runId when Stop is clicked", () => {
    const onStop = vi.fn();
    render(
      <RunActions
        run={snapshot({ runId: "r-9", status: "running" })}
        onRetry={vi.fn()}
        onStop={onStop}
        onArchive={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /stop/i }));
    expect(onStop).toHaveBeenCalledWith("r-9");
  });

  it("invokes onArchive with runId when Archive is clicked", () => {
    const onArchive = vi.fn();
    render(
      <RunActions
        run={snapshot({ runId: "r-9", status: "completed" })}
        onRetry={vi.fn()}
        onStop={vi.fn()}
        onArchive={onArchive}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /archive/i }));
    expect(onArchive).toHaveBeenCalledWith("r-9");
  });

  it("disables buttons while pending is true", () => {
    render(
      <RunActions
        run={snapshot({ status: "failed" })}
        onRetry={vi.fn()}
        onStop={vi.fn()}
        onArchive={vi.fn()}
        pending
      />,
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /archive/i })).toBeDisabled();
  });
});
