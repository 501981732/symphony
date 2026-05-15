import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LeaseStore } from "../../runtime/leases.js";
import type { ServerDeps } from "../../server/index.js";
import type { TeamConfig } from "../config.js";
import { startTeamDaemon } from "../daemon.js";
import type { ProjectRegistry } from "../registry.js";

interface FakeServer {
  listening: boolean;
  close: ReturnType<typeof vi.fn>;
  server: { address: () => { port: number } };
}

let createdDeps: ServerDeps | null;
let createdApp: FakeServer | null;

const baseConfig = (): TeamConfig => ({
  version: 1,
  server: { host: "127.0.0.1", port: 0 },
  scheduler: {
    maxConcurrentRuns: 2,
    maxConcurrentRunsPerProject: 1,
    leaseTtlMs: 900_000,
    pollIntervalMs: 10_000,
  },
  projects: [
    {
      id: "platform-web",
      name: "Platform Web",
      workflowPath: "/srv/platform-web/WORKFLOW.md",
      enabled: true,
    },
    {
      id: "infra-tools",
      name: "Infra Tools",
      workflowPath: "/srv/infra-tools/WORKFLOW.md",
      enabled: false,
    },
  ],
  retention: {
    successfulRunDays: 7,
    failedRunDays: 14,
    maxWorkspaceGb: 20,
  },
  source: {
    path: "/srv/issuepilot/issuepilot.team.yaml",
    sha256: "sha",
    loadedAt: new Date(0).toISOString(),
  },
});

const summaries = [
  {
    id: "platform-web",
    name: "Platform Web",
    workflowPath: "/srv/platform-web/WORKFLOW.md",
    gitlabProject: "group/platform-web",
    enabled: true as const,
    activeRuns: 0,
    lastPollAt: null,
  },
  {
    id: "infra-tools",
    name: "Infra Tools",
    workflowPath: "/srv/infra-tools/WORKFLOW.md",
    gitlabProject: "",
    enabled: false as const,
    activeRuns: 0,
    lastPollAt: null,
  },
];

beforeEach(() => {
  createdDeps = null;
  createdApp = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startTeamDaemon", () => {
  it("starts a project-aware server shell using parsed team config", async () => {
    const loadTeamConfig = vi.fn(async () => baseConfig());
    let summariesValue = [...summaries];
    const registry: ProjectRegistry = {
      enabledProjects: () => [],
      project: () => undefined,
      summaries: () => summariesValue,
      updateProjectPoll: () => {},
      updateProjectActiveRuns: () => {},
    };
    const createProjectRegistry = vi.fn(async () => registry);
    let cachedActive = 0;
    const leaseStore: LeaseStore = {
      acquire: vi.fn(async () => null),
      release: vi.fn(async () => undefined),
      heartbeat: vi.fn(async () => null),
      expireStale: vi.fn(async () => []),
      active: vi.fn(async () => []),
      activeCount: () => cachedActive,
    };
    const createLeaseStore = vi.fn(() => leaseStore);
    const createServer = vi.fn(async (deps: ServerDeps) => {
      createdDeps = deps;
      const close = vi.fn(async () => {
        if (createdApp) createdApp.listening = false;
      });
      const fake: FakeServer = {
        listening: true,
        close,
        server: { address: () => ({ port: 4738 }) },
      };
      createdApp = fake;
      return fake as never;
    });

    const handle = await startTeamDaemon(
      { configPath: "/srv/issuepilot.team.yaml", host: "127.0.0.1", port: 4738 },
      {
        loadTeamConfig,
        createProjectRegistry,
        createServer,
        createLeaseStore,
      },
    );

    expect(handle.url).toBe("http://127.0.0.1:4738");
    expect(createdDeps).not.toBeNull();
    expect(createdDeps).toMatchObject({
      workflowPath: "/srv/issuepilot/issuepilot.team.yaml",
      gitlabProject: "team",
      concurrency: 2,
    });
    expect(typeof createdDeps?.runtime).toBe("function");
    expect(typeof createdDeps?.projects).toBe("function");

    const runtimeGetter = createdDeps!.runtime as () => {
      mode: string;
      activeLeases: number;
      projectCount: number;
    };
    const projectsGetter = createdDeps!.projects as () => typeof summaries;
    expect(runtimeGetter()).toEqual({
      mode: "team",
      maxConcurrentRuns: 2,
      activeLeases: 0,
      projectCount: 2,
    });
    expect(projectsGetter()).toEqual(summaries);

    cachedActive = 1;
    summariesValue = [
      { ...summaries[0]!, activeRuns: 1, lastPollAt: "2026-05-15T01:00:00.000Z" },
      summaries[1]!,
    ];
    expect(runtimeGetter().activeLeases).toBe(1);
    expect(projectsGetter()[0]?.activeRuns).toBe(1);

    expect(createLeaseStore).toHaveBeenCalled();
    const leaseOpts = createLeaseStore.mock.calls[0]?.[0] as {
      filePath: string;
    };
    expect(leaseOpts.filePath).toMatch(/leases-/);

    await handle.stop();
    expect(createdApp?.close).toHaveBeenCalled();
  });
});
