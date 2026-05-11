import type { ConcurrencySlots } from "../runtime/slots.js";
import type { RuntimeState } from "../runtime/state.js";

export interface LoopDeps {
  state: RuntimeState;
  slots: ConcurrencySlots;
  pollIntervalMs: number;

  loadConfig(): { pollIntervalMs?: number | undefined };

  claim(): Promise<Array<{ runId: string }>>;
  dispatch(runId: string): Promise<void>;
  reconcileRunning(): Promise<void>;
  logError(err: unknown): void;
}

export interface LoopHandle {
  stop(): Promise<void>;
  tick(): Promise<void>;
}

export function startLoop(deps: LoopDeps): LoopHandle {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const inflightDispatches = new Set<Promise<void>>();

  const dispatchRun = (runId: string, dispatchedRunIds: Set<string>) => {
    if (dispatchedRunIds.has(runId)) return;
    if (!deps.slots.tryAcquire(runId)) return;

    dispatchedRunIds.add(runId);
    const p = deps
      .dispatch(runId)
      .catch(deps.logError)
      .finally(() => {
        deps.slots.release(runId);
        inflightDispatches.delete(p);
      });
    inflightDispatches.add(p);
  };

  const tick = async () => {
    if (stopped) return;

    const tickStartedAt = new Date();
    const dispatchedRunIds = new Set<string>();
    deps.state.lastPollAt = tickStartedAt.toISOString();

    try {
      deps.loadConfig();
      deps.state.lastConfigReloadAt = new Date().toISOString();
    } catch (err) {
      deps.logError(err);
    }

    try {
      await deps.reconcileRunning();
    } catch (err) {
      deps.logError(err);
    }

    const nowMs = Date.now();
    for (const run of deps.state.listRuns("retrying")) {
      if (deps.slots.available() === 0) break;
      if (deps.slots.active().has(run.runId)) continue;
      if (typeof run.nextRetryAt !== "string") continue;

      const nextRetryAtMs = Date.parse(run.nextRetryAt);
      if (Number.isNaN(nextRetryAtMs) || nextRetryAtMs > nowMs) continue;

      dispatchRun(run.runId, dispatchedRunIds);
    }

    if (deps.slots.available() === 0) return;

    let candidates: Array<{ runId: string }> = [];
    try {
      candidates = await deps.claim();
    } catch (err) {
      deps.logError(err);
      return;
    }

    for (const c of candidates) {
      if (deps.slots.available() === 0 && !deps.slots.active().has(c.runId)) break;
      dispatchRun(c.runId, dispatchedRunIds);
    }
  };

  timer = setInterval(() => {
    tick().catch(deps.logError);
  }, deps.pollIntervalMs);

  return {
    tick,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await Promise.all(inflightDispatches);
    },
  };
}
