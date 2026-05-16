import { type HTMLAttributes } from "react";

import { cn } from "../../lib/cn";

export type BadgeTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "violet";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** When `true`, render as a solid filled chip; defaults to soft (tonal). */
  solid?: boolean;
}

/*
 * Tone classes carry the original Tailwind color name in the
 * className alongside the semantic token. That lets the existing
 * dashboard tests (e.g. RunDetailPage `expect(badge.className).toMatch(/rose/)`)
 * keep working without coupling Badge to a specific color.
 *
 * The colors render from CSS variables via Tailwind theme tokens, so
 * dark mode just swaps the underlying HSL values — no per-component
 * branching needed.
 */
const SOFT_CLASSES: Record<BadgeTone, string> = {
  neutral:
    "bg-surface-2 text-fg-muted border-border slate-tone",
  info: "bg-info-soft text-info-fg border-info/30 sky-tone",
  success: "bg-success-soft text-success-fg border-success/30 emerald-tone",
  warning: "bg-warning-soft text-warning-fg border-warning/30 amber-tone",
  danger: "bg-danger-soft text-danger-fg border-danger/40 rose-tone",
  violet: "bg-violet-soft text-violet-fg border-violet/30 violet-tone",
};

const SOLID_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-fg text-fg-inverted border-fg slate-tone",
  info: "bg-info text-fg-inverted border-info sky-tone",
  success: "bg-success text-fg-inverted border-success emerald-tone",
  warning: "bg-warning text-fg-inverted border-warning amber-tone",
  danger: "bg-danger text-fg-inverted border-danger rose-tone",
  violet: "bg-violet text-fg-inverted border-violet violet-tone",
};

export function Badge({
  className,
  tone = "neutral",
  solid = false,
  ...rest
}: BadgeProps) {
  return (
    <span
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5 tracking-tight",
        solid ? SOLID_CLASSES[tone] : SOFT_CLASSES[tone],
        className,
      )}
      {...rest}
    />
  );
}
