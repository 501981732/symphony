import type { ProjectSummary } from "@issuepilot/shared-contracts";

import { Badge } from "../ui/badge";
import { Card } from "../ui/card";

interface ProjectListProps {
  projects: ProjectSummary[];
}

function formatLastPoll(value: string | null): string {
  if (!value) return "not polled";
  return new Date(value).toLocaleString();
}

export function ProjectList({ projects }: ProjectListProps) {
  if (projects.length === 0) {
    return (
      <Card className="p-4 text-sm text-slate-500">
        No team projects configured.
      </Card>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {projects.map((project) => (
        <Card key={project.id} className="flex flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-slate-900">
                {project.name}
              </h3>
              <p className="truncate text-xs text-slate-500">
                {project.gitlabProject || project.workflowPath}
              </p>
            </div>
            <Badge tone={project.enabled ? "info" : "neutral"}>
              {project.enabled ? `${project.activeRuns} active` : "disabled"}
            </Badge>
          </div>
          <div className="text-xs text-slate-500">
            Last poll: {formatLastPoll(project.lastPollAt)}
          </div>
          {project.lastError && (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {project.lastError}
            </p>
          )}
        </Card>
      ))}
    </div>
  );
}
