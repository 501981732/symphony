import { createEventBus } from "@issuepilot/observability";
import type {
  ProjectSummary,
  TeamRuntimeSummary,
} from "@issuepilot/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OperatorActionResult } from "../../operations/actions.js";
import { createRuntimeState } from "../../runtime/state.js";
import { createServer, type ServerDeps } from "../index.js";

type TestEvent = {
  id: string;
  runId: string;
  type: string;
  message: string;
  [key: string]: unknown;
};

async function buildTestApp(
  readEvents: (
    runId: string,
    opts?: { limit?: number; offset?: number },
  ) => Promise<TestEvent[]> = async () => [],
  overrides: {
    workflowPath?: string;
    gitlabProject?: string;
    concurrency?: number;
    readLogsTail?: (
      runId: string,
      opts?: { limit?: number },
    ) => Promise<string[]>;
    runtime?: TeamRuntimeSummary | (() => TeamRuntimeSummary);
    projects?: ProjectSummary[] | (() => ProjectSummary[]);
    operatorActions?: ServerDeps["operatorActions"];
  } = {},
) {
  const state = createRuntimeState();
  const eventBus = createEventBus<TestEvent>();
  const app = await createServer(
    {
      state,
      eventBus,
      readEvents,
      readLogsTail: overrides.readLogsTail,
      workflowPath: overrides.workflowPath ?? ".agents/workflow.md",
      gitlabProject: overrides.gitlabProject ?? "group/project",
      pollIntervalMs: 10000,
      concurrency: overrides.concurrency ?? 1,
      ...(overrides.runtime ? { runtime: overrides.runtime } : {}),
      ...(overrides.projects ? { projects: overrides.projects } : {}),
      ...(overrides.operatorActions
        ? { operatorActions: overrides.operatorActions }
        : {}),
    },
    { port: 0 },
  );

  return { app, state, eventBus };
}

describe("Orchestrator HTTP API", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  let state: ReturnType<typeof createRuntimeState>;
  let eventBus: ReturnType<typeof createEventBus<TestEvent>>;

  beforeEach(async () => {
    const setup = await buildTestApp();
    app = setup.app;
    state = setup.state;
    eventBus = setup.eventBus;
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /api/state returns service snapshot", async () => {
    state.setRun("r-human-review", {
      runId: "r-human-review",
      status: "completed",
      attempt: 1,
      issue: { labels: ["human-review"] },
    });
    const response = await app.inject({ method: "GET", url: "/api/state" });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.service.status).toBe("ready");
    expect(body.summary).toMatchObject({
      running: 0,
      retrying: 0,
      "human-review": 1,
      failed: 0,
      blocked: 0,
    });
  });

  it("GET /api/state exposes team runtime metadata when configured", async () => {
    await app.close();
    const setup = await buildTestApp(async () => [], {
      workflowPath: "/srv/issuepilot.team.yaml",
      gitlabProject: "team",
      concurrency: 2,
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
          lastPollAt: null,
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
    });
    app = setup.app;

    const response = await app.inject({ method: "GET", url: "/api/state" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      service: {
        workflowPath: "/srv/issuepilot.team.yaml",
        gitlabProject: "team",
        concurrency: 2,
      },
      runtime: {
        mode: "team",
        activeLeases: 1,
        projectCount: 2,
      },
      projects: [
        { id: "platform-web", activeRuns: 1 },
        { id: "infra-tools", activeRuns: 0 },
      ],
    });
  });

  it("GET /api/state evaluates runtime/projects getters on each request", async () => {
    await app.close();
    let activeLeases = 0;
    let activeRuns = 0;
    const runtimeGetter = vi.fn(
      (): TeamRuntimeSummary => ({
        mode: "team",
        maxConcurrentRuns: 2,
        activeLeases,
        projectCount: 1,
      }),
    );
    const projectsGetter = vi.fn(
      (): ProjectSummary[] => [
        {
          id: "platform-web",
          name: "Platform Web",
          workflowPath: "/srv/platform-web/WORKFLOW.md",
          gitlabProject: "group/platform-web",
          enabled: true,
          activeRuns,
          lastPollAt: null,
        },
      ],
    );
    const setup = await buildTestApp(async () => [], {
      runtime: runtimeGetter,
      projects: projectsGetter,
    });
    app = setup.app;

    const first = await app.inject({ method: "GET", url: "/api/state" });
    expect(JSON.parse(first.body).runtime.activeLeases).toBe(0);
    expect(JSON.parse(first.body).projects[0].activeRuns).toBe(0);

    activeLeases = 1;
    activeRuns = 2;
    const second = await app.inject({ method: "GET", url: "/api/state" });
    expect(JSON.parse(second.body).runtime.activeLeases).toBe(1);
    expect(JSON.parse(second.body).projects[0].activeRuns).toBe(2);
    expect(runtimeGetter).toHaveBeenCalledTimes(2);
    expect(projectsGetter).toHaveBeenCalledTimes(2);
  });

  it("GET /api/state redacts response fields", async () => {
    await app.close();
    const setup = await buildTestApp(async () => [], {
      workflowPath: "Bearer secret-token",
    });
    app = setup.app;

    const response = await app.inject({ method: "GET", url: "/api/state" });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("secret-token");
    expect(response.body).toContain("[REDACTED]");
  });

  it("GET /api/runs returns empty array initially", async () => {
    const response = await app.inject({ method: "GET", url: "/api/runs" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([]);
  });

  it("GET /api/runs returns redacted runs after adding", async () => {
    await app.close();
    const setup = await buildTestApp(async () => [
      {
        id: "e1",
        runId: "r1",
        type: "turn_started",
        message: "turn started",
        createdAt: "2026-05-12T05:00:00.000Z",
      },
      {
        id: "e2",
        runId: "r1",
        type: "turn_completed",
        message: "turn completed",
        createdAt: "2026-05-12T05:01:00.000Z",
      },
    ]);
    app = setup.app;
    state = setup.state;
    state.setRun("r1", {
      runId: "r1",
      status: "running",
      attempt: 1,
      details: "using Bearer secret-token",
    });
    const response = await app.inject({ method: "GET", url: "/api/runs" });
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(1);
    expect(body[0].runId).toBe("r1");
    expect(body[0].turnCount).toBe(2);
    expect(body[0].lastEvent).toEqual({
      type: "turn_completed",
      message: "turn completed",
      createdAt: "2026-05-12T05:01:00.000Z",
    });
    expect(response.body).not.toContain("secret-token");
    expect(response.body).toContain("[REDACTED]");
  });

  it("GET /api/runs rejects invalid limits", async () => {
    for (const limit of ["10abc", "1.5", "-1", "0"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/runs?limit=${encodeURIComponent(limit)}`,
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        error: "limit must be a positive integer",
      });
    }
  });

  it("GET /api/runs/:runId returns redacted specific run", async () => {
    await app.close();
    const setup = await buildTestApp(
      async () => [
        {
          id: "e1",
          runId: "r1",
          type: "run_started",
          message: "started",
        },
      ],
      { readLogsTail: async () => ["line 1"] },
    );
    app = setup.app;
    state = setup.state;
    state.setRun("r1", {
      runId: "r1",
      status: "running",
      attempt: 1,
      token: "glpat-12345678901234567890",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/runs/r1",
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      run: { runId: "r1" },
      events: [{ id: "e1", runId: "r1", type: "run_started" }],
      logsTail: ["line 1"],
    });
    expect(response.body).not.toContain("glpat-12345678901234567890");
    expect(response.body).toContain("[REDACTED]");
  });

  it("GET /api/runs/:runId returns 404 for unknown id", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/runs/nonexistent",
    });
    expect(response.statusCode).toBe(404);
  });

  it("GET /api/events reads persisted history by runId with paging", async () => {
    await app.close();
    const calls: Array<{
      runId: string;
      opts?: { limit?: number; offset?: number };
    }> = [];
    const setup = await buildTestApp(async (runId, opts) => {
      calls.push({ runId, opts });
      return [
        {
          id: "e1",
          runId,
          type: "run_started",
          message: "started",
        },
      ];
    });
    app = setup.app;

    const response = await app.inject({
      method: "GET",
      url: "/api/events?runId=r1&limit=25&offset=5",
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([
      {
        id: "e1",
        runId: "r1",
        type: "run_started",
        message: "started",
      },
    ]);
    expect(calls).toEqual([{ runId: "r1", opts: { limit: 25, offset: 5 } }]);
  });

  it("GET /api/events accepts offset zero", async () => {
    await app.close();
    const calls: Array<{
      runId: string;
      opts?: { limit?: number; offset?: number };
    }> = [];
    const setup = await buildTestApp(async (runId, opts) => {
      calls.push({ runId, opts });
      return [];
    });
    app = setup.app;

    const response = await app.inject({
      method: "GET",
      url: "/api/events?runId=r1&offset=0",
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([]);
    expect(calls).toEqual([{ runId: "r1", opts: { limit: 100, offset: 0 } }]);
  });

  it("GET /api/events defaults limit and redacts persisted history responses", async () => {
    await app.close();
    const calls: Array<{
      runId: string;
      opts?: { limit?: number; offset?: number };
    }> = [];
    const setup = await buildTestApp(async (runId, opts) => {
      calls.push({ runId, opts });
      return [
        {
          id: "e1",
          runId,
          type: "tool_output",
          message: "called with Bearer secret-token",
          token: "glpat-12345678901234567890",
        },
      ];
    });
    app = setup.app;

    const response = await app.inject({
      method: "GET",
      url: "/api/events?runId=r1",
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([{ runId: "r1", opts: { limit: 100 } }]);
    expect(response.body).not.toContain("secret-token");
    expect(response.body).not.toContain("glpat-12345678901234567890");
    expect(response.body).toContain("[REDACTED]");
  });

  it("GET /api/events returns empty array for unknown runs", async () => {
    await app.close();
    const setup = await buildTestApp(async () => []);
    app = setup.app;

    const response = await app.inject({
      method: "GET",
      url: "/api/events?runId=missing",
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([]);
  });

  it("GET /api/events requires runId", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/events",
    });

    expect(response.statusCode).toBe(400);
  });

  it("GET /api/events rejects invalid limits", async () => {
    for (const limit of ["10abc", "1.5", "-1", "0"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/events?runId=r1&limit=${encodeURIComponent(limit)}`,
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        error: "limit must be a positive integer",
      });
    }
  });

  it("GET /api/events rejects invalid offsets", async () => {
    for (const offset of ["10abc", "1.5", "-1"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/events?runId=r1&offset=${encodeURIComponent(offset)}`,
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        error: "offset must be a non-negative integer",
      });
    }
  });

  it("GET /api/events/stream filters and redacts SSE payloads", async () => {
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind to a TCP port");
    }

    const controller = new AbortController();
    const responsePromise = fetch(
      `http://127.0.0.1:${address.port}/api/events/stream?runId=r1`,
      { signal: controller.signal },
    );
    const response = await responsePromise;
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing response body reader");

    eventBus.publish({
      id: "e-other",
      runId: "r2",
      type: "tool_output",
      message: "ignore Bearer other-secret",
    });
    eventBus.publish({
      id: "e1",
      runId: "r1",
      type: "tool_output",
      message: "called with Bearer secret-token",
      token: "glpat-12345678901234567890",
    });

    const decoder = new TextDecoder();
    let body = "";
    const deadline = Date.now() + 1_000;
    while (!body.includes('"id":"e1"') && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    controller.abort();

    expect(body).toContain("data:");
    expect(body).toContain('"id":"e1"');
    expect(body).not.toContain("e-other");
    expect(body).not.toContain("secret-token");
    expect(body).not.toContain("glpat-12345678901234567890");
    expect(body).toContain("[REDACTED]");
  });
});

type ActionFn = (input: {
  runId: string;
  operator: string;
}) => Promise<OperatorActionResult>;

function buildActions(partial: {
  retry?: ActionFn;
  stop?: ActionFn;
  archive?: ActionFn;
}): NonNullable<ServerDeps["operatorActions"]> {
  return {
    retry: partial.retry ?? (async () => ({ ok: true })),
    stop: partial.stop ?? (async () => ({ ok: true })),
    archive: partial.archive ?? (async () => ({ ok: true })),
  };
}

describe("operator action routes", () => {
  it("POST /api/runs/:runId/retry returns 200 and defaults operator to system", async () => {
    const retry = vi.fn<ActionFn>(async () => ({ ok: true }));
    const { app } = await buildTestApp(async () => [], {
      operatorActions: buildActions({ retry }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/retry",
      });
      expect(resp.statusCode).toBe(200);
      expect(JSON.parse(resp.body)).toEqual({ ok: true });
      expect(retry).toHaveBeenCalledWith({
        runId: "run-1",
        operator: "system",
      });
    } finally {
      await app.close();
    }
  });

  it("POST honors x-issuepilot-operator header", async () => {
    const retry = vi.fn<ActionFn>(async () => ({ ok: true }));
    const { app } = await buildTestApp(async () => [], {
      operatorActions: buildActions({ retry }),
    });
    try {
      await app.inject({
        method: "POST",
        url: "/api/runs/run-1/retry",
        headers: { "x-issuepilot-operator": "alice" },
      });
      expect(retry).toHaveBeenCalledWith({
        runId: "run-1",
        operator: "alice",
      });
    } finally {
      await app.close();
    }
  });

  it("POST returns 409 on invalid_status", async () => {
    const stop = vi.fn<ActionFn>(async () => ({
      ok: false,
      code: "invalid_status",
    }));
    const { app } = await buildTestApp(async () => [], {
      operatorActions: buildActions({ stop }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/stop",
      });
      expect(resp.statusCode).toBe(409);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "invalid_status",
      });
    } finally {
      await app.close();
    }
  });

  it("POST returns 409 on cancel_failed and surfaces reason", async () => {
    const stop = vi.fn<ActionFn>(async () => ({
      ok: false,
      code: "cancel_failed",
      reason: "cancel_timeout",
    }));
    const { app } = await buildTestApp(async () => [], {
      operatorActions: buildActions({ stop }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/stop",
      });
      expect(resp.statusCode).toBe(409);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "cancel_failed",
        reason: "cancel_timeout",
      });
    } finally {
      await app.close();
    }
  });

  it("POST returns 404 on not_found", async () => {
    const archive = vi.fn<ActionFn>(async () => ({
      ok: false,
      code: "not_found",
    }));
    const { app } = await buildTestApp(async () => [], {
      operatorActions: buildActions({ archive }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/archive",
      });
      expect(resp.statusCode).toBe(404);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "not_found",
      });
    } finally {
      await app.close();
    }
  });

  it("POST returns 500 on gitlab_failed", async () => {
    const retry = vi.fn<ActionFn>(async () => ({
      ok: false,
      code: "gitlab_failed",
      message: "no route to host",
    }));
    const { app } = await buildTestApp(async () => [], {
      operatorActions: buildActions({ retry }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/retry",
      });
      expect(resp.statusCode).toBe(500);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "gitlab_failed",
      });
    } finally {
      await app.close();
    }
  });

  it("POST returns 503 actions_unavailable when operatorActions is not wired", async () => {
    const { app } = await buildTestApp();
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/retry",
      });
      expect(resp.statusCode).toBe(503);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "actions_unavailable",
      });
    } finally {
      await app.close();
    }
  });

  it("dispatches to stop and archive routes by URL path", async () => {
    const stop = vi.fn<ActionFn>(async () => ({ ok: true }));
    const archive = vi.fn<ActionFn>(async () => ({ ok: true }));
    const { app } = await buildTestApp(async () => [], {
      operatorActions: buildActions({ stop, archive }),
    });
    try {
      await app.inject({ method: "POST", url: "/api/runs/run-1/stop" });
      expect(stop).toHaveBeenCalledTimes(1);

      await app.inject({ method: "POST", url: "/api/runs/run-1/archive" });
      expect(archive).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

describe("archived run filter", () => {
  it("GET /api/runs hides archived runs by default", async () => {
    const { app, state } = await buildTestApp();
    try {
      state.setRun("active", {
        runId: "active",
        status: "completed",
        attempt: 1,
        issue: {
          id: "1",
          iid: 1,
          title: "Fix",
          url: "https://example/-/issues/1",
          projectId: "g/p",
          labels: [],
        },
      });
      state.setRun("archived", {
        runId: "archived",
        status: "completed",
        attempt: 1,
        archivedAt: "2026-05-15T00:00:00.000Z",
        issue: {
          id: "2",
          iid: 2,
          title: "Done",
          url: "https://example/-/issues/2",
          projectId: "g/p",
          labels: [],
        },
      });

      const resp = await app.inject({ method: "GET", url: "/api/runs" });
      const body = JSON.parse(resp.body) as Array<{ runId: string }>;
      expect(body.map((r) => r.runId)).toEqual(["active"]);
    } finally {
      await app.close();
    }
  });

  it("GET /api/runs?includeArchived=true returns archived runs", async () => {
    const { app, state } = await buildTestApp();
    try {
      state.setRun("archived", {
        runId: "archived",
        status: "completed",
        attempt: 1,
        archivedAt: "2026-05-15T00:00:00.000Z",
        issue: {
          id: "2",
          iid: 2,
          title: "Done",
          url: "https://example/-/issues/2",
          projectId: "g/p",
          labels: [],
        },
      });

      const resp = await app.inject({
        method: "GET",
        url: "/api/runs?includeArchived=true",
      });
      const body = JSON.parse(resp.body) as Array<{ runId: string }>;
      expect(body.map((r) => r.runId)).toContain("archived");
    } finally {
      await app.close();
    }
  });

  it("GET /api/runs ignores invalid includeArchived values", async () => {
    const { app, state } = await buildTestApp();
    try {
      state.setRun("archived", {
        runId: "archived",
        status: "completed",
        attempt: 1,
        archivedAt: "2026-05-15T00:00:00.000Z",
        issue: {
          id: "2",
          iid: 2,
          title: "Done",
          url: "https://example/-/issues/2",
          projectId: "g/p",
          labels: [],
        },
      });

      const resp = await app.inject({
        method: "GET",
        url: "/api/runs?includeArchived=yes",
      });
      const body = JSON.parse(resp.body) as Array<{ runId: string }>;
      expect(body).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
