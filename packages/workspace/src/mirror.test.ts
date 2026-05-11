import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execaSync } from "execa";
import { ensureMirror } from "./mirror.js";

describe("ensureMirror", () => {
  let tmpDir: string;
  let originRepoPath: string;
  let repoCacheRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-test-"));
    originRepoPath = path.join(tmpDir, "origin");
    repoCacheRoot = path.join(tmpDir, "cache");

    fs.mkdirSync(originRepoPath);
    execaSync("git", ["init", "--bare", "--initial-branch=main"], {
      cwd: originRepoPath,
    });

    const workDir = path.join(tmpDir, "work");
    fs.mkdirSync(workDir);
    execaSync("git", ["clone", originRepoPath, workDir]);
    execaSync("git", ["config", "user.email", "test@test.com"], {
      cwd: workDir,
    });
    execaSync("git", ["config", "user.name", "Test"], { cwd: workDir });
    fs.writeFileSync(path.join(workDir, "README.md"), "# Test\n");
    execaSync("git", ["add", "."], { cwd: workDir });
    execaSync("git", ["commit", "-m", "init"], { cwd: workDir });
    execaSync("git", ["push", "-u", "origin", "main"], { cwd: workDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clones a bare mirror on first call", async () => {
    const result = await ensureMirror({
      repoUrl: `file://${originRepoPath}`,
      projectSlug: "test-project",
      repoCacheRoot,
    });

    expect(result.mirrorPath).toBe(
      path.join(repoCacheRoot, "test-project.git"),
    );
    expect(fs.existsSync(result.mirrorPath)).toBe(true);

    const headRef = execaSync("git", ["--git-dir", result.mirrorPath, "rev-parse", "HEAD"]);
    expect(headRef.exitCode).toBe(0);
    expect(headRef.stdout.trim()).toHaveLength(40);
  });

  it("fetches on second call (reuse existing mirror)", async () => {
    const first = await ensureMirror({
      repoUrl: `file://${originRepoPath}`,
      projectSlug: "test-project",
      repoCacheRoot,
    });

    const second = await ensureMirror({
      repoUrl: `file://${originRepoPath}`,
      projectSlug: "test-project",
      repoCacheRoot,
    });

    expect(second.mirrorPath).toBe(first.mirrorPath);
  });

  it("picks up new commits after fetch", async () => {
    await ensureMirror({
      repoUrl: `file://${originRepoPath}`,
      projectSlug: "test-project",
      repoCacheRoot,
    });

    const workDir = path.join(tmpDir, "work2");
    execaSync("git", ["clone", originRepoPath, workDir]);
    execaSync("git", ["config", "user.email", "test@test.com"], {
      cwd: workDir,
    });
    execaSync("git", ["config", "user.name", "Test"], { cwd: workDir });
    fs.writeFileSync(path.join(workDir, "new-file.txt"), "content");
    execaSync("git", ["add", "."], { cwd: workDir });
    execaSync("git", ["commit", "-m", "second commit"], { cwd: workDir });
    execaSync("git", ["push", "origin", "main"], { cwd: workDir });

    const result = await ensureMirror({
      repoUrl: `file://${originRepoPath}`,
      projectSlug: "test-project",
      repoCacheRoot,
    });

    const log = execaSync("git", [
      "--git-dir",
      result.mirrorPath,
      "log",
      "--oneline",
    ]);
    expect(log.stdout).toContain("second commit");
  });

  it("throws on invalid repo URL", async () => {
    await expect(
      ensureMirror({
        repoUrl: "file:///nonexistent/repo",
        projectSlug: "bad",
        repoCacheRoot,
      }),
    ).rejects.toThrow();
  });
});
