import { describe, it, expect } from "vitest";

import {
  parseSmokeArgs,
  pollUntilReady,
  formatReadyBanner,
  type ServiceState,
} from "../../scripts/smoke-runner.js";

describe("parseSmokeArgs", () => {
  it("returns workflow-required error when --workflow missing", () => {
    const result = parseSmokeArgs([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/--workflow/);
    }
  });

  it("parses workflow, port and dashboard url", () => {
    const result = parseSmokeArgs([
      "--workflow",
      "/tmp/workflow.md",
      "--port",
      "4040",
      "--dashboard-url",
      "http://localhost:3001",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.workflowPath).toBe("/tmp/workflow.md");
      expect(result.options.port).toBe(4040);
      expect(result.options.dashboardUrl).toBe("http://localhost:3001");
    }
  });

  it("rejects malformed port", () => {
    const result = parseSmokeArgs([
      "--workflow",
      "/tmp/workflow.md",
      "--port",
      "abc",
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/port/);
    }
  });

  it("applies sensible defaults", () => {
    const result = parseSmokeArgs(["--workflow", "/tmp/workflow.md"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.port).toBe(4738);
      expect(result.options.dashboardUrl).toBe("http://localhost:3000");
      expect(result.options.readinessTimeoutMs).toBe(15_000);
    }
  });
});

describe("pollUntilReady", () => {
  it("resolves with state once /api/state returns service.status === ready", async () => {
    let attempts = 0;
    const ready: ServiceState = {
      service: {
        status: "ready",
        workflowPath: "/tmp/workflow.md",
        gitlabProject: "group/proj",
        pollIntervalMs: 1000,
        concurrency: 2,
      },
      summary: { running: 0 },
    } as unknown as ServiceState;
    const result = await pollUntilReady("http://127.0.0.1:9/api/state", {
      timeoutMs: 1_000,
      intervalMs: 10,
      fetch: async () => {
        attempts += 1;
        if (attempts < 3) {
          return new Response("not ready", { status: 503 });
        }
        return new Response(JSON.stringify(ready), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(result.service.status).toBe("ready");
    expect(result.service.gitlabProject).toBe("group/proj");
  });

  it("rejects with timeout error if service never reports ready", async () => {
    await expect(
      pollUntilReady("http://127.0.0.1:9/api/state", {
        timeoutMs: 80,
        intervalMs: 20,
        fetch: async () => new Response("nope", { status: 500 }),
      }),
    ).rejects.toThrow(/did not report ready/i);
  });

  it("propagates JSON shape errors as fatal", async () => {
    await expect(
      pollUntilReady("http://127.0.0.1:9/api/state", {
        timeoutMs: 80,
        intervalMs: 20,
        fetch: async () =>
          new Response(JSON.stringify({ service: { status: "ready" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).resolves.toBeTruthy();
  });
});

describe("formatReadyBanner", () => {
  const state: ServiceState = {
    service: {
      status: "ready",
      workflowPath: "/tmp/workflow.md",
      gitlabProject: "group/proj",
      pollIntervalMs: 5_000,
      concurrency: 2,
    },
    summary: { running: 0 } as ServiceState["summary"],
  };

  it("emits a banner including api url and dashboard url", () => {
    const banner = formatReadyBanner({
      apiUrl: "http://127.0.0.1:4738",
      dashboardUrl: "http://localhost:3000",
      state,
    });
    expect(banner).toMatch(/IssuePilot daemon ready/);
    expect(banner).toMatch(/http:\/\/127\.0\.0\.1:4738/);
    expect(banner).toMatch(/http:\/\/localhost:3000/);
    expect(banner).toMatch(/group\/proj/);
    expect(banner).toMatch(/Ctrl\+C/);
  });
});
