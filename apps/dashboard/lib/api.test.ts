import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  archiveRun,
  getRunDetail,
  getState,
  listEvents,
  listReports,
  listRuns,
  resolveApiBase,
  retryRun,
  stopRun,
} from "./api";

const FAKE_BASE = "http://api.test";

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_BASE = FAKE_BASE;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_API_BASE;
  vi.restoreAllMocks();
});

function mockFetch(body: unknown, init: { status?: number } = {}) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("resolveApiBase", () => {
  it("uses NEXT_PUBLIC_API_BASE when set", () => {
    expect(resolveApiBase()).toBe(FAKE_BASE);
  });

  it("falls back to 127.0.0.1:4738 when env unset", () => {
    delete process.env.NEXT_PUBLIC_API_BASE;
    expect(resolveApiBase()).toBe("http://127.0.0.1:4738");
  });

  it("strips trailing slash", () => {
    process.env.NEXT_PUBLIC_API_BASE = `${FAKE_BASE}/`;
    expect(resolveApiBase()).toBe(FAKE_BASE);
  });
});

describe("getState", () => {
  it("GETs /api/state and returns typed snapshot", async () => {
    const fetchMock = mockFetch({
      service: {
        status: "ready",
        workflowPath: ".agents/workflow.md",
        gitlabProject: "g/p",
        pollIntervalMs: 10_000,
        concurrency: 1,
        lastConfigReloadAt: null,
        lastPollAt: null,
      },
      summary: {
        claimed: 0,
        running: 1,
        retrying: 0,
        completed: 2,
        failed: 0,
        blocked: 0,
      },
    });

    const state = await getState();

    expect(state.service.status).toBe("ready");
    expect(state.summary.running).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${FAKE_BASE}/api/state`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("throws ApiError on non-2xx", async () => {
    mockFetch({ error: "boom" }, { status: 500 });
    await expect(getState()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("listRuns", () => {
  it("encodes status and limit query", async () => {
    const fetchMock = mockFetch([]);

    await listRuns({ status: ["running", "blocked"], limit: 25 });

    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toBe(
      `${FAKE_BASE}/api/runs?status=running%2Cblocked&limit=25`,
    );
  });

  it("omits empty query parameters", async () => {
    const fetchMock = mockFetch([]);
    await listRuns();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${FAKE_BASE}/api/runs`);
  });
});

describe("getRunDetail", () => {
  it("hits /api/runs/:runId", async () => {
    const fetchMock = mockFetch({
      run: { runId: "r1", status: "running" },
      events: [],
      logsTail: ["log line"],
    });
    const detail = await getRunDetail("r1");
    expect(detail.run.runId).toBe("r1");
    expect(detail.logsTail).toEqual(["log line"]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${FAKE_BASE}/api/runs/r1`,
    );
  });

  it("URL-encodes runId", async () => {
    const fetchMock = mockFetch({ run: {}, events: [], logsTail: [] });
    await getRunDetail("r 1/2");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${FAKE_BASE}/api/runs/r%201%2F2`,
    );
  });

  it("preserves optional report field on detail responses", async () => {
    mockFetch({
      run: { runId: "r1", status: "completed" },
      events: [],
      logsTail: [],
      report: {
        version: 1,
        runId: "r1",
        mergeReadiness: { mode: "dry-run", status: "ready", reasons: [] },
      },
    });
    const detail = await getRunDetail("r1");
    expect(detail.report?.runId).toBe("r1");
    expect(detail.report?.mergeReadiness?.status).toBe("ready");
  });
});

describe("listReports", () => {
  it("GETs /api/reports and returns typed payload", async () => {
    const fetchMock = mockFetch({
      reports: [
        {
          runId: "r1",
          issueIid: 42,
          issueTitle: "Fix checkout",
          projectId: "group/project",
          status: "completed",
          labels: ["human-review"],
          attempt: 1,
          branch: "ai/42",
          mergeReadinessStatus: "ready",
          updatedAt: "2026-05-16T00:00:00.000Z",
        },
      ],
    });

    const result = await listReports();

    expect(result.reports[0]?.runId).toBe("r1");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${FAKE_BASE}/api/reports`,
    );
  });
});

describe("listEvents", () => {
  it("requires runId and passes paging", async () => {
    const fetchMock = mockFetch([]);
    await listEvents({ runId: "r1", limit: 50, offset: 10 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${FAKE_BASE}/api/events?runId=r1&limit=50&offset=10`,
    );
  });
});

describe("listRuns includeArchived", () => {
  it("passes includeArchived=true when requested", async () => {
    const fetchMock = mockFetch([]);
    await listRuns({ includeArchived: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${FAKE_BASE}/api/runs?includeArchived=true`,
    );
  });

  it("omits includeArchived when false", async () => {
    const fetchMock = mockFetch([]);
    await listRuns({ includeArchived: false });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${FAKE_BASE}/api/runs`);
  });
});

describe("operator action clients", () => {
  it("retryRun POSTs without operator header by default", async () => {
    const fetchMock = mockFetch({ ok: true });
    await retryRun("r-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${FAKE_BASE}/api/runs/r-1/retry`);
    const reqInit = init as RequestInit;
    expect(reqInit.method).toBe("POST");
    const headers = new Headers(reqInit.headers ?? undefined);
    expect(headers.get("x-issuepilot-operator")).toBeNull();
  });

  it("stopRun POSTs to /stop", async () => {
    const fetchMock = mockFetch({ ok: true });
    await stopRun("r-1");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${FAKE_BASE}/api/runs/r-1/stop`,
    );
  });

  it("archiveRun POSTs to /archive", async () => {
    const fetchMock = mockFetch({ ok: true });
    await archiveRun("r-1");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${FAKE_BASE}/api/runs/r-1/archive`,
    );
  });

  it("URL-encodes runId in the action path", async () => {
    const fetchMock = mockFetch({ ok: true });
    await retryRun("r 1/2");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${FAKE_BASE}/api/runs/r%201%2F2/retry`,
    );
  });

  it("throws ApiError on 409 invalid_status", async () => {
    mockFetch({ ok: false, code: "invalid_status" }, { status: 409 });
    await expect(stopRun("r-1")).rejects.toMatchObject({
      status: 409,
      code: "invalid_status",
    });
  });

  it("throws ApiError on 409 cancel_failed with reason", async () => {
    mockFetch(
      { ok: false, code: "cancel_failed", reason: "cancel_timeout" },
      { status: 409 },
    );
    await expect(stopRun("r-1")).rejects.toMatchObject({
      status: 409,
      code: "cancel_failed",
      reason: "cancel_timeout",
    });
  });

  it("throws ApiError on 503 actions_unavailable", async () => {
    mockFetch({ ok: false, code: "actions_unavailable" }, { status: 503 });
    await expect(retryRun("r-1")).rejects.toMatchObject({
      status: 503,
      code: "actions_unavailable",
    });
  });

  it("includes operator header when explicitly supplied", async () => {
    const fetchMock = mockFetch({ ok: true });
    await retryRun("r-1", { operator: "alice" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers ?? undefined);
    expect(headers.get("x-issuepilot-operator")).toBe("alice");
  });
});
