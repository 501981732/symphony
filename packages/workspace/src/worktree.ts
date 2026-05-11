import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execa } from "execa";
import { assertWithinRoot, branchName } from "./paths.js";

export class WorkspaceDirtyError extends Error {
  override name = "WorkspaceDirtyError" as const;
  constructor(message: string) {
    super(message);
  }
}

export interface EnsureWorktreeInput {
  mirrorPath: string;
  projectSlug: string;
  issueIid: number;
  titleSlug: string;
  baseBranch: string;
  branchPrefix: string;
  workspaceRoot: string;
}

export interface EnsureWorktreeResult {
  workspacePath: string;
  branch: string;
  reused: boolean;
}

async function isGitWorktree(dir: string): Promise<boolean> {
  try {
    const result = await execa(
      "git",
      ["-C", dir, "rev-parse", "--is-inside-work-tree"],
    );
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function currentBranch(dir: string): Promise<string> {
  const result = await execa(
    "git",
    ["-C", dir, "symbolic-ref", "--short", "HEAD"],
  );
  return result.stdout.trim();
}

async function isClean(dir: string): Promise<boolean> {
  const result = await execa("git", ["-C", dir, "status", "--porcelain"]);
  return result.stdout.trim() === "";
}

export async function ensureWorktree(
  input: EnsureWorktreeInput,
): Promise<EnsureWorktreeResult> {
  const branch = branchName({
    prefix: input.branchPrefix,
    iid: input.issueIid,
    titleSlug: input.titleSlug,
  });

  const workspacePath = path.join(
    input.workspaceRoot,
    input.projectSlug,
    String(input.issueIid),
  );

  await assertWithinRoot(
    path.join(input.workspaceRoot, input.projectSlug),
    input.workspaceRoot,
  );

  let exists = false;
  try {
    const stat = await fs.stat(workspacePath);
    exists = stat.isDirectory();
  } catch {
    exists = false;
  }

  if (!exists) {
    await fs.mkdir(path.dirname(workspacePath), { recursive: true });

    await execa("git", [
      "--git-dir",
      input.mirrorPath,
      "worktree",
      "add",
      workspacePath,
      "-B",
      branch,
      input.baseBranch,
    ]);

    return { workspacePath, branch, reused: false };
  }

  if (!(await isGitWorktree(workspacePath))) {
    throw new WorkspaceDirtyError(
      `Path exists but is not a git worktree: ${workspacePath}`,
    );
  }

  const current = await currentBranch(workspacePath);
  if (current !== branch) {
    throw new WorkspaceDirtyError(
      `Worktree is on branch '${current}', expected '${branch}'`,
    );
  }

  if (!(await isClean(workspacePath))) {
    throw new WorkspaceDirtyError(
      `Worktree has uncommitted changes: ${workspacePath}`,
    );
  }

  await execa("git", ["-C", workspacePath, "fetch", "origin"]);

  return { workspacePath, branch, reused: true };
}
