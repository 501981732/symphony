import type {
  MergeReadinessStatus,
  PipelineStatus,
  RunStatus,
} from "@issuepilot/shared-contracts";
import type { ReactNode } from "react";


import { cn } from "../../lib/cn";

import { Badge, type BadgeTone } from "./badge";

/**
 * Centralized run-status → tone map used by every list / detail
 * view. Whenever a new RunStatus lands we update this table once.
 */
export const RUN_STATUS_TONES: Record<RunStatus, BadgeTone> = {
  claimed: "info",
  running: "info",
  retrying: "warning",
  stopping: "warning",
  completed: "success",
  failed: "danger",
  blocked: "violet",
};

export const READINESS_TONES: Record<MergeReadinessStatus, BadgeTone> = {
  ready: "success",
  "not-ready": "warning",
  blocked: "danger",
  unknown: "neutral",
};

export const PIPELINE_TONES: Record<PipelineStatus, BadgeTone> = {
  success: "success",
  failed: "danger",
  running: "info",
  pending: "info",
  canceled: "warning",
  unknown: "neutral",
};

export function statusAccentVar(tone: BadgeTone): string {
  return `var(--color-${tone === "neutral" ? "border-strong" : tone})`;
}

/**
 * Status dot — pairs with text so meaning is conveyed by both
 * color and label (matches §1 `color-not-only`).
 */
export function StatusDot({
  tone,
  className,
  label,
}: {
  tone: BadgeTone;
  label?: string;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        className,
      )}
      style={{ backgroundColor: `hsl(${statusAccentVar(tone)})` }}
    />
  );
}

interface StatusPillProps {
  tone: BadgeTone;
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}

export function StatusPill({
  tone,
  children,
  className,
  "aria-label": ariaLabel,
}: StatusPillProps) {
  return (
    <Badge tone={tone} className={cn("gap-1.5", className)} aria-label={ariaLabel}>
      <StatusDot tone={tone} />
      {children}
    </Badge>
  );
}
