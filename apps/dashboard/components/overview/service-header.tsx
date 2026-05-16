import type { OrchestratorStateSnapshot } from "@issuepilot/shared-contracts";

import { Badge, type BadgeTone } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

const STATUS_TONES: Record<
  OrchestratorStateSnapshot["service"]["status"],
  BadgeTone
> = {
  starting: "info",
  ready: "success",
  degraded: "warning",
  stopping: "neutral",
};

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    // Use a stable UTC representation so server-rendered and client-hydrated
    // markup match exactly. `toLocaleString()` reads the runtime's TZ +
    // locale, which differs between Node and browser and triggers React
    // hydration mismatch warnings — same fix as ProjectList.formatLastPoll
    // (V2 review I6 + pre-existing hydration follow-up).
    return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
  } catch {
    return value;
  }
}

interface ServiceHeaderProps {
  snapshot: OrchestratorStateSnapshot;
}

export function ServiceHeader({ snapshot }: ServiceHeaderProps) {
  const { service } = snapshot;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Service</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-3">
        <Field label="Status">
          <Badge tone={STATUS_TONES[service.status]}>{service.status}</Badge>
        </Field>
        <Field label="GitLab project">{service.gitlabProject}</Field>
        <Field label="Concurrency">{service.concurrency}</Field>
        <Field label="Poll interval">{service.pollIntervalMs} ms</Field>
        <Field label="Workflow path">
          <span className="break-all font-mono text-xs text-slate-700">
            {service.workflowPath}
          </span>
        </Field>
        <Field label="Last config reload">
          {formatTimestamp(service.lastConfigReloadAt)}
        </Field>
        <Field label="Last poll">{formatTimestamp(service.lastPollAt)}</Field>
        {typeof service.workspaceUsageGb === "number" ? (
          <Field label="Workspace usage">
            {`${formatGb(service.workspaceUsageGb)} GB`}
          </Field>
        ) : null}
        {typeof service.nextCleanupAt === "string" ? (
          <Field label="Next cleanup">
            {formatTimestamp(service.nextCleanupAt)}
          </Field>
        ) : null}
      </CardContent>
    </Card>
  );
}

function formatGb(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
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
