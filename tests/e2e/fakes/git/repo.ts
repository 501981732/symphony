/**
 * Small helper for spinning up a "remote-like" bare git repository on disk
 * for E2E tests. The bare repo is initialised with an empty `main` branch
 * holding one commit so that `git clone --mirror` followed by
 * `git worktree add -B <branch> origin/main` works without extra setup.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";

export interface FakeBareRepo {
  /** Path to the bare `--bare` repository (this is what daemon will clone). */
  bareDir: string;
  /** Path to the seeding worktree used to prepare the initial commit. */
  seedDir: string;
  cleanup: () => void;
}

export async function createFakeBareRepo(options?: {
  initialFile?: { name: string; contents: string };
  baseBranch?: string;
}): Promise<FakeBareRepo> {
  const baseBranch = options?.baseBranch ?? "main";
  const initialFile = options?.initialFile ?? {
    name: "README.md",
    contents: "# E2E fixture\n",
  };

  const tmp = mkdtempSync(join(tmpdir(), "issuepilot-bare-"));
  const bareDir = join(tmp, "origin.git");
  const seedDir = join(tmp, "seed");
  mkdirSync(bareDir, { recursive: true });
  mkdirSync(seedDir, { recursive: true });

  await execa("git", ["init", "--bare", bareDir]);
  await execa("git", ["-C", bareDir, "symbolic-ref", "HEAD", `refs/heads/${baseBranch}`]);

  await execa("git", ["init", seedDir]);
  // Configure local identity inside the seed worktree so commits succeed
  // even on machines without a global git identity (CI sandboxes).
  await execa("git", ["-C", seedDir, "config", "user.email", "ci@issuepilot.local"]);
  await execa("git", ["-C", seedDir, "config", "user.name", "issuepilot-ci"]);
  await execa("git", ["-C", seedDir, "checkout", "-b", baseBranch]);
  writeFileSync(join(seedDir, initialFile.name), initialFile.contents);
  await execa("git", ["-C", seedDir, "add", "."]);
  await execa("git", ["-C", seedDir, "commit", "-m", "chore: seed initial commit"]);
  await execa("git", ["-C", seedDir, "remote", "add", "origin", bareDir]);
  await execa("git", ["-C", seedDir, "push", "origin", baseBranch]);

  return {
    bareDir,
    seedDir,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

/** Read the list of branches currently in a bare repository. */
export async function listBranches(bareDir: string): Promise<string[]> {
  const r = await execa("git", [
    "--git-dir",
    bareDir,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
