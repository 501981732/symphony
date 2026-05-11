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
  } else {
    await execa("git", ["--git-dir", mirrorPath, "fetch", "--prune", "origin"]);
  }

  return { mirrorPath };
}
