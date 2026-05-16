import {
  DASHBOARD_SUMMARY_VALUES,
  type DashboardSummary,
  type DashboardSummaryKey,
} from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";

import type { BadgeTone } from "../ui/badge";
import { Card } from "../ui/card";
import { StatusDot } from "../ui/status";

const TONES: Record<DashboardSummaryKey, BadgeTone> = {
  running: "info",
  retrying: "warning",
  "human-review": "success",
  failed: "danger",
  blocked: "violet",
};

interface SummaryCardsProps {
  summary: DashboardSummary;
}

/**
 * Compact health-at-a-glance bar.
 *
 * Replaces the previous five large kpi cards (one per status) with
 * a single Card that combines:
 *   1. A total count + section caption
 *   2. A horizontal stacked bar that visualizes the proportional mix
 *      across the five lifecycle states — operators can spot a
 *      healthy queue (mostly green/blue) vs a stuck one (red/violet)
 *      in one glance instead of mentally summing five numbers.
 *   3. A chip row showing each status' exact count, paired with a
 *      colored dot so meaning is conveyed by both color and label
 *      (rule §1 `color-not-only`).
 *
 * The previous kpi grid burned ~120px of vertical space per row at
 * `text-3xl`; this version condenses that into ~96px and frees the
 * fold for the actual run list.
 */
export function SummaryCards({ summary }: SummaryCardsProps) {
  const t = useTranslations("summary");
  const total = DASHBOARD_SUMMARY_VALUES.reduce(
    (acc, key) => acc + (summary[key] ?? 0),
    0,
  );

  return (
    <Card className="flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-base font-semibold tracking-tight text-fg">
          {t("title")}
        </h2>
        <p className="font-mono text-xs text-fg-muted">
          {t("totalLabel", { total })}
        </p>
      </div>

      <StackedBar summary={summary} total={total} />

      <ul
        role="list"
        className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3 md:grid-cols-5"
      >
        {DASHBOARD_SUMMARY_VALUES.map((status) => {
          const tone = TONES[status];
          const value = summary[status] ?? 0;
          return (
            <li
              key={status}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs"
            >
              <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-fg-muted">
                <StatusDot tone={tone} />
                {status}
              </span>
              <span className="font-mono text-sm font-semibold tabular-nums text-fg">
                {value}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

interface StackedBarProps {
  summary: DashboardSummary;
  total: number;
}

function StackedBar({ summary, total }: StackedBarProps) {
  const t = useTranslations("summary");
  const trackLabel = t("trackAria");

  if (total === 0) {
    return (
      <div
        role="img"
        aria-label={t("trackEmptyAria")}
        className="h-2 w-full rounded-full bg-surface-2"
      />
    );
  }

  return (
    <div
      role="img"
      aria-label={trackLabel}
      className="flex h-2 w-full overflow-hidden rounded-full bg-surface-2"
    >
      {DASHBOARD_SUMMARY_VALUES.map((status) => {
        const count = summary[status] ?? 0;
        if (count === 0) return null;
        const tone = TONES[status];
        const pct = (count / total) * 100;
        return (
          <span
            key={status}
            aria-hidden="true"
            title={`${status}: ${count}`}
            className="block h-full"
            style={{
              width: `${pct}%`,
              backgroundColor: `hsl(var(--color-${tone}))`,
            }}
          />
        );
      })}
    </div>
  );
}
