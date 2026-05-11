export interface RunEntry {
  runId: string;
  status: string;
  attempt: number;
  [key: string]: unknown;
}

export interface RuntimeState {
  lastPollAt: string | null;
  lastConfigReloadAt: string | null;
  setRun(runId: string, record: RunEntry): void;
  getRun(runId: string): RunEntry | undefined;
  removeRun(runId: string): void;
  listRuns(status?: string): RunEntry[];
  allRuns(): RunEntry[];
  summary(): Record<string, number>;
}

export function createRuntimeState(): RuntimeState {
  const runs = new Map<string, RunEntry>();
  let lastPollAt: string | null = null;
  let lastConfigReloadAt: string | null = null;

  return {
    get lastPollAt() {
      return lastPollAt;
    },
    set lastPollAt(v: string | null) {
      lastPollAt = v;
    },
    get lastConfigReloadAt() {
      return lastConfigReloadAt;
    },
    set lastConfigReloadAt(v: string | null) {
      lastConfigReloadAt = v;
    },

    setRun(runId, record) {
      runs.set(runId, record);
    },
    getRun(runId) {
      return runs.get(runId);
    },
    removeRun(runId) {
      runs.delete(runId);
    },
    listRuns(status?) {
      if (!status) return [...runs.values()];
      return [...runs.values()].filter((r) => r.status === status);
    },
    allRuns() {
      return [...runs.values()];
    },
    summary() {
      const counts: Record<string, number> = {
        claimed: 0,
        running: 0,
        retrying: 0,
        completed: 0,
        failed: 0,
        blocked: 0,
      };
      for (const r of runs.values()) {
        counts[r.status] = (counts[r.status] ?? 0) + 1;
      }
      return counts;
    },
  };
}
