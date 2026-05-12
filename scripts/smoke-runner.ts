/**
 * Smoke runner helpers.
 *
 * These helpers are extracted from `scripts/smoke.ts` so they can be unit
 * tested without booting the orchestrator. The actual smoke CLI lives in
 * `scripts/smoke.ts` and spawns the orchestrator daemon as a child process
 * via `pnpm --filter @issuepilot/orchestrator` before calling the helpers
 * below to wait for readiness and emit a banner.
 */

export type ServiceStatus = "ready" | "draining" | "stopped";

export interface ServiceState {
  service: {
    status: ServiceStatus | string;
    workflowPath?: string | undefined;
    gitlabProject?: string | undefined;
    pollIntervalMs?: number | undefined;
    concurrency?: number | undefined;
    lastConfigReloadAt?: string | undefined;
    lastPollAt?: string | undefined;
  };
  summary?: Record<string, unknown> | undefined;
}

export interface SmokeOptions {
  workflowPath: string;
  port: number;
  dashboardUrl: string;
  readinessTimeoutMs: number;
  apiHost: string;
}

export type ParseResult =
  | { ok: true; options: SmokeOptions }
  | { ok: false; error: string };

const DEFAULT_PORT = 4738;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_DASHBOARD = "http://localhost:3000";
const DEFAULT_READINESS_TIMEOUT_MS = 15_000;

function takeValue(
  argv: string[],
  index: number,
  flag: string,
): { value: string; next: number } | { error: string } {
  const raw = argv[index + 1];
  if (raw === undefined || raw.startsWith("--")) {
    return { error: `Flag ${flag} requires a value.` };
  }
  return { value: raw, next: index + 2 };
}

export function parseSmokeArgs(argv: readonly string[]): ParseResult {
  let workflowPath: string | undefined;
  let port: number = DEFAULT_PORT;
  let dashboardUrl: string = DEFAULT_DASHBOARD;
  let apiHost: string = DEFAULT_HOST;
  let readinessTimeoutMs: number = DEFAULT_READINESS_TIMEOUT_MS;

  const args = [...argv];
  let i = 0;
  while (i < args.length) {
    const flag = args[i];
    switch (flag) {
      case "--workflow": {
        const taken = takeValue(args, i, flag);
        if ("error" in taken) return { ok: false, error: taken.error };
        workflowPath = taken.value;
        i = taken.next;
        break;
      }
      case "--port": {
        const taken = takeValue(args, i, flag);
        if ("error" in taken) return { ok: false, error: taken.error };
        if (!/^[1-9]\d*$/.test(taken.value) || Number(taken.value) > 65_535) {
          return { ok: false, error: `Invalid port: ${taken.value}` };
        }
        port = Number(taken.value);
        i = taken.next;
        break;
      }
      case "--dashboard-url": {
        const taken = takeValue(args, i, flag);
        if ("error" in taken) return { ok: false, error: taken.error };
        dashboardUrl = taken.value;
        i = taken.next;
        break;
      }
      case "--host": {
        const taken = takeValue(args, i, flag);
        if ("error" in taken) return { ok: false, error: taken.error };
        apiHost = taken.value;
        i = taken.next;
        break;
      }
      case "--readiness-timeout-ms": {
        const taken = takeValue(args, i, flag);
        if ("error" in taken) return { ok: false, error: taken.error };
        if (!/^[1-9]\d*$/.test(taken.value)) {
          return { ok: false, error: `Invalid timeout: ${taken.value}` };
        }
        readinessTimeoutMs = Number(taken.value);
        i = taken.next;
        break;
      }
      default:
        return { ok: false, error: `Unknown flag: ${flag}` };
    }
  }

  if (!workflowPath) {
    return {
      ok: false,
      error:
        "--workflow <path> is required. Point it at your local .agents/workflow.md.",
    };
  }

  return {
    ok: true,
    options: {
      workflowPath,
      port,
      dashboardUrl,
      apiHost,
      readinessTimeoutMs,
    },
  };
}

export interface PollOptions {
  timeoutMs: number;
  intervalMs: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export async function pollUntilReady(
  url: string,
  opts: PollOptions,
): Promise<ServiceState> {
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + opts.timeoutMs;
  let lastError: string | undefined;

  while (now() < deadline) {
    try {
      const res = await fetchImpl(url);
      if (res.ok) {
        const body = (await res.json()) as ServiceState;
        const status = body?.service?.status;
        if (status === "ready") {
          return body;
        }
        lastError = `service.status = ${status ?? "<missing>"}`;
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
  }

  throw new Error(
    `Daemon did not report ready within ${opts.timeoutMs}ms (last error: ${
      lastError ?? "unknown"
    }).`,
  );
}

export interface BannerInput {
  apiUrl: string;
  dashboardUrl: string;
  state: ServiceState;
}

export function formatReadyBanner(input: BannerInput): string {
  const svc = input.state.service;
  const lines: string[] = [];
  lines.push("");
  lines.push("======================================================");
  lines.push(" IssuePilot daemon ready");
  lines.push("------------------------------------------------------");
  lines.push(` API:        ${input.apiUrl}`);
  lines.push(` Dashboard:  ${input.dashboardUrl}`);
  if (svc.workflowPath) lines.push(` Workflow:   ${svc.workflowPath}`);
  if (svc.gitlabProject) lines.push(` Project:    ${svc.gitlabProject}`);
  if (svc.pollIntervalMs !== undefined) {
    lines.push(` Poll every: ${svc.pollIntervalMs}ms`);
  }
  if (svc.concurrency !== undefined) {
    lines.push(` Concurrency:${svc.concurrency}`);
  }
  lines.push("------------------------------------------------------");
  lines.push(
    " Walk through the §18.3 smoke checklist now. Press Ctrl+C to stop.",
  );
  lines.push("======================================================");
  lines.push("");
  return lines.join("\n");
}
