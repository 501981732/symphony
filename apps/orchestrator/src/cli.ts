import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Command } from "commander";
import { execaCommand } from "execa";

import {
  authLogin,
  authLogout,
  authStatus,
  type AuthLoginDeps,
  type AuthLoginOptions,
  type AuthLogoutOptions,
  type AuthStatusOptions,
} from "./auth/index.js";
import {
  checkCodexAppServer,
  startDaemon,
  validateWorkflow,
  type DaemonHandle,
} from "./daemon.js";

export interface CliDeps {
  startDaemon?: typeof startDaemon | undefined;
  validateWorkflow?: typeof validateWorkflow | undefined;
  checkCodexAppServer?: typeof checkCodexAppServer | undefined;
  execaCommand?: typeof execaCommand | undefined;
  authLogin?:
    | ((opts: AuthLoginOptions, deps?: AuthLoginDeps) => Promise<unknown>)
    | undefined;
  authStatus?:
    | ((opts: AuthStatusOptions) => Promise<unknown>)
    | undefined;
  authLogout?:
    | ((opts: AuthLogoutOptions) => Promise<unknown>)
    | undefined;
}

function parsePort(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const port = Number(value);
  if (port > 65_535) return null;
  return port;
}

export function buildCli(deps: CliDeps = {}): Command {
  const daemonStarter = deps.startDaemon ?? startDaemon;
  const workflowValidator = deps.validateWorkflow ?? validateWorkflow;
  const codexCheck = deps.checkCodexAppServer ?? checkCodexAppServer;
  const runExecaCommand = deps.execaCommand ?? execaCommand;
  const authLoginImpl = deps.authLogin ?? authLogin;
  const authStatusImpl = deps.authStatus ?? authStatus;
  const authLogoutImpl = deps.authLogout ?? authLogout;

  const program = new Command("issuepilot")
    .description("IssuePilot — AI-driven GitLab issue orchestrator")
    .version("0.0.0");

  program
    .command("run")
    .description("Start the orchestrator daemon")
    .requiredOption("--workflow <path>", "Path to workflow file")
    .option("--port <number>", "HTTP API port", "4738")
    .option(
      "--host <host>",
      "HTTP API bind address (default 127.0.0.1; use 0.0.0.0 for container/remote smoke runs)",
      "127.0.0.1",
    )
    .action(async (opts) => {
      const workflowPath = path.resolve(opts.workflow);
      const port = parsePort(opts.port);
      if (port === null) {
        console.error(`Error: invalid port: ${opts.port}`);
        process.exitCode = 1;
        return;
      }
      const host = typeof opts.host === "string" ? opts.host.trim() : "";
      if (!host) {
        console.error("Error: --host must not be empty");
        process.exitCode = 1;
        return;
      }
      if (!fs.existsSync(workflowPath)) {
        console.error(`Error: workflow file not found: ${workflowPath}`);
        process.exitCode = 1;
        return;
      }
      let handle: DaemonHandle;
      try {
        handle = await daemonStarter({ workflowPath, port, host });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: failed to start daemon: ${message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`IssuePilot daemon ready: ${handle.url}`);
      await handle.wait();
    });

  program
    .command("validate")
    .description("Validate workflow config and GitLab connectivity")
    .requiredOption("--workflow <path>", "Path to workflow file")
    .action(async (opts) => {
      const workflowPath = path.resolve(opts.workflow);
      if (!fs.existsSync(workflowPath)) {
        console.error(`Error: workflow file not found: ${workflowPath}`);
        process.exitCode = 1;
        return;
      }
      try {
        const workflow = await workflowValidator(workflowPath);
        console.log(`Workflow loaded: ${workflow.source.path}`);
        console.log(`GitLab project: ${workflow.tracker.projectId}`);
        console.log("Validation passed.");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Validation failed: ${message}`);
        process.exitCode = 1;
      }
    });

  program
    .command("doctor")
    .description("Check system prerequisites")
    .action(async () => {
      const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

      const nodeVersion = process.version;
      const major = parseInt(nodeVersion.slice(1), 10);
      checks.push({
        name: "Node.js",
        ok: major >= 22,
        detail: `${nodeVersion} (require >=22)`,
      });

      try {
        const { stdout } = await runExecaCommand("git --version");
        checks.push({ name: "git", ok: true, detail: stdout.trim() });
      } catch {
        checks.push({ name: "git", ok: false, detail: "not found" });
      }

      try {
        const detail = await codexCheck();
        checks.push({ name: "codex app-server", ok: true, detail });
      } catch {
        checks.push({
          name: "codex app-server",
          ok: false,
          detail: "not found",
        });
      }

      const stateDir = path.join(os.homedir(), ".issuepilot", "state");
      try {
        fs.mkdirSync(stateDir, { recursive: true });
        const testFile = path.join(stateDir, ".write-test");
        fs.writeFileSync(testFile, "test");
        fs.unlinkSync(testFile);
        checks.push({ name: "state dir", ok: true, detail: stateDir });
      } catch {
        checks.push({
          name: "state dir",
          ok: false,
          detail: `cannot write to ${stateDir}`,
        });
      }

      const allOk = checks.every((c) => c.ok);
      for (const c of checks) {
        const icon = c.ok ? "OK" : "FAIL";
        console.log(`[${icon}] ${c.name}: ${c.detail}`);
      }

      if (!allOk) {
        process.exitCode = 1;
      }
    });

  const authCommand = program
    .command("auth")
    .description(
      "Manage GitLab credentials via OAuth 2.0 Device Authorization Grant",
    );

  authCommand
    .command("login")
    .description("Run the OAuth Device Flow and persist the resulting token")
    .requiredOption(
      "--hostname <host>",
      "GitLab hostname, e.g. gitlab.example.com",
    )
    .option(
      "--scope <scopes>",
      "Space-separated OAuth scopes (default: api read_repository write_repository)",
    )
    .option("--client-id <id>", "Override OAuth client_id (default: issuepilot-cli)")
    .option(
      "--base-url <url>",
      "Override base URL (default: https://<hostname>)",
    )
    .action(async (opts) => {
      const loginOpts: AuthLoginOptions = { hostname: String(opts.hostname) };
      if (typeof opts.scope === "string" && opts.scope.length > 0) {
        loginOpts.scope = opts.scope.split(/\s+/).filter(Boolean);
      }
      if (typeof opts.clientId === "string" && opts.clientId.length > 0) {
        loginOpts.clientId = opts.clientId;
      }
      if (typeof opts.baseUrl === "string" && opts.baseUrl.length > 0) {
        loginOpts.baseUrl = opts.baseUrl;
      }
      try {
        await authLoginImpl(loginOpts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`auth login failed: ${message}`);
        process.exitCode = 1;
      }
    });

  authCommand
    .command("status")
    .description("Show stored credentials and their token expiry")
    .option("--hostname <host>", "Filter by hostname")
    .action(async (opts) => {
      const statusOpts: AuthStatusOptions = {};
      if (typeof opts.hostname === "string" && opts.hostname.length > 0) {
        statusOpts.hostname = opts.hostname;
      }
      try {
        await authStatusImpl(statusOpts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`auth status failed: ${message}`);
        process.exitCode = 1;
      }
    });

  authCommand
    .command("logout")
    .description("Remove stored credentials")
    .option("--hostname <host>", "Hostname to remove")
    .option("--all", "Wipe credentials for every host")
    .action(async (opts) => {
      const logoutOpts: AuthLogoutOptions = {};
      if (typeof opts.hostname === "string" && opts.hostname.length > 0) {
        logoutOpts.hostname = opts.hostname;
      }
      if (opts.all === true) logoutOpts.all = true;
      try {
        await authLogoutImpl(logoutOpts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`auth logout failed: ${message}`);
        process.exitCode = 1;
      }
    });

  return program;
}
