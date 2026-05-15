import * as os from "node:os";
import * as path from "node:path";

import { createEventBus, type EventBus } from "@issuepilot/observability";
import { createWorkflowLoader } from "@issuepilot/workflow";

import {
  createLeaseStore as defaultCreateLeaseStore,
  type LeaseStore,
} from "../runtime/leases.js";
import {
  createRuntimeState,
  type RuntimeState,
} from "../runtime/state.js";
import { createServer } from "../server/index.js";

import {
  loadTeamConfig as defaultLoadTeamConfig,
  type TeamConfig,
} from "./config.js";
import {
  createProjectRegistry as defaultCreateProjectRegistry,
  type ProjectRegistry,
  type WorkflowLoaderLike,
} from "./registry.js";

/**
 * Public handle returned by {@link startTeamDaemon}. `wait()` resolves when
 * the server reports a graceful shutdown; `stop()` requests one.
 */
export interface TeamDaemonHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
  wait(): Promise<void>;
}

export interface StartTeamDaemonOptions {
  configPath: string;
  host?: string | undefined;
  port?: number | undefined;
}

export interface StartTeamDaemonDeps {
  loadTeamConfig?:
    | ((configPath: string) => Promise<TeamConfig>)
    | undefined;
  createProjectRegistry?:
    | ((
        config: TeamConfig,
        workflowLoader: WorkflowLoaderLike,
      ) => Promise<ProjectRegistry>)
    | undefined;
  createServer?: typeof createServer | undefined;
  createLeaseStore?:
    | ((opts: { filePath: string; now?: () => Date }) => LeaseStore)
    | undefined;
  state?: RuntimeState | undefined;
}

/**
 * Derive a deterministic lease file path for a team config. The first 12 chars
 * of the config sha256 keep multiple team daemons (e.g. one for staging, one
 * for production) from clobbering each other's lease state under the shared
 * `~/.issuepilot/state` directory.
 */
function deriveLeaseFilePath(config: TeamConfig): string {
  return path.join(
    os.homedir(),
    ".issuepilot",
    "state",
    `leases-${config.source.sha256.slice(0, 12)}.json`,
  );
}

type TeamEvent = {
  id: string;
  runId: string;
  type: string;
  message: string;
  [key: string]: unknown;
};

/**
 * Phase 1 team-mode entrypoint: parse the team config, load each enabled
 * project workflow, and bring up the Fastify server with project-aware
 * `/api/state`. No GitLab polling is wired up yet — the goal is to give the
 * dashboard and CLI a stable shell to talk to.
 */
export async function startTeamDaemon(
  options: StartTeamDaemonOptions,
  deps: StartTeamDaemonDeps = {},
): Promise<TeamDaemonHandle> {
  const configPath = path.resolve(options.configPath);
  const loadConfig = deps.loadTeamConfig ?? defaultLoadTeamConfig;
  const createRegistry =
    deps.createProjectRegistry ?? defaultCreateProjectRegistry;
  const createServerImpl = deps.createServer ?? createServer;
  const createLeaseStoreImpl =
    deps.createLeaseStore ?? defaultCreateLeaseStore;

  const config = await loadConfig(configPath);
  const workflowLoader = createWorkflowLoader();
  const registry = await createRegistry(config, workflowLoader);
  const state = deps.state ?? createRuntimeState();
  const eventBus: EventBus<TeamEvent> = createEventBus<TeamEvent>();
  const leaseStore = createLeaseStoreImpl({
    filePath: deriveLeaseFilePath(config),
  });

  const host = options.host ?? config.server.host;
  const port = options.port ?? config.server.port;

  const app = await createServerImpl(
    {
      state,
      eventBus,
      workflowPath: config.source.path,
      gitlabProject: "team",
      handoffLabel: "human-review",
      pollIntervalMs: config.scheduler.pollIntervalMs,
      concurrency: config.scheduler.maxConcurrentRuns,
      // Evaluate runtime/projects on every `/api/state` request so dashboard
      // counters reflect current lease and poll state instead of a snapshot
      // captured at daemon start (V2 review C5/C6).
      runtime: () => ({
        mode: "team",
        maxConcurrentRuns: config.scheduler.maxConcurrentRuns,
        activeLeases: leaseStore.activeCount(),
        projectCount: registry.summaries().length,
      }),
      projects: () => registry.summaries(),
      readEvents: async () => [],
      readLogsTail: async () => [],
    },
    { host, port },
  );

  const address = app.server.address();
  const actualPort =
    address && typeof address === "object" ? address.port : port;

  let stopped: Promise<void> | null = null;
  let resolveWait: (() => void) | null = null;
  const waitPromise = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });
  const stop = (): Promise<void> => {
    if (!stopped) {
      stopped = app.close().then(() => {
        resolveWait?.();
      });
    }
    return stopped;
  };

  return {
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    stop,
    async wait() {
      await waitPromise;
    },
  };
}
