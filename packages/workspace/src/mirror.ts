import * as fs from "node:fs/promises";
import * as path from "node:path";

import { execa } from "execa";

export interface EnsureMirrorInput {
  repoUrl: string;
  projectSlug: string;
  repoCacheRoot: string;
}

export interface EnsureMirrorResult {
  mirrorPath: string;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(
      process.env["HOME"] ?? process.env["USERPROFILE"] ?? "",
      p.slice(2),
    );
  }
  return p;
}

/**
 * Strip the mirror flag from a clone and install an explicit fetch refspec
 * so subsequent `git push origin <refspec>` calls do not trip git's
 * "--mirror cannot be used with refspecs" guard.
 *
 * This is safe to run repeatedly:
 *   - `git config --unset-all` is a no-op when the key is already absent;
 *   - `git config remote.origin.fetch <refspec>` overwrites any existing
 *     value, so the second invocation is idempotent.
 *
 * IssuePilot only pushes branch refs from worktrees; we deliberately do
 * NOT mirror `refs/tags/*` or `refs/notes/*` because the orchestrator
 * never produces or consumes them. Operators relying on tag mirroring
 * should adjust the refspec or pre-push tags manually.
 */
async function migrateMirrorClone(mirrorPath: string): Promise<void> {
  await execa("git", [
    "--git-dir",
    mirrorPath,
    "config",
    "--unset-all",
    "remote.origin.mirror",
  ]).catch(() => undefined);
  await execa("git", [
    "--git-dir",
    mirrorPath,
    "config",
    "remote.origin.fetch",
    "+refs/heads/*:refs/heads/*",
  ]);
}

/**
 * Clone a bare mirror if it doesn't exist, or fetch --prune if it does.
 *
 * Engineers who installed IssuePilot before the mirror-flag fix landed will
 * have `remote.origin.mirror=true` baked into their existing cache. The
 * `else` branch below detects + migrates those caches in place so the
 * upgrade path works without `rm -rf ~/.issuepilot/repos`.
 */
export async function ensureMirror(
  input: EnsureMirrorInput,
): Promise<EnsureMirrorResult> {
  const cacheRoot = expandHome(input.repoCacheRoot);
  const mirrorPath = path.join(cacheRoot, `${input.projectSlug}.git`);

  await fs.mkdir(path.dirname(mirrorPath), { recursive: true });

  let exists = false;
  try {
    const stat = await fs.stat(mirrorPath);
    exists = stat.isDirectory();
  } catch {
    exists = false;
  }

  if (!exists) {
    await execa("git", ["clone", "--mirror", input.repoUrl, mirrorPath]);
    await migrateMirrorClone(mirrorPath);
  } else {
    // The pre-fix cache has `remote.origin.mirror=true`. If we leave that in
    // place, the next `git push origin <refspec>` from a worktree will fail
    // with "--mirror cannot be used with refspecs". `git config --get`
    // exits 1 when the key is missing, so a successful exit means we need
    // to migrate; we run the migration unconditionally either way because
    // it is idempotent.
    await migrateMirrorClone(mirrorPath);
    await execa("git", ["--git-dir", mirrorPath, "fetch", "--prune", "origin"]);
  }

  return { mirrorPath };
}
