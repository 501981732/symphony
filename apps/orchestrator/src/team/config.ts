import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  DEFAULT_RETENTION_CONFIG,
  type RetentionConfig,
} from "@issuepilot/shared-contracts";
import * as YAML from "yaml";
import { z, ZodError } from "zod";

/**
 * Error thrown when an `issuepilot.team.yaml` file fails to parse, fails
 * schema validation, or violates a structural rule the V2 spec considers
 * fatal at startup (e.g. duplicate project ids).
 *
 * `path` is a dotted path into the parsed document so callers and tests can
 * pinpoint the offending section without re-running YAML parsing.
 */
export class TeamConfigError extends Error {
  override readonly name = "TeamConfigError";
  constructor(
    message: string,
    public readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface TeamProjectConfig {
  id: string;
  name: string;
  workflowPath: string;
  enabled: boolean;
  /**
   * Optional per-project CI override. Wins over the team-wide
   * {@link TeamConfig.ci} block when both are set. `null` (the absence
   * of the section under `projects[].ci`) means "fall back to team
   * {@link TeamConfig.ci}, then to the project's WORKFLOW.md `ci`".
   *
   * Partial overrides are *not* supported in this revision: the project
   * either supplies all three keys (`enabled`, `on_failure`,
   * `wait_for_pipeline`) or relies on the lower-precedence fallbacks
   * for every key. This keeps the precedence rules and the schema flat
   * — see {@link createProjectRegistry} for the resolution algorithm.
   */
  ci: TeamCiConfig | null;
}

export interface TeamSchedulerConfig {
  maxConcurrentRuns: number;
  maxConcurrentRunsPerProject: number;
  leaseTtlMs: number;
  pollIntervalMs: number;
}

/**
 * Alias kept for backward compatibility with V2 Phase 1 callers; the
 * canonical shape now lives in `@issuepilot/shared-contracts` so the
 * workspace planner and workflow parser can reference it without
 * pulling the orchestrator package in.
 */
export type TeamRetentionConfig = RetentionConfig;

/**
 * Team-wide CI feedback override. When `enabled` is `true`, the V2
 * daemon's reconciliation loop runs the CI feedback scanner regardless
 * of per-workflow defaults. `null` (the absence of the `ci` section)
 * means "fall back to each project's WORKFLOW.md `ci` block" so an
 * existing team config doesn't suddenly start polling pipelines after
 * an orchestrator upgrade.
 */
export interface TeamCiConfig {
  enabled: boolean;
  onFailure: "ai-rework" | "human-review";
  waitForPipeline: boolean;
}

export interface TeamConfig {
  version: 1;
  server: { host: string; port: number };
  scheduler: TeamSchedulerConfig;
  projects: TeamProjectConfig[];
  retention: RetentionConfig;
  /**
   * Optional team-wide CI override; `null` means defer to per-workflow
   * `ci` section.
   */
  ci: TeamCiConfig | null;
  source: { path: string; sha256: string; loadedAt: string };
}

const projectIdPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const rawProjectCiSchema = z
  .object({
    enabled: z.boolean().optional(),
    on_failure: z.enum(["ai-rework", "human-review"]).optional(),
    wait_for_pipeline: z.boolean().optional(),
  })
  .optional();

const rawProjectSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(projectIdPattern, "must be lowercase letters, digits and hyphens"),
  name: z.string().min(1),
  workflow: z.string().min(1),
  enabled: z.boolean().optional(),
  ci: rawProjectCiSchema,
});

const rawSchedulerSchema = z
  .object({
    max_concurrent_runs: z.number().int().min(1).max(5).optional(),
    max_concurrent_runs_per_project: z.number().int().min(1).max(5).optional(),
    lease_ttl_ms: z.number().int().min(60_000).optional(),
    poll_interval_ms: z.number().int().min(1_000).optional(),
  })
  .optional();

const rawServerSchema = z
  .object({
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
  })
  .optional();

const rawRetentionSchema = z
  .object({
    successful_run_days: z.number().int().min(0).optional(),
    failed_run_days: z.number().int().min(0).optional(),
    max_workspace_gb: z.number().min(0).optional(),
    cleanup_interval_ms: z.number().int().min(60_000).optional(),
  })
  .optional();

const rawCiSchema = z
  .object({
    enabled: z.boolean().optional(),
    on_failure: z.enum(["ai-rework", "human-review"]).optional(),
    wait_for_pipeline: z.boolean().optional(),
  })
  .optional();

const rawConfigSchema = z.object({
  version: z.literal(1),
  server: rawServerSchema,
  scheduler: rawSchedulerSchema,
  projects: z.array(rawProjectSchema).min(1),
  retention: rawRetentionSchema,
  ci: rawCiSchema,
});

function camelToSnake(segment: string): string {
  return segment.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

// zod v4 reports issues using the JS field names from the parsed schema
// (camelCase after our normalisation), but our YAML keys are snake_case. We
// convert every string segment so error messages always point at the actual
// field in `issuepilot.team.yaml`, including new fields added later without
// updating a hard-coded translation list.
function humanisePath(issuePath: ReadonlyArray<PropertyKey>): string {
  return issuePath
    .map((p) => {
      if (typeof p === "number") return String(p);
      const s = String(p);
      // Preserve already-snake fields and pure digit indices verbatim.
      if (/^[a-z0-9_]+$/.test(s)) return s;
      return camelToSnake(s);
    })
    .join(".");
}

function ensureNoDuplicateProjectIds(
  projects: ReadonlyArray<{ id: string }>,
): void {
  const seen = new Set<string>();
  for (const project of projects) {
    if (seen.has(project.id)) {
      throw new TeamConfigError(
        `duplicate project id: ${project.id}`,
        "projects",
      );
    }
    seen.add(project.id);
  }
}

/**
 * Parse a raw `issuepilot.team.yaml` payload into a normalised
 * {@link TeamConfig}. Relative workflow paths are resolved against the
 * directory that owns `configPath` so callers downstream can treat them as
 * absolute.
 */
export function parseTeamConfig(raw: string, configPath: string): TeamConfig {
  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (err) {
    throw new TeamConfigError(
      `failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
      "(yaml)",
      { cause: err },
    );
  }

  let parsed: z.infer<typeof rawConfigSchema>;
  try {
    parsed = rawConfigSchema.parse(doc);
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const issuePath = first ? humanisePath(first.path) : "(root)";
      const message = first?.message ?? "invalid team config";
      throw new TeamConfigError(`${issuePath}: ${message}`, issuePath, {
        cause: err,
      });
    }
    throw err;
  }

  ensureNoDuplicateProjectIds(parsed.projects);

  const configDir = path.dirname(configPath);
  const projects: TeamProjectConfig[] = parsed.projects.map((p) => ({
    id: p.id,
    name: p.name,
    workflowPath: path.isAbsolute(p.workflow)
      ? p.workflow
      : path.resolve(configDir, p.workflow),
    enabled: p.enabled ?? true,
    ci: p.ci
      ? {
          enabled: p.ci.enabled ?? false,
          onFailure: p.ci.on_failure ?? "ai-rework",
          waitForPipeline: p.ci.wait_for_pipeline ?? true,
        }
      : null,
  }));

  const scheduler: TeamSchedulerConfig = {
    maxConcurrentRuns: parsed.scheduler?.max_concurrent_runs ?? 2,
    maxConcurrentRunsPerProject:
      parsed.scheduler?.max_concurrent_runs_per_project ?? 1,
    leaseTtlMs: parsed.scheduler?.lease_ttl_ms ?? 900_000,
    pollIntervalMs: parsed.scheduler?.poll_interval_ms ?? 10_000,
  };

  // Defaults mirror V2 spec §6/§11 via DEFAULT_RETENTION_CONFIG: failed /
  // blocked workspaces stay 30 days to preserve failure forensics, max
  // workspace usage caps at 50GB before the sweep starts trimming the
  // oldest terminal runs, and cleanup runs at most once an hour (60s
  // floor enforced by zod so the daemon can't be turned into a `du` storm).
  const retention: RetentionConfig = {
    successfulRunDays:
      parsed.retention?.successful_run_days ??
      DEFAULT_RETENTION_CONFIG.successfulRunDays,
    failedRunDays:
      parsed.retention?.failed_run_days ??
      DEFAULT_RETENTION_CONFIG.failedRunDays,
    maxWorkspaceGb:
      parsed.retention?.max_workspace_gb ??
      DEFAULT_RETENTION_CONFIG.maxWorkspaceGb,
    cleanupIntervalMs:
      parsed.retention?.cleanup_interval_ms ??
      DEFAULT_RETENTION_CONFIG.cleanupIntervalMs,
  };

  const ci: TeamCiConfig | null = parsed.ci
    ? {
        enabled: parsed.ci.enabled ?? false,
        onFailure: parsed.ci.on_failure ?? "ai-rework",
        waitForPipeline: parsed.ci.wait_for_pipeline ?? true,
      }
    : null;

  return {
    version: 1,
    server: {
      host: parsed.server?.host ?? "127.0.0.1",
      port: parsed.server?.port ?? 4738,
    },
    scheduler,
    projects,
    retention,
    ci,
    source: {
      path: configPath,
      sha256: crypto.createHash("sha256").update(raw).digest("hex"),
      loadedAt: new Date().toISOString(),
    },
  };
}

/**
 * Read the YAML file at `configPath` from disk and run it through
 * {@link parseTeamConfig}. `configPath` is resolved to an absolute path
 * before parsing so the returned `source.path` stays canonical.
 */
export async function loadTeamConfig(configPath: string): Promise<TeamConfig> {
  const resolvedPath = path.resolve(configPath);
  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, "utf8");
  } catch (err) {
    throw new TeamConfigError(
      `failed to read team config: ${err instanceof Error ? err.message : String(err)}`,
      "",
      { cause: err },
    );
  }
  return parseTeamConfig(raw, resolvedPath);
}
