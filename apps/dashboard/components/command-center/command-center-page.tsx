"use client";

import type { OrchestratorStateSnapshot } from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RunWithReport } from "../../lib/api";
import { useEventStream } from "../../lib/use-event-stream";
import { ServiceHeader } from "../overview/service-header";
import { SummaryCards } from "../overview/summary-cards";
import { Sheet } from "../ui/sheet";

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
  const t = useTranslations();
  const tCommon = useTranslations("common");
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
      setError(err instanceof Error ? err.message : t("common.refreshFailed"));
    } finally {
      inflightRef.current = false;
    }
  }, [refetch, t]);

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

  // Switching from list → board automatically dismisses the split-pane
  // selection so we don't surprise users with an immediately-open sheet.
  // The selection itself stays (selectedRunId remains set) so going back
  // to list keeps continuity.
  const handleViewChange = useCallback((next: CommandCenterView) => {
    setView(next);
  }, []);

  const selectedRun = useMemo(
    () => runs.find((run) => run.runId === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  // In board view we use a sheet (right-slide drawer) so the kanban
  // keeps its full 6-column width. List view keeps the split-pane
  // layout when a row is selected — that combination is faster for
  // scanning many runs side-by-side.
  const sheetOpen = view === "board" && Boolean(selectedRun);
  const showInspectorColumn = view === "list" && Boolean(selectedRun);

  const closeSheet = useCallback(() => setSelectedRunId(null), []);

  // Keyboard shortcut: ESC clears the list-pane selection too. The
  // Sheet handles its own ESC; this handler ensures parity in list
  // view where there's no modal overlay to capture the key.
  useEffect(() => {
    if (!showInspectorColumn) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedRunId(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showInspectorColumn]);

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-6 lg:px-8 lg:py-8">
      <header className="flex flex-col gap-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle">
          {t("home.overheadLabel")}
        </span>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-fg">
          {t("home.title")}
        </h1>
        <p className="max-w-2xl text-sm text-fg-muted">
          {t.rich("home.description", {
            code: (chunks) => (
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">
                {chunks}
              </code>
            ),
          })}
        </p>
        {error ? (
          <p className="mt-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger-fg">
            {error}
          </p>
        ) : null}
      </header>

      <ServiceHeader snapshot={snapshot} />

      <SummaryCards summary={snapshot.summary} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <SectionHeader
            title={t("runs.title")}
            caption={t("runs.caption", { count: runs.length })}
          />
          <ViewToggle value={view} onChange={handleViewChange} />
        </div>

        {showInspectorColumn ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
            <div className="min-w-0">
              <RunListView
                runs={runs}
                selectedRunId={selectedRunId}
                onSelect={setSelectedRunId}
              />
            </div>
            <aside className="flex flex-col gap-3">
              <ReviewPacketInspector
                run={selectedRun}
                onClose={() => setSelectedRunId(null)}
              />
            </aside>
          </div>
        ) : (
          <div className="min-w-0">
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
        )}
      </section>

      <Sheet
        open={sheetOpen}
        onClose={closeSheet}
        label={t("inspector.title")}
        closeLabel={tCommon("close")}
      >
        <ReviewPacketInspector run={selectedRun} variant="sheet" />
      </Sheet>
    </div>
  );
}

function SectionHeader({ title, caption }: { title: string; caption: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h2 className="text-base font-semibold tracking-tight text-fg">{title}</h2>
      <p className="text-xs text-fg-muted">{caption}</p>
    </div>
  );
}
