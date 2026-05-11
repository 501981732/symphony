import { describe, it, expectTypeOf } from "vitest";

import {
  type EventsListResponse,
  type ListRunsQuery,
  type RunDetailResponse,
  type RunsListResponse,
} from "./api.js";
import { type IssuePilotEvent } from "./events.js";
import { type RunRecord, type RunStatus } from "./run.js";

describe("@issuepilot/shared-contracts/api", () => {
  it("ListRunsQuery allows single status or array, optional limit", () => {
    expectTypeOf<ListRunsQuery>()
      .toHaveProperty("status")
      .toEqualTypeOf<RunStatus | readonly RunStatus[] | undefined>();
    expectTypeOf<ListRunsQuery>()
      .toHaveProperty("limit")
      .toEqualTypeOf<number | undefined>();
  });

  it("RunsListResponse wraps an array of RunRecord", () => {
    expectTypeOf<RunsListResponse>()
      .toHaveProperty("runs")
      .toEqualTypeOf<RunRecord[]>();
  });

  it("RunDetailResponse bundles run + events + logsTail", () => {
    expectTypeOf<RunDetailResponse>()
      .toHaveProperty("run")
      .toEqualTypeOf<RunRecord>();
    expectTypeOf<RunDetailResponse>()
      .toHaveProperty("events")
      .toEqualTypeOf<IssuePilotEvent[]>();
    expectTypeOf<RunDetailResponse>()
      .toHaveProperty("logsTail")
      .toEqualTypeOf<string[]>();
  });

  it("EventsListResponse exposes events + nextCursor", () => {
    expectTypeOf<EventsListResponse>()
      .toHaveProperty("events")
      .toEqualTypeOf<IssuePilotEvent[]>();
    expectTypeOf<EventsListResponse>()
      .toHaveProperty("nextCursor")
      .toEqualTypeOf<string | undefined>();
  });
});
