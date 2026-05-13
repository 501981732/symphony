import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execa } from "execa";

const root = resolve(__dirname, "..", "..");

describe("eslint + prettier scaffold", () => {
  it("has eslint.config.mjs at repo root", () => {
    expect(existsSync(resolve(root, "eslint.config.mjs"))).toBe(true);
  });

  it("has .prettierrc with 80-col double-quote trailing-comma 'all'", () => {
    const raw = readFileSync(resolve(root, ".prettierrc"), "utf8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    expect(cfg.printWidth).toBe(80);
    expect(cfg.singleQuote).toBe(false);
    expect(cfg.trailingComma).toBe("all");
  });

  it("has .editorconfig declaring lf + utf-8 + 2-space indent", () => {
    const raw = readFileSync(resolve(root, ".editorconfig"), "utf8");
    expect(raw).toMatch(/charset\s*=\s*utf-8/);
    expect(raw).toMatch(/end_of_line\s*=\s*lf/);
    expect(raw).toMatch(/indent_size\s*=\s*2/);
  });

  it("root tsconfig.json references every emitting workspace", () => {
    const raw = readFileSync(resolve(root, "tsconfig.json"), "utf8");
    const cfg = JSON.parse(raw) as {
      files?: unknown[];
      references?: Array<{ path: string }>;
    };
    expect(cfg.files).toEqual([]);
    const paths = (cfg.references ?? []).map((r) => r.path);
    for (const expected of [
      "./packages/core",
      "./packages/workflow",
      "./packages/tracker-gitlab",
      "./packages/workspace",
      "./packages/runner-codex-app-server",
      "./packages/observability",
      "./packages/shared-contracts",
      "./apps/orchestrator",
    ]) {
      expect(paths).toContain(expected);
    }
  });

  it("eslint runs across packages/apps with zero warnings", async () => {
    const result = await execa(
      "pnpm",
      [
        "exec",
        "eslint",
        "--max-warnings",
        "0",
        "packages",
        "apps",
        "tests",
        "scripts",
      ],
      { cwd: root, reject: false },
    );
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.toLowerCase()).not.toMatch(/\berror\b/);
  });
}, 60_000);
