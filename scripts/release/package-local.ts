import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

interface PackageJson {
  name: string;
  version: string;
  type?: string;
  main?: string;
  types?: string;
  bin?: Record<string, string>;
  exports?: unknown;
  files?: string[];
  dependencies?: Record<string, string>;
  bundledDependencies?: string[];
  private?: boolean;
  description?: string;
  license?: string;
  engines?: Record<string, string>;
}

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const releaseDir = path.join(root, "dist", "release");
const stagingDir = path.join(releaseDir, "package");
const version = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
).version as string;

const workspacePackages = [
  "packages/credentials",
  "packages/observability",
  "packages/runner-codex-app-server",
  "packages/shared-contracts",
  "packages/tracker-gitlab",
  "packages/workflow",
  "packages/workspace",
];

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(packageDir: string): Promise<PackageJson> {
  return JSON.parse(
    await fs.readFile(path.join(packageDir, "package.json"), "utf8"),
  ) as PackageJson;
}

async function copyDir(source: string, target: string): Promise<void> {
  await fs.cp(source, target, { recursive: true, force: true });
}

function mergeExternalDependencies(
  target: Record<string, string>,
  deps: Record<string, string> | undefined,
): void {
  for (const [name, range] of Object.entries(deps ?? {})) {
    if (name.startsWith("@issuepilot/")) continue;
    target[name] = range;
  }
}

function packageNameToNodeModulesPath(name: string): string {
  const [scope, pkg] = name.split("/");
  if (!scope || !pkg) throw new Error(`Expected scoped package name: ${name}`);
  return path.join(stagingDir, "node_modules", scope, pkg);
}

async function writeBundledWorkspacePackage(
  packageDir: string,
): Promise<string> {
  const pkg = await readPackageJson(packageDir);
  const target = packageNameToNodeModulesPath(pkg.name);
  await fs.mkdir(target, { recursive: true });
  await copyDir(path.join(packageDir, "dist"), path.join(target, "dist"));
  const bundledPkg: PackageJson = {
    name: pkg.name,
    version,
    dependencies: Object.fromEntries(
      Object.entries(pkg.dependencies ?? {}).map(([name, range]) => [
        name,
        name.startsWith("@issuepilot/") ? version : range,
      ]),
    ),
  };
  if (pkg.type !== undefined) bundledPkg.type = pkg.type;
  if (pkg.main !== undefined) bundledPkg.main = pkg.main;
  if (pkg.types !== undefined) bundledPkg.types = pkg.types;
  if (pkg.exports !== undefined) bundledPkg.exports = pkg.exports;
  await fs.writeFile(
    path.join(target, "package.json"),
    `${JSON.stringify(bundledPkg, null, 2)}\n`,
  );
  return pkg.name;
}

async function copyDashboard(): Promise<void> {
  const dashboardRoot = path.join(root, "apps", "dashboard");
  const standaloneApp = path.join(
    dashboardRoot,
    ".next",
    "standalone",
    "apps",
    "dashboard",
  );
  if (!(await pathExists(path.join(standaloneApp, "server.js")))) {
    throw new Error(
      "Dashboard standalone server not found. Run `pnpm --filter @issuepilot/dashboard build` first.",
    );
  }

  const dashboardTarget = path.join(stagingDir, "dist", "dashboard");
  await copyDir(standaloneApp, dashboardTarget);

  const staticSource = path.join(dashboardRoot, ".next", "static");
  if (await pathExists(staticSource)) {
    await copyDir(staticSource, path.join(dashboardTarget, ".next", "static"));
  }

  const publicSource = path.join(dashboardRoot, "public");
  if (await pathExists(publicSource)) {
    await copyDir(publicSource, path.join(dashboardTarget, "public"));
  }
}

async function main(): Promise<void> {
  await fs.rm(releaseDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });

  await execa("pnpm", ["-w", "turbo", "run", "build"], {
    cwd: root,
    stdio: "inherit",
  });

  const orchestratorRoot = path.join(root, "apps", "orchestrator");
  const orchestratorPkg = await readPackageJson(orchestratorRoot);
  const dependencies: Record<string, string> = {};
  mergeExternalDependencies(dependencies, orchestratorPkg.dependencies);
  for (const relativePackage of workspacePackages) {
    const packageDir = path.join(root, relativePackage);
    const pkg = await readPackageJson(packageDir);
    mergeExternalDependencies(dependencies, pkg.dependencies);
  }
  const dashboardPkg = await readPackageJson(
    path.join(root, "apps", "dashboard"),
  );
  mergeExternalDependencies(dependencies, dashboardPkg.dependencies);

  await copyDir(
    path.join(orchestratorRoot, "dist"),
    path.join(stagingDir, "dist"),
  );
  await fs.chmod(path.join(stagingDir, "dist", "bin.js"), 0o755);

  const dependencyInstallPkg: PackageJson = {
    name: "issuepilot-release-staging",
    version,
    private: true,
    type: "module",
    dependencies,
  };
  await fs.writeFile(
    path.join(stagingDir, "package.json"),
    `${JSON.stringify(dependencyInstallPkg, null, 2)}\n`,
  );
  await execa("npm", ["install", "--omit=dev", "--ignore-scripts"], {
    cwd: stagingDir,
    stdio: "inherit",
  });

  const bundledDependencies: string[] = [];
  for (const relativePackage of workspacePackages) {
    const packageDir = path.join(root, relativePackage);
    const bundledName = await writeBundledWorkspacePackage(packageDir);
    dependencies[bundledName] = version;
    bundledDependencies.push(bundledName);
  }

  await copyDashboard();

  const releasePkg: PackageJson = {
    name: "issuepilot",
    version,
    private: false,
    type: "module",
    description: "IssuePilot local GitLab issue driven Codex orchestrator.",
    license: "Apache-2.0",
    engines: { node: ">=22 <23" },
    bin: { issuepilot: "./dist/bin.js" },
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    files: ["dist"],
    dependencies,
    bundledDependencies: Object.keys(dependencies),
  };
  await fs.writeFile(
    path.join(stagingDir, "package.json"),
    `${JSON.stringify(releasePkg, null, 2)}\n`,
  );

  await execa("npm", ["pack", "--pack-destination", releaseDir], {
    cwd: stagingDir,
    stdio: "inherit",
  });

  console.log(path.join(releaseDir, `issuepilot-${version}.tgz`));
}

await main();
