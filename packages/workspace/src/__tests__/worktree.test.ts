import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execaSync } from "execa";
import { ensureMirror } from "../mirror.js";
import { ensureWorktree } from "../worktree.js";

function setupOriginAndMirror(tmpDir: string) {
  const originPath = path.join(tmpDir, "origin");
  const mirrorPath = path.join(tmpDir, "mirror.git");

  fs.mkdirSync(originPath);
  execaSync("git", ["init", "--bare", "--initial-branch=main"], {
    cwd: originPath,
  });

  const workDir = path.join(tmpDir, "seed-work");
  fs.mkdirSync(workDir);
  execaSync("git", ["clone", originPath, workDir]);
  execaSync("git", ["config", "user.email", "test@test.com"], {
    cwd: workDir,
  });
  execaSync("git", ["config", "user.name", "Test"], { cwd: workDir });
  fs.writeFileSync(path.join(workDir, "README.md"), "# Test\n");
  execaSync("git", ["add", "."], { cwd: workDir });
  execaSync("git", ["commit", "-m", "init"], { cwd: workDir });
  execaSync("git", ["push", "-u", "origin", "main"], { cwd: workDir });

  execaSync("git", ["clone", "--mirror", `file://${originPath}`, mirrorPath]);

  return { originPath, mirrorPath };
}

describe("ensureWorktree", () => {
  let tmpDir: string;
  let mirrorPath: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-test-"));
    const setup = setupOriginAndMirror(tmpDir);
    mirrorPath = setup.mirrorPath;
    workspaceRoot = path.join(tmpDir, "workspaces");
    fs.mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a new worktree on first call (reused=false)", async () => {
    const result = await ensureWorktree({
      mirrorPath,
      projectSlug: "myproject",
      issueIid: 42,
      titleSlug: "fix-login",
      baseBranch: "main",
      branchPrefix: "ai",
      workspaceRoot,
    });

    expect(result.reused).toBe(false);
    expect(result.branch).toBe("ai/42-fix-login");
    expect(fs.existsSync(result.workspacePath)).toBe(true);

    const readme = path.join(result.workspacePath, "README.md");
    expect(fs.existsSync(readme)).toBe(true);
  });

  it("reports available branches when the configured base branch is missing", async () => {
    await expect(
      ensureWorktree({
        mirrorPath,
        projectSlug: "myproject",
        issueIid: 42,
        titleSlug: "fix-login",
        baseBranch: "develop",
        branchPrefix: "ai",
        workspaceRoot,
      }),
    ).rejects.toMatchObject({
      name: "WorkspaceBaseBranchError",
      message: expect.stringContaining("Available branches: main"),
    });
  });

  it("creates worktrees from the remote-tracking base branch after mirror migration", async () => {
    const repoCacheRoot = path.join(tmpDir, "cache");
    const { mirrorPath: migratedMirrorPath } = await ensureMirror({
      repoUrl: `file://${path.join(tmpDir, "origin")}`,
      projectSlug: "remote-base",
      repoCacheRoot,
    });

    const staleLocalHead = execaSync("git", [
      "--git-dir",
      migratedMirrorPath,
      "rev-parse",
      "refs/heads/main",
    ]).stdout.trim();

    const workDir = path.join(tmpDir, "advance-origin");
    execaSync("git", ["clone", path.join(tmpDir, "origin"), workDir]);
    execaSync("git", ["config", "user.email", "test@test.com"], {
      cwd: workDir,
    });
    execaSync("git", ["config", "user.name", "Test"], { cwd: workDir });
    fs.writeFileSync(path.join(workDir, "new-base.txt"), "new base\n");
    execaSync("git", ["add", "new-base.txt"], { cwd: workDir });
    execaSync("git", ["commit", "-m", "advance base"], { cwd: workDir });
    execaSync("git", ["push", "origin", "main"], { cwd: workDir });

    await ensureMirror({
      repoUrl: `file://${path.join(tmpDir, "origin")}`,
      projectSlug: "remote-base",
      repoCacheRoot,
    });

    const remoteHead = execaSync("git", [
      "--git-dir",
      migratedMirrorPath,
      "rev-parse",
      "refs/remotes/origin/main",
    ]).stdout.trim();
    expect(remoteHead).not.toBe(staleLocalHead);

    const result = await ensureWorktree({
      mirrorPath: migratedMirrorPath,
      projectSlug: "myproject",
      issueIid: 43,
      titleSlug: "remote-base",
      baseBranch: "main",
      branchPrefix: "ai",
      workspaceRoot,
    });

    const worktreeHead = execaSync("git", ["rev-parse", "HEAD"], {
      cwd: result.workspacePath,
    }).stdout.trim();
    expect(worktreeHead).toBe(remoteHead);
  });

  it("rejects stale local base branches after mirror migration", async () => {
    const repoCacheRoot = path.join(tmpDir, "cache-stale");
    const { mirrorPath: migratedMirrorPath } = await ensureMirror({
      repoUrl: `file://${path.join(tmpDir, "origin")}`,
      projectSlug: "stale-base",
      repoCacheRoot,
    });

    execaSync("git", [
      "--git-dir",
      migratedMirrorPath,
      "branch",
      "stale-local-base",
      "refs/heads/main",
    ]);

    await expect(
      ensureWorktree({
        mirrorPath: migratedMirrorPath,
        projectSlug: "myproject",
        issueIid: 44,
        titleSlug: "stale-base",
        baseBranch: "stale-local-base",
        branchPrefix: "ai",
        workspaceRoot,
      }),
    ).rejects.toMatchObject({
      name: "WorkspaceBaseBranchError",
      message: expect.stringContaining("Available branches: main"),
    });
  });

  it("reuses an existing clean worktree (reused=true)", async () => {
    const first = await ensureWorktree({
      mirrorPath,
      projectSlug: "myproject",
      issueIid: 42,
      titleSlug: "fix-login",
      baseBranch: "main",
      branchPrefix: "ai",
      workspaceRoot,
    });

    const second = await ensureWorktree({
      mirrorPath,
      projectSlug: "myproject",
      issueIid: 42,
      titleSlug: "fix-login",
      baseBranch: "main",
      branchPrefix: "ai",
      workspaceRoot,
    });

    expect(second.reused).toBe(true);
    expect(second.workspacePath).toBe(first.workspacePath);
    expect(second.branch).toBe(first.branch);
  });

  it("recreates an invalid unborn worktree for the expected branch", async () => {
    const first = await ensureWorktree({
      mirrorPath,
      projectSlug: "myproject",
      issueIid: 42,
      titleSlug: "fix-login",
      baseBranch: "main",
      branchPrefix: "ai",
      workspaceRoot,
    });

    execaSync("git", [
      "--git-dir",
      mirrorPath,
      "update-ref",
      "-d",
      "refs/heads/ai/42-fix-login",
    ]);

    const status = execaSync("git", ["status", "--porcelain"], {
      cwd: first.workspacePath,
    }).stdout;
    expect(status).toContain("README.md");

    const second = await ensureWorktree({
      mirrorPath,
      projectSlug: "myproject",
      issueIid: 42,
      titleSlug: "fix-login",
      baseBranch: "main",
      branchPrefix: "ai",
      workspaceRoot,
    });

    expect(second.reused).toBe(false);
    expect(second.workspacePath).toBe(first.workspacePath);
    expect(
      execaSync("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: second.workspacePath,
      }).stdout.trim(),
    ).toMatch(/^[0-9a-f]{40}$/);
    expect(
      execaSync("git", ["status", "--porcelain"], {
        cwd: second.workspacePath,
      }).stdout.trim(),
    ).toBe("");
  });

  it("throws WorkspaceDirtyError when worktree has uncommitted changes", async () => {
    const result = await ensureWorktree({
      mirrorPath,
      projectSlug: "myproject",
      issueIid: 42,
      titleSlug: "fix-login",
      baseBranch: "main",
      branchPrefix: "ai",
      workspaceRoot,
    });

    fs.writeFileSync(
      path.join(result.workspacePath, "dirty.txt"),
      "uncommitted",
    );
    execaSync("git", ["add", "dirty.txt"], { cwd: result.workspacePath });

    await expect(
      ensureWorktree({
        mirrorPath,
        projectSlug: "myproject",
        issueIid: 42,
        titleSlug: "fix-login",
        baseBranch: "main",
        branchPrefix: "ai",
        workspaceRoot,
      }),
    ).rejects.toMatchObject({ name: "WorkspaceDirtyError" });
  });

  it("workspace path is deterministic: <root>/<slug>/<iid>", async () => {
    const result = await ensureWorktree({
      mirrorPath,
      projectSlug: "myproject",
      issueIid: 7,
      titleSlug: "add-readme",
      baseBranch: "main",
      branchPrefix: "ai",
      workspaceRoot,
    });

    expect(result.workspacePath).toBe(
      path.join(workspaceRoot, "myproject", "7"),
    );
  });

  it("rejects existing worktree path symlinks that resolve outside workspace root", async () => {
    const external = path.join(tmpDir, "external");
    fs.mkdirSync(external);
    const projectDir = path.join(workspaceRoot, "myproject");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.symlinkSync(external, path.join(projectDir, "42"), "dir");

    await expect(
      ensureWorktree({
        mirrorPath,
        projectSlug: "myproject",
        issueIid: 42,
        titleSlug: "fix-login",
        baseBranch: "main",
        branchPrefix: "ai",
        workspaceRoot,
      }),
    ).rejects.toMatchObject({ name: "WorkspacePathError" });
  });
});
