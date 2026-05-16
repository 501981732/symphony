"use client";

import type { IssuePilotEvent } from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";

import { Badge, type BadgeTone } from "../ui/badge";

const TOOL_TONES: Record<string, BadgeTone> = {
  tool_call_started: "neutral",
  tool_call_completed: "success",
  tool_call_failed: "danger",
};

interface ToolCallListProps {
  events: IssuePilotEvent[];
}

export function ToolCallList({ events }: ToolCallListProps) {
  const t = useTranslations("toolCalls");
  const toolEvents = events.filter((e) => e.type.startsWith("tool_call_"));

  if (toolEvents.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border bg-surface px-4 py-3 text-xs text-fg-subtle">
        {t("empty")}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {toolEvents.map((event) => (
        <li
          key={event.id}
          className="flex flex-col gap-1 rounded-md border border-border bg-surface px-3 py-2 shadow-1"
        >
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <Badge tone={TOOL_TONES[event.type] ?? "neutral"}>
              {event.type}
            </Badge>
            <span className="font-mono text-[10px] text-fg-subtle">
              {event.turnId ? t("turn", { id: event.turnId }) : ""}
            </span>
          </div>
          <span className="text-sm text-fg">{event.message}</span>
        </li>
      ))}
    </ul>
  );
}
