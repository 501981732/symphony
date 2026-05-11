import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildCli } from "./cli.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("CLI", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("validate fails for missing workflow", async () => {
    const cli = buildCli();
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

    await cli.parseAsync(
      ["validate", "--workflow", "/nonexistent/wf.md"],
      { from: "user" },
    );

    expect(process.exitCode).toBe(1);
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
    );
    mockError.mockRestore();
    process.exitCode = 0;
  });

  it("validate succeeds for existing workflow", async () => {
    const wfPath = path.join(tmpDir, "wf.md");
    fs.writeFileSync(wfPath, "---\ntitle: test\n---\n");

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const cli = buildCli();

    await cli.parseAsync(["validate", "--workflow", wfPath], {
      from: "user",
    });

    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("Validation passed"),
    );
    mockLog.mockRestore();
  });

  it("doctor runs checks", async () => {
    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const cli = buildCli();

    await cli.parseAsync(["doctor"], { from: "user" });

    const output = mockLog.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Node.js");
    expect(output).toContain("git");
    expect(output).toContain("state dir");
    mockLog.mockRestore();
  });

  it("run fails for missing workflow", async () => {
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});
    const cli = buildCli();

    await cli.parseAsync(
      ["run", "--workflow", "/nonexistent/wf.md"],
      { from: "user" },
    );

    expect(process.exitCode).toBe(1);
    mockError.mockRestore();
    process.exitCode = 0;
  });

  it("run starts for valid workflow", async () => {
    const wfPath = path.join(tmpDir, "wf.md");
    fs.writeFileSync(wfPath, "---\ntitle: test\n---\n");

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const cli = buildCli();

    await cli.parseAsync(["run", "--workflow", wfPath], { from: "user" });

    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("daemon starting"),
    );
    mockLog.mockRestore();
  });
});
