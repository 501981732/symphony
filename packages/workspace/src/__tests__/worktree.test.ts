import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execaSync } from "execa";
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
