// @vitest-environment jsdom
import type { ProjectSummary } from "@issuepilot/shared-contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

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

  it("distinguishes manually-disabled projects from load-error projects", () => {
    render(
      <ProjectList
        projects={[
          {
            id: "manual-off",
            name: "Manual Off",
            workflowPath: "/srv/manual-off/WORKFLOW.md",
            gitlabProject: "group/manual-off",
            enabled: false,
            activeRuns: 0,
            lastPollAt: null,
            disabledReason: "config",
          },
          {
            id: "broken-wf",
            name: "Broken WF",
            workflowPath: "/srv/broken-wf/WORKFLOW.md",
            gitlabProject: "group/broken-wf",
            enabled: false,
            activeRuns: 0,
            lastPollAt: null,
            disabledReason: "load-error",
            lastError: "ENOENT: workflow file missing",
          },
        ]}
      />,
    );

    expect(screen.getByText("disabled")).toBeInTheDocument();
    expect(screen.getByText("load error")).toBeInTheDocument();
    expect(
      screen.getByText("ENOENT: workflow file missing"),
    ).toBeInTheDocument();
  });

  it("renders Last poll in a stable UTC format to avoid SSR hydration mismatch", () => {
    render(
      <ProjectList
        projects={[
          {
            id: "platform-web",
            name: "Platform Web",
            workflowPath: "/srv/platform-web/WORKFLOW.md",
            gitlabProject: "group/platform-web",
            enabled: true,
            activeRuns: 0,
            lastPollAt: "2026-05-15T01:23:45.000Z",
          },
        ]}
      />,
    );

    expect(
      screen.getByText("Last poll: 2026-05-15 01:23:45Z"),
    ).toBeInTheDocument();
  });
});
