import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const rootPackage = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
) as { version: string };
const tarball = path.join(
  root,
  "dist",
  "release",
  `issuepilot-${rootPackage.version}.tgz`,
);
const fixtureWorkflow = path.join(
  root,
  "scripts",
  "release",
  "fixtures",
  "WORKFLOW.md",
);

function binPath(prefix: string): string {
  return process.platform === "win32"
    ? path.join(prefix, "issuepilot.cmd")
    : path.join(prefix, "bin", "issuepilot");
}

async function runInstalled(
  issuepilotBin: string,
  args: string[],
): Promise<string> {
  const result = await execa(issuepilotBin, args, {
    cwd: os.tmpdir(),
    env: { ...process.env },
  });
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(250);
  }

  const message =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`dashboard did not become reachable at ${url}: ${message}`);
}

async function assertDashboardStarts(issuepilotBin: string): Promise<void> {
  const port = 43_000 + Math.floor(Math.random() * 1000);
  const child = execa(
    issuepilotBin,
    ["dashboard", "--port", String(port), "--api-url", "http://127.0.0.1:4738"],
    {
      cwd: os.tmpdir(),
      env: { ...process.env },
      reject: false,
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  try {
    await waitForHttp(`http://127.0.0.1:${port}`);
  } finally {
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await child;
    } finally {
      clearTimeout(killTimer);
    }
  }
}

async function writeRunSmokeWorkflow(tmpDir: string): Promise<string> {
  const workflowPath = path.join(tmpDir, "WORKFLOW.run.md");
  const workspaceRoot = path.join(tmpDir, "workspaces");
  const repoCacheRoot = path.join(tmpDir, "repos");
  await fs.writeFile(
    workflowPath,
    `---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
  token_env: "GITLAB_TOKEN"

workspace:
  root: "${workspaceRoot}"
  strategy: worktree
  repo_cache_root: "${repoCacheRoot}"

git:
  repo_url: "git@gitlab.example.com:group/project.git"
  base_branch: main
  branch_prefix: ai

agent:
  runner: codex-app-server
  max_concurrent_agents: 1
  max_turns: 3
  max_attempts: 1
  retry_backoff_ms: 1000

codex:
  command: "codex app-server"
  approval_policy: never
  thread_sandbox: workspace-write
  turn_timeout_ms: 60000
  turn_sandbox_policy:
    type: workspaceWrite

poll_interval_ms: 60000
---

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
URL: {{ issue.url }}

{{ issue.description }}
`,
  );
  return workflowPath;
}

async function assertRunStarts(
  issuepilotBin: string,
  tmpDir: string,
): Promise<void> {
  const workflowPath = await writeRunSmokeWorkflow(tmpDir);
  const port = 44_000 + Math.floor(Math.random() * 1000);
  const child = execa(
    issuepilotBin,
    [
      "run",
      "--workflow",
      workflowPath,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
    ],
    {
      cwd: os.tmpdir(),
      env: { ...process.env, GITLAB_TOKEN: "issuepilot-install-smoke-token" },
      reject: false,
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  try {
    await waitForHttp(`http://127.0.0.1:${port}/api/state`);
  } finally {
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await child;
    } finally {
      clearTimeout(killTimer);
    }
  }
}

async function main(): Promise<void> {
  await execa("pnpm", ["release:pack"], { cwd: root, stdio: "inherit" });

  const tmpPrefix = await fs.mkdtemp(
    path.join(os.tmpdir(), "issuepilot-install-"),
  );
  const npmCache = path.join(tmpPrefix, "npm-cache");
  await execa(
    "npm",
    ["install", "-g", "--prefix", tmpPrefix, "--cache", npmCache, tarball],
    { cwd: root, stdio: "inherit" },
  );

  const issuepilotBin = binPath(tmpPrefix);
  const version = await runInstalled(issuepilotBin, ["--version"]);
  if (!version.includes(rootPackage.version)) {
    throw new Error(
      `installed issuepilot version mismatch: expected ${rootPackage.version}, got ${version}`,
    );
  }

  await runInstalled(issuepilotBin, ["doctor"]);
  await runInstalled(issuepilotBin, [
    "validate",
    "--workflow",
    fixtureWorkflow,
  ]);
  await runInstalled(issuepilotBin, ["dashboard", "--help"]);
  await assertDashboardStarts(issuepilotBin);
  await assertRunStarts(issuepilotBin, tmpPrefix);

  console.log(`Installed IssuePilot smoke passed: ${issuepilotBin}`);
}

await main();
