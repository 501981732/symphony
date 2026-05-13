import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupOnFailure } from "../cleanup.js";

describe("cleanupOnFailure", () => {
  let tmpDir: string;
  let workspacePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-test-"));
    workspacePath = path.join(tmpDir, "ws");
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(path.join(workspacePath, "file.txt"), "keep me");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does NOT delete workspace files", async () => {
    await cleanupOnFailure({ workspacePath });
    expect(fs.existsSync(path.join(workspacePath, "file.txt"))).toBe(true);
  });

  it("creates .issuepilot/ marker directory", async () => {
    await cleanupOnFailure({ workspacePath });
    const markerDir = path.join(workspacePath, ".issuepilot");
    expect(fs.existsSync(markerDir)).toBe(true);
  });

  it("writes a failed-at-<iso> marker file with context", async () => {
    await cleanupOnFailure({
      workspacePath,
      context: { error: "something broke", attempt: 2 },
    });
    const markerDir = path.join(workspacePath, ".issuepilot");
    const files = fs.readdirSync(markerDir);
    const markers = files.filter((f) => f.startsWith("failed-at-"));
    expect(markers.length).toBe(1);

    const content = fs.readFileSync(
      path.join(markerDir, markers[0]!),
      "utf-8",
    );
    expect(content).toContain("something broke");
    expect(content).toContain("attempt");
  });

  it("can be called multiple times (creates multiple markers)", async () => {
    await cleanupOnFailure({ workspacePath });
    await new Promise((r) => setTimeout(r, 10));
    await cleanupOnFailure({ workspacePath });

    const files = fs.readdirSync(path.join(workspacePath, ".issuepilot"));
    const markers = files.filter((f) => f.startsWith("failed-at-"));
    expect(markers.length).toBeGreaterThanOrEqual(2);
  });
});
