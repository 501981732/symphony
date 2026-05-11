import { redact, type EventBus, type EventRecord } from "@issuepilot/observability";
import Fastify, { type FastifyInstance } from "fastify";

import type { RuntimeState } from "../runtime/state.js";

interface ServerDeps {
  state: RuntimeState;
  eventBus: EventBus<{ id: string; runId: string; type: string; [key: string]: unknown }>;
  readEvents: (
    runId: string,
    opts?: { limit?: number; offset?: number },
  ) => Promise<EventRecord[]>;
  workflowPath: string;
  gitlabProject: string;
  pollIntervalMs: number;
  concurrency: number;
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function createServer(
  deps: ServerDeps,
  opts: { host?: string; port?: number } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.addHook("onSend", async (_request, reply, payload) => {
    const contentType = String(reply.getHeader("content-type") ?? "");
    if (!contentType.includes("application/json")) return payload;

    const text = Buffer.isBuffer(payload) ? payload.toString("utf-8") : payload;
    if (typeof text !== "string" || text.length === 0) return payload;

    try {
      return JSON.stringify(redact(JSON.parse(text)));
    } catch {
      return payload;
    }
  });

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

  app.get<{
    Querystring: { runId?: string; limit?: string; offset?: string };
  }>("/api/events", async (request, reply) => {
    const runId = request.query.runId;
    if (!runId) {
      return reply.code(400).send({ error: "runId is required" });
    }

    const limit = parseOptionalPositiveInt(request.query.limit) ?? 100;
    const offset = parseOptionalPositiveInt(request.query.offset);
    const opts =
      offset === undefined
        ? { limit }
        : {
            limit,
            offset,
          };

    return deps.readEvents(runId, opts);
  });

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
        reply.raw.write(`data: ${JSON.stringify(redact(event))}\n\n`);
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
