import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { createRuntimeState } from "../runtime/state.js";
import { createEventBus } from "@issuepilot/observability";

async function buildTestApp() {
  const state = createRuntimeState();
  const eventBus = createEventBus<{
    id: string;
    runId: string;
    type: string;
    [key: string]: unknown;
  }>();

  const app = Fastify({ logger: false });

  app.get("/api/state", async () => ({
    service: {
      status: "ready",
      workflowPath: ".agents/workflow.md",
      gitlabProject: "group/project",
      pollIntervalMs: 10000,
      concurrency: 1,
      lastConfigReloadAt: state.lastConfigReloadAt,
      lastPollAt: state.lastPollAt,
    },
    summary: state.summary(),
  }));

  app.get("/api/runs", async () => state.allRuns());

  app.get<{ Params: { runId: string } }>(
    "/api/runs/:runId",
    async (request, reply) => {
      const run = state.getRun(request.params.runId);
      if (!run) return reply.code(404).send({ error: "Run not found" });
      return run;
    },
  );

  return { app, state, eventBus };
}

describe("Orchestrator HTTP API", () => {
  let app: Awaited<ReturnType<typeof Fastify>>;
  let state: ReturnType<typeof createRuntimeState>;

  beforeAll(async () => {
    const setup = await buildTestApp();
    app = setup.app;
    state = setup.state;
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/state returns service snapshot", async () => {
    const response = await app.inject({ method: "GET", url: "/api/state" });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.service.status).toBe("ready");
    expect(body.summary).toBeDefined();
  });

  it("GET /api/runs returns empty array initially", async () => {
    const response = await app.inject({ method: "GET", url: "/api/runs" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([]);
  });

  it("GET /api/runs returns runs after adding", async () => {
    state.setRun("r1", { runId: "r1", status: "running", attempt: 1 });
    const response = await app.inject({ method: "GET", url: "/api/runs" });
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(1);
    expect(body[0].runId).toBe("r1");
  });

  it("GET /api/runs/:runId returns specific run", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/runs/r1",
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).runId).toBe("r1");
  });

  it("GET /api/runs/:runId returns 404 for unknown id", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/runs/nonexistent",
    });
    expect(response.statusCode).toBe(404);
  });
});
