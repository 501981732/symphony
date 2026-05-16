export {
  slugify,
  assertWithinRoot,
  branchName,
  WorkspacePathError,
} from "./paths.js";
export { ensureMirror } from "./mirror.js";
export type { EnsureMirrorInput, EnsureMirrorResult } from "./mirror.js";
export {
  ensureWorktree,
  WorkspaceBaseBranchError,
  WorkspaceDirtyError,
} from "./worktree.js";
export type { EnsureWorktreeInput, EnsureWorktreeResult } from "./worktree.js";
export { runHook, HookFailedError } from "./hooks.js";
export type { RunHookInput, RunHookResult } from "./hooks.js";
export { cleanupOnFailure, pruneWorktree } from "./cleanup.js";
export type { CleanupOnFailureInput, PruneWorktreeInput } from "./cleanup.js";
export {
  enumerateWorkspaceEntries,
  planWorkspaceCleanup,
} from "./retention.js";
export type {
  CleanupDelete,
  CleanupDeleteReason,
  CleanupError,
  CleanupPlan,
  EnumerateWorkspaceEntriesInput,
  EnumerateWorkspaceEntriesResult,
  PlanWorkspaceCleanupInput,
  WorkspaceEntry,
  WorkspaceEntryStatus,
} from "./retention.js";

export const PACKAGE_NAME = "@issuepilot/workspace";
export const VERSION = "0.0.0";
