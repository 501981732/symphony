import { describe, it, expect, expectTypeOf } from "vitest";

import {
  DASHBOARD_SUMMARY_VALUES,
  SERVICE_STATUS_VALUES,
  isServiceStatus,
  type DashboardSummary,
  type OrchestratorStateSnapshot,
  type ServiceStatus,
} from "../state.js";

describe("@issuepilot/shared-contracts/state", () => {
  it("SERVICE_STATUS_VALUES enumerates starting/ready/degraded/stopping", () => {
    expect(new Set(SERVICE_STATUS_VALUES)).toEqual(
      new Set(["starting", "ready", "degraded", "stopping"]),
    );
  });

  it("isServiceStatus narrows known strings", () => {
    expect(isServiceStatus("ready")).toBe(true);
    expect(isServiceStatus("nope")).toBe(false);
  });

  it("ServiceStatus is the union of SERVICE_STATUS_VALUES", () => {
    expectTypeOf<ServiceStatus>().toEqualTypeOf<
      (typeof SERVICE_STATUS_VALUES)[number]
    >();
  });

  it("DASHBOARD_SUMMARY_VALUES follows spec section 14", () => {
    expect(DASHBOARD_SUMMARY_VALUES).toEqual([
      "running",
      "retrying",
      "human-review",
      "failed",
      "blocked",
    ]);
    expectTypeOf<DashboardSummary>()
      .toHaveProperty("human-review")
      .toEqualTypeOf<number>();
  });

  it("OrchestratorStateSnapshot describes service header + summary counters", () => {
    expectTypeOf<OrchestratorStateSnapshot>()
      .toHaveProperty("service")
      .toHaveProperty("status")
      .toEqualTypeOf<ServiceStatus>();
    expectTypeOf<OrchestratorStateSnapshot>()
      .toHaveProperty("service")
      .toHaveProperty("workflowPath")
      .toEqualTypeOf<string>();
    expectTypeOf<OrchestratorStateSnapshot>()
      .toHaveProperty("service")
      .toHaveProperty("concurrency")
      .toEqualTypeOf<number>();
    expectTypeOf<OrchestratorStateSnapshot>()
      .toHaveProperty("service")
      .toHaveProperty("lastPollAt")
      .toEqualTypeOf<string | null>();
    expectTypeOf<OrchestratorStateSnapshot>()
      .toHaveProperty("summary")
      .toEqualTypeOf<DashboardSummary>();
  });

  it("OrchestratorStateSnapshot.service exposes optional workspaceUsageGb + nextCleanupAt for Phase 5", () => {
    expectTypeOf<OrchestratorStateSnapshot>()
      .toHaveProperty("service")
      .toHaveProperty("workspaceUsageGb")
      .toEqualTypeOf<number | undefined>();
    expectTypeOf<OrchestratorStateSnapshot>()
      .toHaveProperty("service")
      .toHaveProperty("nextCleanupAt")
      .toEqualTypeOf<string | undefined>();

    const snapshot: OrchestratorStateSnapshot = {
      service: {
        status: "ready",
        workflowPath: "/srv/issuepilot/team.yaml",
        gitlabProject: "team",
        pollIntervalMs: 10_000,
        concurrency: 2,
        lastConfigReloadAt: null,
        lastPollAt: null,
        workspaceUsageGb: 12.4,
        nextCleanupAt: "2026-05-16T01:00:00.000Z",
      },
      summary: {
        running: 0,
        retrying: 0,
        "human-review": 0,
        failed: 0,
        blocked: 0,
      },
    };
    expect(snapshot.service.workspaceUsageGb).toBe(12.4);
    expect(snapshot.service.nextCleanupAt).toBe("2026-05-16T01:00:00.000Z");
  });

  it("accepts a team runtime snapshot with project summaries", () => {
    const snapshot: OrchestratorStateSnapshot = {
      service: {
        status: "ready",
        workflowPath: "/srv/issuepilot/team.yaml",
        gitlabProject: "team",
        pollIntervalMs: 10000,
        concurrency: 2,
        lastConfigReloadAt: "2026-05-15T00:00:00.000Z",
        lastPollAt: "2026-05-15T00:00:01.000Z",
      },
      summary: {
        running: 1,
        retrying: 0,
        "human-review": 1,
        failed: 0,
        blocked: 0,
      },
      runtime: {
        mode: "team",
        maxConcurrentRuns: 2,
        activeLeases: 1,
        projectCount: 2,
      },
      projects: [
        {
          id: "platform-web",
          name: "Platform Web",
          workflowPath: "/srv/platform-web/WORKFLOW.md",
          gitlabProject: "group/platform-web",
          enabled: true,
          activeRuns: 1,
          lastPollAt: "2026-05-15T00:00:01.000Z",
        },
        {
          id: "infra-tools",
          name: "Infra Tools",
          workflowPath: "/srv/infra-tools/WORKFLOW.md",
          gitlabProject: "group/infra-tools",
          enabled: true,
          activeRuns: 0,
          lastPollAt: null,
        },
      ],
    };

    expect(snapshot.runtime?.mode).toBe("team");
    expect(snapshot.projects?.map((project) => project.id)).toEqual([
      "platform-web",
      "infra-tools",
    ]);
  });
});
