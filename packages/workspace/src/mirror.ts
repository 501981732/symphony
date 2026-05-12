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
 * Clone a bare mirror if it doesn't exist, or fetch --prune if it does.
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
    // `git clone --mirror` sets `remote.origin.mirror=true`, which would
    // refuse any `git push origin <refspec>` we issue later (git emits
    // "--mirror cannot be used with refspecs"). We still want the mirror to
    // hold every remote ref locally, but we also want refspec-aware pushes
    // from worktrees, so we drop the flag and install an explicit catch-all
    // fetch refspec to preserve mirror-like behaviour on subsequent fetches.
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
  } else {
    await execa("git", ["--git-dir", mirrorPath, "fetch", "--prune", "origin"]);
  }

  return { mirrorPath };
}
