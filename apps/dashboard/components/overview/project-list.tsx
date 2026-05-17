"use client";

import type { ProjectSummary } from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";

import { Badge } from "../ui/badge";
import { Card } from "../ui/card";

interface ProjectListProps {
  projects: ProjectSummary[];
}

function formatLastPoll(value: string | null, notPolled: string): string {
  if (!value) return notPolled;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  // Use a stable UTC representation so server-rendered and client-hydrated
  // markup match exactly. `toLocaleString()` reads the runtime's TZ + locale,
  // which differs between Node and browser and triggers a React hydration
  // mismatch warning (V2 review I6).
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function basename(filePath: string): string {
  if (!filePath) return "";
  const segments = filePath.split("/");
  return segments[segments.length - 1] ?? filePath;
}

export function ProjectList({ projects }: ProjectListProps) {
  const t = useTranslations("projects");
  if (projects.length === 0) {
    return (
      <Card className="p-4 text-sm text-fg-subtle">{t("empty")}</Card>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {projects.map((project) => {
        const profileName = basename(project.profilePath);
        const projectName = basename(project.projectPath);
        return (
          <Card key={project.id} className="flex flex-col gap-3 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-fg">
                  {project.name}
                </h3>
                <p className="truncate font-mono text-xs text-fg-subtle">
                  {project.gitlabProject || projectName}
                </p>
              </div>
              <Badge
                tone={
                  project.enabled
                    ? "info"
                    : project.disabledReason === "load-error"
                      ? "danger"
                      : "neutral"
                }
              >
                {project.enabled
                  ? t("active", { count: project.activeRuns })
                  : project.disabledReason === "load-error"
                    ? t("loadError")
                    : t("disabled")}
              </Badge>
            </div>
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 font-mono text-[11px] text-fg-subtle">
              <dt className="uppercase tracking-[0.16em]">{t("project")}</dt>
              <dd className="truncate text-fg" title={project.projectPath}>
                {projectName || project.projectPath}
              </dd>
              <dt className="uppercase tracking-[0.16em]">{t("profile")}</dt>
              <dd className="truncate text-fg" title={project.profilePath}>
                {profileName || project.profilePath}
              </dd>
            </dl>
            <div className="font-mono text-xs text-fg-subtle">
              {t("lastPoll", {
                value: formatLastPoll(project.lastPollAt, t("notPolled")),
              })}
            </div>
            {project.lastError && (
              <p className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger-fg">
                {project.lastError}
              </p>
            )}
          </Card>
        );
      })}
    </div>
  );
}
