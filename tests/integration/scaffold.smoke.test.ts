import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

const root = resolve(__dirname, "..", "..");
const readJson = (rel: string) =>
  JSON.parse(readFileSync(resolve(root, rel), "utf8")) as Record<string, unknown>;

describe("monorepo scaffold smoke", () => {
  it("root package.json declares pnpm@10 packageManager and Node 22 engines", () => {
    const pkg = readJson("package.json");
    expect(pkg.name).toBe("issuepilot");
    expect(pkg.private).toBe(true);
    expect(typeof pkg.packageManager).toBe("string");
    expect(pkg.packageManager as string).toMatch(/^pnpm@10\./);
    expect((pkg.engines as Record<string, string>).node).toBe(">=22 <23");
  });

  it("pnpm-workspace.yaml registers apps/packages/tests", () => {
    const raw = readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8");
    const cfg = YAML.parse(raw) as { packages: string[] };
    expect(cfg.packages).toEqual(
      expect.arrayContaining(["apps/*", "packages/*", "tests/*"]),
    );
  });

  it("turbo.json defines build/test/typecheck/lint/dev tasks", () => {
    const turbo = readJson("turbo.json");
    const tasks = turbo.tasks as Record<string, unknown>;
    for (const name of ["build", "test", "typecheck", "lint", "dev"]) {
      expect(tasks[name]).toBeTruthy();
    }
  });

  it("tsconfig.base.json enables strict + NodeNext + ES2023", () => {
    const tsconfig = readJson("tsconfig.base.json");
    const opts = tsconfig.compilerOptions as Record<string, unknown>;
    expect(opts.strict).toBe(true);
    expect(opts.module).toBe("NodeNext");
    expect(opts.moduleResolution).toBe("NodeNext");
    expect(opts.target).toBe("ES2023");
    expect(opts.composite).toBe(true);
    expect(opts.declaration).toBe(true);
  });

  it(".npmrc forbids loose engines", () => {
    expect(existsSync(resolve(root, ".npmrc"))).toBe(true);
    const npmrc = readFileSync(resolve(root, ".npmrc"), "utf8");
    expect(npmrc).toMatch(/engine-strict\s*=\s*true/);
  });

  it(".gitignore blocks node_modules, dist, .turbo, .next", () => {
    const gi = readFileSync(resolve(root, ".gitignore"), "utf8");
    for (const entry of ["node_modules", "dist", ".turbo", ".next"]) {
      expect(gi).toContain(entry);
    }
  });
});
