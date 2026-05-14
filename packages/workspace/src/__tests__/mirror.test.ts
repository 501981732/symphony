import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execaSync } from "execa";
import { ensureMirror } from "../mirror.js";

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

    const headRef = execaSync("git", [
      "--git-dir",
      result.mirrorPath,
      "rev-parse",
      "HEAD",
    ]);
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
      "refs/remotes/origin/main",
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

  // Regression for the production bug fixed in Phase 8: the bare mirror
  // produced by `git clone --mirror` left `remote.origin.mirror=true` in
  // the local config, which makes any later `git push origin <refspec>`
  // call die with "--mirror cannot be used with refspecs". The fix unsets
  // the flag and installs an explicit fetch refspec; these two assertions
  // pin both invariants in place so future refactors of `ensureMirror`
  // cannot silently regress.
  it("clears remote.origin.mirror and supports refspec push (regression)", async () => {
    const result = await ensureMirror({
      repoUrl: `file://${originRepoPath}`,
      projectSlug: "regression",
      repoCacheRoot,
    });

    const mirrorFlag = execaSync(
      "git",
      [
        "--git-dir",
        result.mirrorPath,
        "config",
        "--get",
        "remote.origin.mirror",
      ],
      { reject: false },
    );
    expect(mirrorFlag.exitCode).not.toBe(0);

    const fetchRefspec = execaSync("git", [
      "--git-dir",
      result.mirrorPath,
      "config",
      "--get",
      "remote.origin.fetch",
    ]);
    expect(fetchRefspec.stdout.trim()).toBe(
      "+refs/heads/*:refs/remotes/origin/*",
    );

    // Set up a worktree off the migrated mirror, mutate it, and push the
    // change back via a refspec. This is the exact code path that used to
    // fail with "--mirror cannot be used with refspecs".
    const worktreeDir = path.join(tmpDir, "worktree");
    fs.mkdirSync(worktreeDir);
    execaSync("git", [
      "--git-dir",
      result.mirrorPath,
      "worktree",
      "add",
      "-B",
      "feature/refspec-push",
      worktreeDir,
      "main",
    ]);
    execaSync("git", ["config", "user.email", "ci@issuepilot.local"], {
      cwd: worktreeDir,
    });
    execaSync("git", ["config", "user.name", "issuepilot-ci"], {
      cwd: worktreeDir,
    });
    fs.writeFileSync(path.join(worktreeDir, "regression.txt"), "fixed\n");
    execaSync("git", ["add", "regression.txt"], { cwd: worktreeDir });
    execaSync("git", ["commit", "-m", "regression: refspec push"], {
      cwd: worktreeDir,
    });
    const push = execaSync("git", ["push", "origin", "feature/refspec-push"], {
      cwd: worktreeDir,
      reject: false,
    });
    expect(push.exitCode).toBe(0);
    expect(push.stderr ?? "").not.toMatch(
      /mirror cannot be used with refspecs/,
    );
  });

  it("fetches while an issue branch is checked out in a worktree", async () => {
    const result = await ensureMirror({
      repoUrl: `file://${originRepoPath}`,
      projectSlug: "checked-out-branch",
      repoCacheRoot,
    });

    const worktreeDir = path.join(tmpDir, "checked-out-worktree");
    fs.mkdirSync(worktreeDir);
    execaSync("git", [
      "--git-dir",
      result.mirrorPath,
      "worktree",
      "add",
      "-B",
      "ai/1-test-1",
      worktreeDir,
      "origin/main",
    ]);
    execaSync("git", ["config", "user.email", "ci@issuepilot.local"], {
      cwd: worktreeDir,
    });
    execaSync("git", ["config", "user.name", "issuepilot-ci"], {
      cwd: worktreeDir,
    });
    fs.writeFileSync(path.join(worktreeDir, "issue.txt"), "done\n");
    execaSync("git", ["add", "issue.txt"], { cwd: worktreeDir });
    execaSync("git", ["commit", "-m", "issue: done"], { cwd: worktreeDir });
    execaSync("git", ["push", "origin", "ai/1-test-1"], {
      cwd: worktreeDir,
    });

    await expect(
      ensureMirror({
        repoUrl: `file://${originRepoPath}`,
        projectSlug: "checked-out-branch",
        repoCacheRoot,
      }),
    ).resolves.toEqual({ mirrorPath: result.mirrorPath });

    const remoteIssueRef = execaSync("git", [
      "--git-dir",
      result.mirrorPath,
      "rev-parse",
      "--verify",
      "refs/remotes/origin/ai/1-test-1",
    ]);
    expect(remoteIssueRef.exitCode).toBe(0);
  });

  // Regression for the upgrade path: an existing cache that was originally
  // created with the old `git clone --mirror` (no flag-strip) must be
  // migrated in place on the next `ensureMirror` call. Without this, users
  // on the previous IssuePilot release would have to manually `rm -rf
  // ~/.issuepilot/repos/<slug>` after upgrading.
  it("migrates a legacy cache that still has remote.origin.mirror=true", async () => {
    // Create a "legacy" cache by cloning with --mirror and leaving the
    // flag in place (i.e. the pre-fix behaviour).
    const mirrorPath = path.join(repoCacheRoot, "legacy.git");
    fs.mkdirSync(repoCacheRoot, { recursive: true });
    execaSync("git", [
      "clone",
      "--mirror",
      `file://${originRepoPath}`,
      mirrorPath,
    ]);

    const beforeFlag = execaSync("git", [
      "--git-dir",
      mirrorPath,
      "config",
      "--get",
      "remote.origin.mirror",
    ]);
    expect(beforeFlag.stdout.trim()).toBe("true");

    await ensureMirror({
      repoUrl: `file://${originRepoPath}`,
      projectSlug: "legacy",
      repoCacheRoot,
    });

    const afterFlag = execaSync(
      "git",
      ["--git-dir", mirrorPath, "config", "--get", "remote.origin.mirror"],
      { reject: false },
    );
    expect(afterFlag.exitCode).not.toBe(0);

    const refspec = execaSync("git", [
      "--git-dir",
      mirrorPath,
      "config",
      "--get",
      "remote.origin.fetch",
    ]);
    expect(refspec.stdout.trim()).toBe("+refs/heads/*:refs/remotes/origin/*");
  });
});
