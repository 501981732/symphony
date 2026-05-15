import type { ProjectSummary } from "@issuepilot/shared-contracts";
import type { CiConfig, WorkflowConfig } from "@issuepilot/workflow";

import type {
  TeamCiConfig,
  TeamConfig,
  TeamProjectConfig,
} from "./config.js";

/**
 * Resolve the effective CI feedback configuration for a single
 * project. Precedence (lowest to highest), each layer fully replaces
 * the previous when set:
 *
 *   1. `workflow.ci` (from the project's WORKFLOW.md; always present)
 *   2. `teamCi` (top-level `ci` block in `issuepilot.team.yaml`)
 *   3. `projectCi` (`projects[].ci` in `issuepilot.team.yaml`)
 *
 * Each override replaces all three keys atomically — partial merges
 * are intentionally out of scope (see {@link TeamProjectConfig.ci}).
 * This keeps the precedence story simple and avoids "I set
 * `enabled: true` at team level but the project's workflow defaults
 * silently disabled it" surprises.
 */
export function resolveEffectiveCi(
  workflowCi: CiConfig,
  teamCi: TeamCiConfig | null,
  projectCi: TeamCiConfig | null,
): CiConfig {
  if (projectCi) return { ...projectCi };
  if (teamCi) return { ...teamCi };
  return { ...workflowCi };
}

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
      const loadedWorkflow = await workflowLoader.loadOnce(
        projectConfig.workflowPath,
      );
      const effectiveCi = resolveEffectiveCi(
        loadedWorkflow.ci,
        config.ci,
        projectConfig.ci,
      );
      // Replace the workflow's `ci` block with the effective one so the
      // rest of the orchestrator (scanCiFeedbackOnce, dashboard, etc.)
      // can treat `workflow.ci` as the source of truth without needing
      // to know about team / project overrides.
      const workflow: WorkflowConfig = {
        ...loadedWorkflow,
        ci: effectiveCi,
      };
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
      disabledReason: entry.state.reason,
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
