import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface CleanupOnFailureInput {
  workspacePath: string;
  context?: Record<string, unknown>;
}

/**
 * Mark a workspace as failed without deleting any files.
 * Creates `.issuepilot/failed-at-<iso>` with optional failure context.
 */
export async function cleanupOnFailure(
  input: CleanupOnFailureInput,
): Promise<void> {
  const markerDir = path.join(input.workspacePath, ".issuepilot");
  await fs.mkdir(markerDir, { recursive: true });

  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const markerFile = path.join(markerDir, `failed-at-${now}`);

  const payload = {
    failedAt: new Date().toISOString(),
    workspacePath: input.workspacePath,
    ...input.context,
  };

  await fs.writeFile(markerFile, JSON.stringify(payload, null, 2), "utf-8");
}

export interface PruneWorktreeInput {
  mirrorPath: string;
  workspacePath: string;
  branch: string;
}

/**
 * P1 placeholder: prune a worktree and optionally delete its branch.
 * Not called in P0.
 */
export async function pruneWorktree(
  _input: PruneWorktreeInput,
): Promise<void> {
  // intentionally empty for P0
}
