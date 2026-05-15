// @vitest-environment jsdom
import type { ProjectSummary } from "@issuepilot/shared-contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectList } from "./project-list";

describe("ProjectList", () => {
  it("renders project status rows", () => {
    const projects: ProjectSummary[] = [
      {
        id: "platform-web",
        name: "Platform Web",
        workflowPath: "/srv/platform-web/WORKFLOW.md",
        gitlabProject: "group/platform-web",
        enabled: true,
        activeRuns: 1,
        lastPollAt: "2026-05-15T00:00:00.000Z",
      },
      {
        id: "infra-tools",
        name: "Infra Tools",
        workflowPath: "/srv/infra-tools/WORKFLOW.md",
        gitlabProject: "group/infra-tools",
        enabled: false,
        activeRuns: 0,
        lastPollAt: null,
        lastError: "workflow missing tracker.project_id",
      },
    ];

    render(<ProjectList projects={projects} />);

    expect(screen.getByText("Platform Web")).toBeInTheDocument();
    expect(screen.getByText("group/platform-web")).toBeInTheDocument();
    expect(screen.getByText("1 active")).toBeInTheDocument();
    expect(screen.getByText("Infra Tools")).toBeInTheDocument();
    expect(screen.getByText("disabled")).toBeInTheDocument();
    expect(
      screen.getByText("workflow missing tracker.project_id"),
    ).toBeInTheDocument();
  });
});
