import type { ProjectSummary } from "@issuepilot/shared-contracts";
import type { WorkflowConfig } from "@issuepilot/workflow";

import type { TeamConfig, TeamProjectConfig } from "./config.js";

/**
 * A project whose workflow loaded cleanly and is therefore eligible to be
 * polled by the team scheduler. Disabled or failed-to-load projects do not
 * appear here — they surface only in {@link ProjectRegistry.summaries}.
 */
export interface RegisteredProject {
  id: string;
  name: string;
  workflowPath: string;
  enabled: true;
  workflow: WorkflowConfig;
  lastPollAt: string | null;
  activeRuns: number;
}

/**
 * Minimal interface registered with the daemon shell so test doubles can
 * stub the workflow loader without depending on the full
 * `@issuepilot/workflow` loader facade.
 */
export interface WorkflowLoaderLike {
  loadOnce(workflowPath: string): Promise<WorkflowConfig>;
}

export interface ProjectRegistry {
  enabledProjects(): RegisteredProject[];
  project(projectId: string): RegisteredProject | undefined;
  summaries(): ProjectSummary[];
  updateProjectPoll(projectId: string, at: string): void;
  updateProjectActiveRuns(projectId: string, activeRuns: number): void;
}

interface RegistryEntry {
  config: TeamProjectConfig;
  state:
    | {
        kind: "enabled";
        project: RegisteredProject;
      }
    | {
        kind: "disabled";
        reason: "config" | "load-error";
        lastError?: string;
      };
}

export async function createProjectRegistry(
  config: TeamConfig,
  workflowLoader: WorkflowLoaderLike,
): Promise<ProjectRegistry> {
  const entries: RegistryEntry[] = [];

  for (const projectConfig of config.projects) {
    if (!projectConfig.enabled) {
      entries.push({
        config: projectConfig,
        state: { kind: "disabled", reason: "config" },
      });
      continue;
    }

    try {
      const workflow = await workflowLoader.loadOnce(projectConfig.workflowPath);
      entries.push({
        config: projectConfig,
        state: {
          kind: "enabled",
          project: {
            id: projectConfig.id,
            name: projectConfig.name,
            workflowPath: projectConfig.workflowPath,
            enabled: true,
            workflow,
            lastPollAt: null,
            activeRuns: 0,
          },
        },
      });
    } catch (err) {
      entries.push({
        config: projectConfig,
        state: {
          kind: "disabled",
          reason: "load-error",
          lastError: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  function summaryFor(entry: RegistryEntry): ProjectSummary {
    if (entry.state.kind === "enabled") {
      const project = entry.state.project;
      return {
        id: project.id,
        name: project.name,
        workflowPath: project.workflowPath,
        gitlabProject: project.workflow.tracker.projectId,
        enabled: true,
        activeRuns: project.activeRuns,
        lastPollAt: project.lastPollAt,
      };
    }
    const base: ProjectSummary = {
      id: entry.config.id,
      name: entry.config.name,
      workflowPath: entry.config.workflowPath,
      gitlabProject: "",
      enabled: false,
      activeRuns: 0,
      lastPollAt: null,
    };
    if (entry.state.lastError) base.lastError = entry.state.lastError;
    return base;
  }

  return {
    enabledProjects() {
      return entries
        .filter(
          (e): e is RegistryEntry & { state: { kind: "enabled" } } =>
            e.state.kind === "enabled",
        )
        .map((e) => e.state.project);
    },
    project(projectId) {
      const entry = entries.find((e) => e.config.id === projectId);
      if (!entry || entry.state.kind !== "enabled") return undefined;
      return entry.state.project;
    },
    summaries() {
      return entries.map(summaryFor);
    },
    updateProjectPoll(projectId, at) {
      const entry = entries.find((e) => e.config.id === projectId);
      if (entry && entry.state.kind === "enabled") {
        entry.state.project.lastPollAt = at;
      }
    },
    updateProjectActiveRuns(projectId, activeRuns) {
      const entry = entries.find((e) => e.config.id === projectId);
      if (entry && entry.state.kind === "enabled") {
        entry.state.project.activeRuns = activeRuns;
      }
    },
  };
}
