"use client";

import type { IssuePilotEvent, RunRecord } from "@issuepilot/shared-contracts";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";

import { ApiError, archiveRun, retryRun, stopRun } from "../../lib/api";
import { useEventStream } from "../../lib/use-event-stream";
import { RunActions } from "../overview/run-actions";
import { Badge, type BadgeTone } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

import { EventTimeline } from "./event-timeline";
import { LogTail } from "./log-tail";
import { ToolCallList } from "./tool-call-list";

const STATUS_TONES: Record<RunRecord["status"], BadgeTone> = {
  claimed: "info",
  running: "info",
  retrying: "warning",
  stopping: "warning",
  completed: "success",
  failed: "danger",
  blocked: "violet",
};

interface RunDetailPageProps {
  run: RunRecord;
  initialEvents: IssuePilotEvent[];
  logsTail: string[];
  /**
   * Optional operator-action callbacks. When supplied, RunActions surfaces
   * Retry / Stop / Archive in the page header. The parent owns the API call
   * + refresh, keeping this component declarative.
   */
  onRetry?: (runId: string) => void;
  onStop?: (runId: string) => void;
  onArchive?: (runId: string) => void;
  /** Disable header buttons while a request is in flight. */
  actionsPending?: boolean;
}

export function RunDetailPage({
  run,
  initialEvents,
  logsTail,
  onRetry,
  onStop,
  onArchive,
  actionsPending,
}: RunDetailPageProps) {
  const router = useRouter();
  const [events, setEvents] = useState<IssuePilotEvent[]>(initialEvents);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, startAction] = useTransition();

  useEffect(() => {
    setEvents(initialEvents);
  }, [initialEvents]);

  const performAction = useCallback(
    (
      runId: string,
      action: (id: string) => Promise<{ ok: true }>,
      label: string,
    ): void => {
      startAction(async () => {
        try {
          await action(runId);
          setActionError(null);
          router.refresh();
        } catch (err) {
          if (err instanceof ApiError) {
            const detail = err.reason
              ? `${err.code ?? "error"}:${err.reason}`
              : (err.code ?? `HTTP ${err.status}`);
            setActionError(`${label} failed (${detail})`);
          } else {
            setActionError(
              err instanceof Error
                ? `${label} failed: ${err.message}`
                : `${label} failed`,
            );
          }
        }
      });
    },
    [router],
  );

  const handleRetry =
    onRetry ?? ((id: string) => performAction(id, retryRun, "retry"));
  const handleStop =
    onStop ?? ((id: string) => performAction(id, stopRun, "stop"));
  const handleArchive =
    onArchive ?? ((id: string) => performAction(id, archiveRun, "archive"));
  const buttonsDisabled = actionsPending ?? pending;

  useEventStream<IssuePilotEvent>({
    runId: run.runId,
    bufferSize: 500,
    onEvent: (event) => {
      setEvents((prev) => {
        if (prev.some((e) => e.id === event.id)) return prev;
        return [...prev, event];
      });
    },
  });

  const toolCalls = useMemo(
    () => events.filter((e) => e.type.startsWith("tool_call_")),
    [events],
  );

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
      <nav className="text-sm">
        <a href="/" className="text-sky-700 hover:underline">
          ← Overview
        </a>
      </nav>

      {actionError ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {actionError}
        </p>
      ) : null}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle>Run {run.runId}</CardTitle>
          <RunActions
            run={{
              runId: run.runId,
              status: run.status,
              ...(run.archivedAt ? { archivedAt: run.archivedAt } : {}),
            }}
            onRetry={handleRetry}
            onStop={handleStop}
            onArchive={handleArchive}
            pending={buttonsDisabled}
          />
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-3">
          <Field label="Issue">
            <a
              href={run.issue.url}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono text-sky-700 hover:underline"
            >
              #{run.issue.iid}
            </a>{" "}
            <span className="text-slate-700">{run.issue.title}</span>
          </Field>
          <Field label="Status">
            <Badge tone={STATUS_TONES[run.status]}>{run.status}</Badge>
          </Field>
          <Field label="Attempt">{run.attempt}</Field>
          <Field label="Branch">
            <code className="font-mono text-xs text-slate-700">
              {run.branch}
            </code>
          </Field>
          <Field label="Workspace">
            <code className="break-all font-mono text-xs text-slate-700">
              {run.workspacePath}
            </code>
          </Field>
          <Field label="Merge request">
            {run.mergeRequestUrl ? (
              <a
                href={run.mergeRequestUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-sky-700 hover:underline"
                aria-label="merge request"
              >
                open
              </a>
            ) : (
              <span className="text-slate-400">—</span>
            )}
          </Field>
          <Field label="Labels">
            <div className="flex flex-wrap gap-1">
              {run.issue.labels.map((label) => (
                <Badge key={label} tone="neutral">
                  {label}
                </Badge>
              ))}
            </div>
          </Field>
          {run.lastError ? (
            <Field label="Failure">
              <span className="font-mono text-xs text-rose-700">
                {run.lastError.code}
              </span>{" "}
              <span className="text-slate-700">{run.lastError.message}</span>
            </Field>
          ) : null}
        </CardContent>
      </Card>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Timeline
        </h2>
        <EventTimeline events={events} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Tool calls
        </h2>
        <ToolCallList events={toolCalls} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Log tail
        </h2>
        <LogTail lines={logsTail} />
      </section>
    </main>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <span className="text-slate-900">{children}</span>
    </div>
  );
}
