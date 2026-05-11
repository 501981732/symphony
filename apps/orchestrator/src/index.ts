export const PACKAGE_NAME = "@issuepilot/orchestrator";
export const VERSION = "0.0.0";

export { createRuntimeState, type RuntimeState, type RunEntry } from "./runtime/state.js";
export { createConcurrencySlots, type ConcurrencySlots } from "./runtime/slots.js";
export { claimCandidates, type ClaimInput, type ClaimedIssue } from "./orchestrator/claim.js";
export { classifyError, type Classification } from "./orchestrator/classify.js";
export { shouldRetry, type RetryInput, type RetryDecision } from "./orchestrator/retry.js";
export { reconcile, type ReconcileInput, type ReconcileEvent } from "./orchestrator/reconcile.js";
export { dispatch, type DispatchDeps, type DispatchInput } from "./orchestrator/dispatch.js";
export { startLoop, type LoopDeps, type LoopHandle } from "./orchestrator/loop.js";
export { createServer } from "./server/index.js";
export { buildCli } from "./cli.js";
