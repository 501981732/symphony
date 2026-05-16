"use client";

import type {
  IssuePilotEvent,
  PipelineStatus,
  ReviewFeedbackSummary,
  RunRecord,
  RunReportArtifact,
} from "@issuepilot/shared-contracts";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";

import { ApiError, archiveRun, retryRun, stopRun } from "../../lib/api";
import { useEventStream } from "../../lib/use-event-stream";
import { RunActions } from "../overview/run-actions";
import { Badge, type BadgeTone } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

import { EventTimeline } from "./event-timeline";
import { LogTail } from "./log-tail";
import { ReviewPacket } from "./review-packet";
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

const CI_TONES: Record<PipelineStatus, BadgeTone> = {
  running: "info",
  success: "success",
  failed: "danger",
  pending: "info",
  canceled: "warning",
  unknown: "neutral",
};

interface RunDetailPageProps {
  run: RunRecord;
  initialEvents: IssuePilotEvent[];
  logsTail: string[];
  /**
   * V2.5 Command Center: when present, the page promotes the Review
   * Packet (handoff summary, validation, risks, merge readiness) above
   * the Timeline. Legacy runs without a stored report fall back to the
   * Timeline-first layout.
   */
  report?: RunReportArtifact;
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
  report,
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
          {run.latestCiStatus ? (
            <Field label="Latest CI">
              <div className="flex items-center gap-2">
                <Badge
                  tone={CI_TONES[run.latestCiStatus]}
                  aria-label={`latest ci ${run.latestCiStatus}`}
                >
                  CI {run.latestCiStatus}
                </Badge>
                {run.latestCiCheckedAt ? (
                  <time
                    dateTime={run.latestCiCheckedAt}
                    className="font-mono text-xs text-slate-500"
                  >
                    {run.latestCiCheckedAt}
                  </time>
                ) : null}
              </div>
            </Field>
          ) : null}
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

      {report ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Review Packet
          </h2>
          <ReviewPacket report={report} />
        </section>
      ) : (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          This is a legacy run without a generated report. Timeline and logs
          remain available below.
        </p>
      )}

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

      {run.latestReviewFeedback ? (
        <ReviewFeedbackPanel summary={run.latestReviewFeedback} />
      ) : null}
    </main>
  );
}

const REVIEW_BODY_TRUNCATE_LIMIT = 200;

function truncateBody(body: string): string {
  if (body.length <= REVIEW_BODY_TRUNCATE_LIMIT) return body;
  return `${body.slice(0, REVIEW_BODY_TRUNCATE_LIMIT)}…`;
}

function ReviewFeedbackPanel({
  summary,
}: {
  summary: ReviewFeedbackSummary;
}) {
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="review-feedback-heading"
    >
      <h2
        id="review-feedback-heading"
        className="text-sm font-semibold uppercase tracking-wide text-slate-500"
      >
        Latest review feedback
      </h2>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle className="text-sm">
            MR !{summary.mrIid}{" "}
            <a
              href={summary.mrUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono text-xs text-sky-700 hover:underline"
            >
              open
            </a>
          </CardTitle>
          <div className="flex flex-col items-end gap-1 text-xs text-slate-500">
            <span>
              swept at{" "}
              <time dateTime={summary.generatedAt} className="font-mono">
                {summary.generatedAt}
              </time>
            </span>
            <span>
              cursor{" "}
              <time dateTime={summary.cursor} className="font-mono">
                {summary.cursor}
              </time>
            </span>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {summary.comments.length === 0 ? (
            <p className="text-slate-500">
              No new reviewer comments since the last sweep.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {summary.comments.map((comment) => (
                <li
                  key={comment.noteId}
                  className="flex flex-col gap-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-700">
                        @{comment.author}
                      </span>
                      <time
                        dateTime={comment.createdAt}
                        className="font-mono text-slate-500"
                      >
                        {comment.createdAt}
                      </time>
                      {comment.resolved ? (
                        <Badge
                          tone="success"
                          aria-label={`note ${comment.noteId} resolved`}
                        >
                          resolved
                        </Badge>
                      ) : null}
                    </div>
                    <a
                      href={comment.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-xs text-sky-700 hover:underline"
                      aria-label={`open note ${comment.noteId} on GitLab`}
                    >
                      view
                    </a>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-slate-800">
                    {truncateBody(comment.body)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
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
