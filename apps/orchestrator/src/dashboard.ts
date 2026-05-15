import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

export interface DashboardOptions {
  port: number;
  host: string;
  apiUrl: string;
}

export interface DashboardHandle {
  wait(): Promise<unknown>;
}

export interface StartDashboardDeps {
  execa?: typeof execa | undefined;
  cwd?: string | undefined;
}

function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function resolvePackagedDashboardServer(): string | null {
  const candidate = path.resolve(moduleDir(), "dashboard", "server.js");
  return fs.existsSync(candidate) ? candidate : null;
}

function resolveSourceDashboardCwd(cwd: string): string | null {
  const candidate = path.resolve(cwd, "apps", "dashboard");
  return fs.existsSync(path.join(candidate, "package.json")) ? candidate : null;
}

export async function startDashboard(
  opts: DashboardOptions,
  deps: StartDashboardDeps = {},
): Promise<DashboardHandle> {
  const runExeca = deps.execa ?? execa;
  const env = {
    ...process.env,
    PORT: String(opts.port),
    HOSTNAME: opts.host,
    ISSUEPILOT_API_URL: opts.apiUrl,
    NEXT_PUBLIC_API_BASE: opts.apiUrl,
  };

  const packagedServer = resolvePackagedDashboardServer();
  if (packagedServer) {
    const child = runExeca("node", [packagedServer], {
      env,
      stdio: "inherit",
    });
    return { wait: () => child };
  }

  const dashboardCwd = resolveSourceDashboardCwd(deps.cwd ?? process.cwd());
  if (dashboardCwd) {
    const child = runExeca(
      "pnpm",
      ["--filter", "@issuepilot/dashboard", "start"],
      {
        cwd: path.resolve(dashboardCwd, "..", ".."),
        env,
        stdio: "inherit",
      },
    );
    return { wait: () => child };
  }

  throw new Error(
    "packaged dashboard server not found and source checkout fallback is unavailable",
  );
}
