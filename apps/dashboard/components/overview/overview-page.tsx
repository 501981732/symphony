"use client";

import type {
  OrchestratorStateSnapshot,
  RunRecord,
} from "@issuepilot/shared-contracts";
import { useCallback, useRef, useState, useTransition } from "react";

import { ApiError, archiveRun, retryRun, stopRun } from "../../lib/api";
import { useEventStream } from "../../lib/use-event-stream";

import { ProjectList } from "./project-list";
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
  const [actionsPending, startAction] = useTransition();
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

  const performAction = useCallback(
    (
      runId: string,
      action: (id: string) => Promise<{ ok: true }>,
      label: string,
    ): void => {
      startAction(async () => {
        try {
          await action(runId);
          await doRefresh();
        } catch (err) {
          if (err instanceof ApiError) {
            const detail = err.reason
              ? `${err.code ?? "error"}:${err.reason}`
              : (err.code ?? `HTTP ${err.status}`);
            setError(`${label} failed for ${runId} (${detail})`);
          } else {
            setError(
              err instanceof Error
                ? `${label} failed for ${runId}: ${err.message}`
                : `${label} failed for ${runId}`,
            );
          }
        }
      });
    },
    [doRefresh],
  );

  const handleRetry = useCallback(
    (runId: string) => performAction(runId, retryRun, "retry"),
    [performAction],
  );
  const handleStop = useCallback(
    (runId: string) => performAction(runId, stopRun, "stop"),
    [performAction],
  );
  const handleArchive = useCallback(
    (runId: string) => performAction(runId, archiveRun, "archive"),
    [performAction],
  );

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

      {snapshot.projects && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Projects
          </h2>
          <ProjectList projects={snapshot.projects} />
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Runs
        </h2>
        <RunsTable
          runs={runs}
          onRetry={handleRetry}
          onStop={handleStop}
          onArchive={handleArchive}
          actionsPending={actionsPending}
        />
      </section>
    </main>
  );
}
