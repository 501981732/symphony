import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface PackageJson {
  version: string;
}

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const rootPackage = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
) as PackageJson;
const versionFile = path.join(
  root,
  "apps",
  "orchestrator",
  "src",
  "version.ts",
);
const expected = `export const PACKAGE_VERSION = ${JSON.stringify(
  rootPackage.version,
)};\n`;
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  const actual = await fs.readFile(versionFile, "utf8");
  if (actual !== expected) {
    throw new Error(
      `${path.relative(root, versionFile)} is stale. Run pnpm version:generate.`,
    );
  }
} else {
  await fs.writeFile(versionFile, expected);
}
