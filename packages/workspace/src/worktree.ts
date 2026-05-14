import * as fs from "node:fs/promises";
import * as path from "node:path";

import { execa } from "execa";

import { assertWithinRoot, branchName } from "./paths.js";

const REMOTE_TRACKING_FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

export class WorkspaceDirtyError extends Error {
  override name = "WorkspaceDirtyError" as const;
  constructor(message: string) {
    super(message);
  }
}

export class WorkspaceBaseBranchError extends Error {
  override name = "WorkspaceBaseBranchError" as const;
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
    const result = await execa("git", [
      "-C",
      dir,
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function currentBranch(dir: string): Promise<string> {
  const result = await execa("git", [
    "-C",
    dir,
    "symbolic-ref",
    "--short",
    "HEAD",
  ]);
  return result.stdout.trim();
}

async function isClean(dir: string): Promise<boolean> {
  const result = await execa("git", ["-C", dir, "status", "--porcelain"]);
  return result.stdout.trim() === "";
}

async function hasValidHead(dir: string): Promise<boolean> {
  try {
    await execa("git", ["-C", dir, "rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function listRemoteBranches(mirrorPath: string): Promise<string[]> {
  const result = await execa("git", [
    "--git-dir",
    mirrorPath,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/remotes/origin",
  ]);

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line.startsWith("origin/") ? line.slice("origin/".length) : line,
    )
    .sort();
}

async function listLocalBranches(mirrorPath: string): Promise<string[]> {
  const result = await execa("git", [
    "--git-dir",
    mirrorPath,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

async function usesRemoteTrackingFetchRefspec(
  mirrorPath: string,
): Promise<boolean> {
  const result = await execa(
    "git",
    ["--git-dir", mirrorPath, "config", "--get-all", "remote.origin.fetch"],
    { reject: false },
  );

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .includes(REMOTE_TRACKING_FETCH_REFSPEC);
}

async function resolveBaseRef(
  mirrorPath: string,
  baseBranch: string,
): Promise<string> {
  try {
    await execa("git", [
      "--git-dir",
      mirrorPath,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${baseBranch}^{commit}`,
    ]);
    return `origin/${baseBranch}`;
  } catch {
    if (await usesRemoteTrackingFetchRefspec(mirrorPath)) {
      const branches = await listRemoteBranches(mirrorPath);
      const available =
        branches.length > 0 ? branches.join(", ") : "(no remote branches)";
      throw new WorkspaceBaseBranchError(
        `Base branch '${baseBranch}' does not exist in mirror ${mirrorPath}. Available branches: ${available}. Update git.base_branch in .agents/workflow.md or push the branch to the repository.`,
      );
    }

    try {
      await execa("git", [
        "--git-dir",
        mirrorPath,
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${baseBranch}^{commit}`,
      ]);
      return baseBranch;
    } catch {
      const branches = await listLocalBranches(mirrorPath);
      const available =
        branches.length > 0 ? branches.join(", ") : "(no branches)";
      throw new WorkspaceBaseBranchError(
        `Base branch '${baseBranch}' does not exist in mirror ${mirrorPath}. Available branches: ${available}. Update git.base_branch in .agents/workflow.md or push the branch to the repository.`,
      );
    }
  }
}

async function createWorktree(input: {
  mirrorPath: string;
  workspacePath: string;
  branch: string;
  baseBranch: string;
}): Promise<void> {
  await fs.mkdir(path.dirname(input.workspacePath), { recursive: true });
  const baseRef = await resolveBaseRef(input.mirrorPath, input.baseBranch);

  await execa("git", [
    "--git-dir",
    input.mirrorPath,
    "worktree",
    "add",
    input.workspacePath,
    "-B",
    input.branch,
    baseRef,
  ]);
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

  await fs.mkdir(input.workspaceRoot, { recursive: true });
  await assertWithinRoot(workspacePath, input.workspaceRoot);
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
    await createWorktree({
      mirrorPath: input.mirrorPath,
      workspacePath,
      branch,
      baseBranch: input.baseBranch,
    });

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

  if (!(await hasValidHead(workspacePath))) {
    await execa("git", [
      "--git-dir",
      input.mirrorPath,
      "worktree",
      "remove",
      "--force",
      workspacePath,
    ]);
    await execa("git", ["--git-dir", input.mirrorPath, "worktree", "prune"]);
    await createWorktree({
      mirrorPath: input.mirrorPath,
      workspacePath,
      branch,
      baseBranch: input.baseBranch,
    });

    return { workspacePath, branch, reused: false };
  }

  if (!(await isClean(workspacePath))) {
    throw new WorkspaceDirtyError(
      `Worktree has uncommitted changes: ${workspacePath}`,
    );
  }

  await execa("git", ["-C", workspacePath, "fetch", "origin"]);

  return { workspacePath, branch, reused: true };
}
