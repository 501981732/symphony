import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  getRunDetail,
  getState,
  listEvents,
  listRuns,
  resolveApiBase,
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
