/**
 * In-memory mapping of `runId → cancel()` closures used by the operator
 * `stopRun` action to interrupt the active Codex turn for a given run.
 *
 * The registry is scoped to a single orchestrator daemon process. Each
 * `runAgent` invocation registers a cancel closure (produced by the
 * runner-codex-app-server `onTurnActive` hook) before driveLifecycle takes
 * over, and unregisters it once driveLifecycle returns regardless of
 * outcome. The closure itself becomes a noop after the turn settles, so a
 * delayed `cancel()` arriving after the unregister is harmless on the
 * runner side.
 *
 * `cancel()` is bounded by a default 5s timeout (overridable). The result
 * is a discriminated union so callers can map it onto the HTTP/event
 * vocabulary (`cancel_failed` with `reason: cancel_timeout | cancel_threw
 * | not_registered`).
 */
export interface RunCancelResult {
  ok: boolean;
  reason?: "not_registered" | "cancel_threw" | "cancel_timeout";
  message?: string;
}

export interface RunCancelRegistry {
  register(runId: string, cancel: () => Promise<void>): void;
  cancel(
    runId: string,
    opts?: { timeoutMs?: number },
  ): Promise<RunCancelResult>;
  unregister(runId: string): void;
  has(runId: string): boolean;
  activeCount(): number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export function createRunCancelRegistry(): RunCancelRegistry {
  const map = new Map<string, () => Promise<void>>();

  return {
    register(runId, cancel) {
      map.set(runId, cancel);
    },
    unregister(runId) {
      map.delete(runId);
    },
    has(runId) {
      return map.has(runId);
    },
    activeCount() {
      return map.size;
    },
    async cancel(runId, opts) {
      const cancelFn = map.get(runId);
      if (!cancelFn) {
        return { ok: false, reason: "not_registered" };
      }

      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<RunCancelResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, reason: "cancel_timeout" }),
          timeoutMs,
        );
      });
      const cancelPromise = (async (): Promise<RunCancelResult> => {
        try {
          await cancelFn();
          return { ok: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, reason: "cancel_threw", message };
        }
      })();

      try {
        return await Promise.race([cancelPromise, timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
