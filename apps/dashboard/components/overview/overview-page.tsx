"use client";

import type {
  OrchestratorStateSnapshot,
  RunRecord,
} from "@issuepilot/shared-contracts";
import { useCallback, useRef, useState } from "react";

import { useEventStream } from "../../lib/use-event-stream";

import { RunsTable } from "./runs-table";
import { ServiceHeader } from "./service-header";
import { SummaryCards } from "./summary-cards";

const REFRESH_THROTTLE_MS = 1_000;
const RUN_LIFECYCLE_PREFIXES = ["run_", "claim_", "retry_", "reconciliation_"];

function isLifecycleEvent(type: string): boolean {
  return RUN_LIFECYCLE_PREFIXES.some((prefix) => type.startsWith(prefix));
}

export interface OverviewData {
  snapshot: OrchestratorStateSnapshot;
  runs: RunRecord[];
}

interface OverviewPageProps {
  initialSnapshot: OrchestratorStateSnapshot;
  initialRuns: RunRecord[];
  refetch: () => Promise<OverviewData>;
}

export function OverviewPage({
  initialSnapshot,
  initialRuns,
  refetch,
}: OverviewPageProps) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [runs, setRuns] = useState(initialRuns);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightRef = useRef(false);

  const doRefresh = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const next = await refetch();
      setSnapshot(next.snapshot);
      setRuns(next.runs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "refresh failed");
    } finally {
      inflightRef.current = false;
    }
  }, [refetch]);

  const scheduleRefresh = useCallback(() => {
    if (pendingRef.current) return;
    pendingRef.current = setTimeout(() => {
      pendingRef.current = null;
      void doRefresh();
    }, REFRESH_THROTTLE_MS);
  }, [doRefresh]);

  useEventStream({
    bufferSize: 50,
    onEvent: (event) => {
      if (isLifecycleEvent(event.type)) {
        scheduleRefresh();
      }
    },
  });

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          IssuePilot Dashboard
        </h1>
        <p className="text-sm text-slate-500">
          Read-only live timeline of the local orchestrator. Updates stream over
          SSE from <code className="font-mono">/api/events/stream</code>.
        </p>
        {error && (
          <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </p>
        )}
      </header>

      <ServiceHeader snapshot={snapshot} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Summary
        </h2>
        <SummaryCards summary={snapshot.summary} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Runs
        </h2>
        <RunsTable runs={runs} />
      </section>
    </main>
  );
}
