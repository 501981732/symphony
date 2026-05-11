import Fastify, { type FastifyInstance } from "fastify";
import type { RuntimeState } from "../runtime/state.js";
import type { EventBus } from "@issuepilot/observability";

interface ServerDeps {
  state: RuntimeState;
  eventBus: EventBus<{ id: string; runId: string; type: string; [key: string]: unknown }>;
  workflowPath: string;
  gitlabProject: string;
  pollIntervalMs: number;
  concurrency: number;
}

export async function createServer(
  deps: ServerDeps,
  opts: { host?: string; port?: number } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get("/api/state", async () => {
    return {
      service: {
        status: "ready",
        workflowPath: deps.workflowPath,
        gitlabProject: deps.gitlabProject,
        pollIntervalMs: deps.pollIntervalMs,
        concurrency: deps.concurrency,
        lastConfigReloadAt: deps.state.lastConfigReloadAt,
        lastPollAt: deps.state.lastPollAt,
      },
      summary: deps.state.summary(),
    };
  });

  app.get<{ Querystring: { status?: string; limit?: string } }>(
    "/api/runs",
    async (request) => {
      const status = request.query.status;
      const limit = request.query.limit
        ? parseInt(request.query.limit, 10)
        : 50;
      let runs = status
        ? deps.state.listRuns(status)
        : deps.state.allRuns();
      runs = runs.slice(0, limit);
      return runs;
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/api/runs/:runId",
    async (request, reply) => {
      const run = deps.state.getRun(request.params.runId);
      if (!run) {
        return reply.code(404).send({ error: "Run not found" });
      }
      return run;
    },
  );

  app.get("/api/events/stream", (request, reply) => {
    const runIdFilter = (request.query as { runId?: string }).runId;

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const keepalive = setInterval(() => {
      reply.raw.write(": keepalive\n\n");
    }, 15_000);

    const unsub = deps.eventBus.subscribe(
      (event) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      runIdFilter ? (e) => e.runId === runIdFilter : undefined,
    );

    request.raw.on("close", () => {
      clearInterval(keepalive);
      unsub();
    });
  });

  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4738;
  await app.listen({ host, port });

  return app;
}
