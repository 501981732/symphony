import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runHook } from "./hooks.js";

describe("runHook", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips when script is undefined", async () => {
    const result = await runHook({
      cwd: tmpDir,
      name: "after_create",
      script: undefined,
      env: {},
    });
    expect(result.skipped).toBe(true);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("skips when script is empty string", async () => {
    const result = await runHook({
      cwd: tmpDir,
      name: "before_run",
      script: "",
      env: {},
    });
    expect(result.skipped).toBe(true);
  });

  it("executes a successful script and captures stdout", async () => {
    const result = await runHook({
      cwd: tmpDir,
      name: "after_create",
      script: 'echo "hello from hook"',
      env: {},
    });
    expect(result.skipped).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello from hook");
  });

  it("throws HookFailedError on non-zero exit", async () => {
    await expect(
      runHook({
        cwd: tmpDir,
        name: "before_run",
        script: "exit 42",
        env: {},
      }),
    ).rejects.toMatchObject({
      name: "HookFailedError",
    });
  });

  it("throws HookFailedError on timeout", async () => {
    await expect(
      runHook({
        cwd: tmpDir,
        name: "after_run",
        script: "sleep 60",
        env: {},
        timeoutMs: 500,
      }),
    ).rejects.toMatchObject({
      name: "HookFailedError",
    });
  }, 10_000);

  it("passes custom env variables to the script", async () => {
    const result = await runHook({
      cwd: tmpDir,
      name: "after_create",
      script: 'echo "$MY_VAR"',
      env: { MY_VAR: "custom-value" },
    });
    expect(result.stdout).toContain("custom-value");
  });

  it("runs in the specified cwd", async () => {
    const result = await runHook({
      cwd: tmpDir,
      name: "after_create",
      script: "pwd",
      env: {},
    });
    const realTmp = fs.realpathSync(tmpDir);
    expect(result.stdout.trim()).toBe(realTmp);
  });
});
