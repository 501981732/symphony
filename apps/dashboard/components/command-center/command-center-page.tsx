"use client";

import type { OrchestratorStateSnapshot } from "@issuepilot/shared-contracts";
import { useCallback, useMemo, useRef, useState } from "react";

import type { RunWithReport } from "../../lib/api";
import { useEventStream } from "../../lib/use-event-stream";
import { ServiceHeader } from "../overview/service-header";
import { SummaryCards } from "../overview/summary-cards";

import { ReviewPacketInspector } from "./review-packet-inspector";
import { RunBoardView } from "./run-board-view";
import { RunListView } from "./run-list-view";
import { ViewToggle, type CommandCenterView } from "./view-toggle";

const REFRESH_THROTTLE_MS = 1_000;
const RUN_LIFECYCLE_PREFIXES = ["run_", "claim_", "retry_", "reconciliation_"];

function isLifecycleEvent(type: string): boolean {
  return RUN_LIFECYCLE_PREFIXES.some((prefix) => type.startsWith(prefix));
}

export interface CommandCenterData {
  snapshot: OrchestratorStateSnapshot;
  runs: RunWithReport[];
}

interface CommandCenterPageProps {
  initialSnapshot: OrchestratorStateSnapshot;
  initialRuns: RunWithReport[];
  refetch: () => Promise<CommandCenterData>;
}

export function CommandCenterPage({
  initialSnapshot,
  initialRuns,
  refetch,
}: CommandCenterPageProps) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [runs, setRuns] = useState(initialRuns);
  const [view, setView] = useState<CommandCenterView>("list");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
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

  const selectedRun = useMemo(
    () => runs.find((run) => run.runId === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Command Center
        </h1>
        <p className="text-sm text-slate-500">
          List, Board, and Review Packet views over the active orchestrator.
          Updates stream over SSE from{" "}
          <code className="font-mono">/api/events/stream</code>.
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
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Runs
          </h2>
          <ViewToggle value={view} onChange={setView} />
        </div>
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div>
            {view === "list" ? (
              <RunListView
                runs={runs}
                selectedRunId={selectedRunId}
                onSelect={setSelectedRunId}
              />
            ) : (
              <RunBoardView
                runs={runs}
                selectedRunId={selectedRunId}
                onSelect={setSelectedRunId}
              />
            )}
          </div>
          <aside className="flex flex-col gap-3">
            <ReviewPacketInspector run={selectedRun} />
          </aside>
        </div>
      </section>
    </main>
  );
}
