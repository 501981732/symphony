import type {
  EventType,
  IssuePilotEvent,
} from "@issuepilot/shared-contracts";
import { useMemo } from "react";


import { Badge, type BadgeTone } from "../ui/badge";

const TONE_BY_TYPE: Partial<Record<EventType, BadgeTone>> = {
  run_started: "info",
  run_completed: "success",
  run_failed: "danger",
  run_blocked: "violet",
  claim_succeeded: "info",
  claim_failed: "danger",
  workspace_ready: "info",
  workspace_failed: "danger",
  session_started: "info",
  turn_started: "info",
  turn_completed: "success",
  turn_failed: "danger",
  turn_cancelled: "warning",
  turn_timeout: "warning",
  tool_call_started: "neutral",
  tool_call_completed: "success",
  tool_call_failed: "danger",
  unsupported_tool_call: "warning",
  approval_required: "warning",
  approval_auto_approved: "info",
  turn_input_required: "warning",
  notification: "neutral",
  malformed_message: "danger",
  port_exit: "danger",
  gitlab_push: "info",
  gitlab_mr_created: "info",
  gitlab_mr_updated: "info",
  gitlab_note_created: "info",
  gitlab_note_updated: "info",
  gitlab_labels_transitioned: "info",
  reconciliation_started: "info",
  reconciliation_completed: "success",
  retry_scheduled: "warning",
};

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

interface EventTimelineProps {
  events: IssuePilotEvent[];
}

export function EventTimeline({ events }: EventTimelineProps) {
  const sorted = useMemo(() => {
    const next = [...events];
    next.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return next;
  }, [events]);

  if (sorted.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center text-sm text-slate-500">
        No events yet for this run.
      </div>
    );
  }

  return (
    <ol className="flex flex-col gap-2">
      {sorted.map((event) => (
        <li
          key={event.id}
          className="rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm"
        >
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className="font-mono tabular-nums text-slate-400">
              {formatTime(event.createdAt)}
            </span>
            <Badge tone={TONE_BY_TYPE[event.type] ?? "neutral"}>
              {event.type}
            </Badge>
            {event.threadId && (
              <span className="font-mono text-[10px] text-slate-400">
                thread {event.threadId}
              </span>
            )}
            {event.turnId && (
              <span className="font-mono text-[10px] text-slate-400">
                turn {event.turnId}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-slate-800">{event.message}</p>
          {event.data !== undefined && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-slate-500">
                data
              </summary>
              <pre className="mt-1 max-h-64 overflow-auto rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-700">
                {JSON.stringify(event.data, null, 2)}
              </pre>
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}
