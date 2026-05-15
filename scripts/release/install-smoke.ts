import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
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

async function main(): Promise<void> {
  await execa("pnpm", ["release:pack"], { cwd: root, stdio: "inherit" });

  const tmpPrefix = await fs.mkdtemp(path.join(os.tmpdir(), "issuepilot-install-"));
  const npmCache = path.join(tmpPrefix, "npm-cache");
  await execa(
    "npm",
    [
      "install",
      "-g",
      "--prefix",
      tmpPrefix,
      "--cache",
      npmCache,
      tarball,
    ],
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
  await runInstalled(issuepilotBin, ["validate", "--workflow", fixtureWorkflow]);
  await runInstalled(issuepilotBin, ["dashboard", "--help"]);

  console.log(`Installed IssuePilot smoke passed: ${issuepilotBin}`);
}

await main();
