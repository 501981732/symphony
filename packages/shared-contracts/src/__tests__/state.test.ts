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
});
