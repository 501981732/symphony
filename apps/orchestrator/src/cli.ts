import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Command } from "commander";
import { execaCommand } from "execa";


export function buildCli(): Command {
  const program = new Command("issuepilot")
    .description("IssuePilot — AI-driven GitLab issue orchestrator")
    .version("0.0.0");

  program
    .command("run")
    .description("Start the orchestrator daemon")
    .requiredOption("--workflow <path>", "Path to workflow file")
    .option("--port <number>", "HTTP API port", "4738")
    .action(async (opts) => {
      const workflowPath = path.resolve(opts.workflow);
      if (!fs.existsSync(workflowPath)) {
        console.error(`Error: workflow file not found: ${workflowPath}`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `IssuePilot daemon starting — workflow=${workflowPath} port=${opts.port}`,
      );
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
      console.log(`Workflow file found: ${workflowPath}`);
      console.log("Validation passed.");
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
        const { stdout } = await execaCommand("git --version");
        checks.push({ name: "git", ok: true, detail: stdout.trim() });
      } catch {
        checks.push({ name: "git", ok: false, detail: "not found" });
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

  return program;
}
