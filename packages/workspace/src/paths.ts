import * as fs from "node:fs/promises";
import * as path from "node:path";

export class WorkspacePathError extends Error {
  override name = "WorkspacePathError" as const;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Sanitize a string into a URL/branch-safe slug.
 * Keeps only `[a-z0-9-]`, collapses consecutive hyphens,
 * trims leading/trailing hyphens, and enforces `maxLen`.
 */
export function slugify(input: string, maxLen = 40): string {
  let slug = input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length > maxLen) {
    slug = slug.slice(0, maxLen).replace(/-+$/, "");
  }

  return slug || "untitled";
}

/**
 * Throws `WorkspacePathError` if `child` resolves outside `root`
 * after canonicalization (resolving symlinks).
 */
export async function assertWithinRoot(
  child: string,
  root: string,
): Promise<void> {
  let realChild: string;
  let realRoot: string;

  try {
    realRoot = await fs.realpath(root);
  } catch {
    throw new WorkspacePathError(
      `Root path does not exist: ${root}`,
    );
  }

  try {
    realChild = await fs.realpath(child);
  } catch {
    const resolved = path.resolve(child);
    const normalizedRoot = path.resolve(root);
    if (
      !resolved.startsWith(normalizedRoot + path.sep) &&
      resolved !== normalizedRoot
    ) {
      throw new WorkspacePathError(
        `Path escapes root: ${child} is outside ${root}`,
      );
    }
    return;
  }

  if (
    !realChild.startsWith(realRoot + path.sep) &&
    realChild !== realRoot
  ) {
    throw new WorkspacePathError(
      `Path escapes root: ${child} resolves to ${realChild} which is outside ${realRoot}`,
    );
  }
}

/**
 * Build a branch name from prefix, issue IID, and title slug.
 * Validates length <= 200 and rejects `..`, `:`, `~`, `^`, `\\`.
 */
export function branchName(opts: {
  prefix: string;
  iid: number;
  titleSlug: string;
}): string {
  const name = `${opts.prefix}/${opts.iid}-${opts.titleSlug}`;

  if (name.includes("..")) {
    throw new WorkspacePathError(
      `Branch name contains '..': ${name}`,
    );
  }
  if (name.length > 200) {
    throw new WorkspacePathError(
      `Branch name exceeds 200 characters: ${name.length}`,
    );
  }
  if (/[~:^\\]/.test(name)) {
    throw new WorkspacePathError(
      `Branch name contains reserved characters: ${name}`,
    );
  }

  return name;
}
