import type { RuntimeState } from "../runtime/state.js";
import type { ConcurrencySlots } from "../runtime/slots.js";

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

  const tick = async () => {
    if (stopped) return;

    deps.state.lastPollAt = new Date().toISOString();

    try {
      await deps.reconcileRunning();
    } catch (err) {
      deps.logError(err);
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
      const p = deps
        .dispatch(c.runId)
        .catch(deps.logError)
        .finally(() => {
          deps.slots.release(c.runId);
          inflightDispatches.delete(p);
        });
      inflightDispatches.add(p);
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
