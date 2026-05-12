import {
  DASHBOARD_SUMMARY_VALUES,
  type DashboardSummary,
  type DashboardSummaryKey,
} from "@issuepilot/shared-contracts";

import { cn } from "../../lib/cn";
import { Card, CardContent } from "../ui/card";

const HIGHLIGHT: Partial<Record<DashboardSummaryKey, string>> = {
  running: "text-sky-700",
  retrying: "text-amber-700",
  "human-review": "text-emerald-700",
  failed: "text-rose-700",
  blocked: "text-violet-700",
};

interface SummaryCardsProps {
  summary: DashboardSummary;
}

export function SummaryCards({ summary }: SummaryCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
      {DASHBOARD_SUMMARY_VALUES.map((status) => (
        <Card key={status}>
          <CardContent className="flex flex-col gap-1 pt-5">
            <span className="text-xs uppercase tracking-wide text-slate-500">
              {status}
            </span>
            <span
              className={cn(
                "text-2xl font-semibold tabular-nums text-slate-900",
                HIGHLIGHT[status],
              )}
            >
              {summary[status] ?? 0}
            </span>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
