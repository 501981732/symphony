"use client";

import type { OrchestratorStateSnapshot } from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { type BadgeTone } from "../ui/badge";
import { StatusPill } from "../ui/status";

const STATUS_TONES: Record<
  OrchestratorStateSnapshot["service"]["status"],
  BadgeTone
> = {
  starting: "info",
  ready: "success",
  degraded: "warning",
  stopping: "neutral",
};

function formatTimestamp(value: string | null, dash: string): string {
  if (!value) return dash;
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    // Use a stable UTC representation so server-rendered and client-hydrated
    // markup match exactly. `toLocaleString()` reads the runtime's TZ +
    // locale, which differs between Node and browser and triggers React
    // hydration mismatch warnings — same fix as ProjectList.formatLastPoll
    // (V2 review I6 + pre-existing hydration follow-up).
    return d
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "Z");
  } catch {
    return value;
  }
}

interface ServiceHeaderProps {
  snapshot: OrchestratorStateSnapshot;
}

/**
 * Service status strip.
 *
 * Tier 1 (always visible): the things operators monitor every minute —
 *   service status, GitLab project, concurrency, poll interval,
 *   workflow path, and last poll timestamp.
 *
 * Tier 2 (collapsible): forensic / one-time-config metadata that
 *   doesn't earn permanent first-fold real estate — last config reload,
 *   workspace usage, next cleanup. Hidden behind a "more details"
 *   toggle so the strip stays compact on busy 1280–1440px laptops.
 */
export function ServiceHeader({ snapshot }: ServiceHeaderProps) {
  const { service } = snapshot;
  const t = useTranslations("service");
  const dash = useTranslations("common")("dash");
  const [expanded, setExpanded] = useState(false);

  // `lastConfigReloadAt` is always part of the snapshot (nullable
  // string), so tier 2 always has at least one row to disclose. The
  // workspace usage + next cleanup rows only appear when populated.
  const hasTier2 = true;

  return (
    <section
      aria-label={t("areaLabel")}
      className="rounded-lg border border-border bg-surface shadow-1"
    >
      <div className="flex flex-col gap-4 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
            {t("statusLabel")}
          </span>
          <div className="flex items-center gap-3">
            <StatusPill tone={STATUS_TONES[service.status]}>
              {service.status}
            </StatusPill>
            <span className="font-mono text-sm text-fg">
              {service.gitlabProject}
            </span>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs md:grid-cols-3 lg:grid-cols-5">
          <Field label={t("concurrency")} mono>
            {service.concurrency}
          </Field>
          <Field label={t("pollInterval")} mono>
            {t("pollIntervalUnit", { value: service.pollIntervalMs })}
          </Field>
          <Field label={t("workflow")} className="md:col-span-2 lg:col-span-2">
            <span
              className="block truncate font-mono text-xs text-fg"
              title={service.workflowPath}
              dir="rtl"
            >
              {/* `dir=rtl` keeps the most-meaningful tail of the path
                  (the file name, e.g. `WORKFLOW.md`) visible when the
                  cell is too narrow, instead of cutting off the file
                  name like `…/workflo`. The full path remains in the
                  native tooltip via `title=`. */}
              <bdo dir="ltr">{service.workflowPath}</bdo>
            </span>
          </Field>
          <Field label={t("lastPoll")} mono>
            {formatTimestamp(service.lastPollAt, dash)}
          </Field>
        </dl>
      </div>
      {hasTier2 ? (
        <>
          <div className="flex items-center justify-end border-t border-border/60 px-5 py-1">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {expanded ? t("collapse") : t("expand")}
              <Chevron expanded={expanded} />
            </button>
          </div>
          {expanded ? (
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-border/60 bg-surface-2/40 px-5 py-3 text-[11px] md:grid-cols-3">
              <Field label={t("lastConfigReload")} mono small>
                {formatTimestamp(service.lastConfigReloadAt, dash)}
              </Field>
              {typeof service.workspaceUsageGb === "number" ? (
                <Field label={t("workspaceUsage")} mono small>
                  {t("workspaceUsageUnit", {
                    value: formatGb(service.workspaceUsageGb),
                  })}
                </Field>
              ) : null}
              {typeof service.nextCleanupAt === "string" ? (
                <Field label={t("nextCleanup")} mono small>
                  {formatTimestamp(service.nextCleanupAt, dash)}
                </Field>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={10}
      height={10}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform duration-150 ${expanded ? "rotate-180" : "rotate-0"}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
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
  mono,
  small,
  className,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
  small?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-0.5 ${className ?? ""}`}>
      <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-subtle">
        {label}
      </dt>
      <dd
        className={`${mono ? "font-mono" : ""} ${small ? "text-[11px]" : "text-sm"} text-fg`}
      >
        {children}
      </dd>
    </div>
  );
}
