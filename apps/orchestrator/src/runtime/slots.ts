export interface ConcurrencySlots {
  tryAcquire(runId: string): boolean;
  release(runId: string): void;
  available(): number;
  active(): Set<string>;
}

export function createConcurrencySlots(max: number): ConcurrencySlots {
  const activeSet = new Set<string>();

  return {
    tryAcquire(runId) {
      if (activeSet.has(runId)) return true;
      if (activeSet.size >= max) return false;
      activeSet.add(runId);
      return true;
    },
    release(runId) {
      activeSet.delete(runId);
    },
    available() {
      return Math.max(0, max - activeSet.size);
    },
    active() {
      return new Set(activeSet);
    },
  };
}
