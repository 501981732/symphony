import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

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
}

export interface TeamSchedulerConfig {
  maxConcurrentRuns: number;
  maxConcurrentRunsPerProject: number;
  leaseTtlMs: number;
  pollIntervalMs: number;
}

export interface TeamRetentionConfig {
  successfulRunDays: number;
  failedRunDays: number;
  maxWorkspaceGb: number;
}

export interface TeamConfig {
  version: 1;
  server: { host: string; port: number };
  scheduler: TeamSchedulerConfig;
  projects: TeamProjectConfig[];
  retention: TeamRetentionConfig;
  source: { path: string; sha256: string; loadedAt: string };
}

const projectIdPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const rawProjectSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(projectIdPattern, "must be lowercase letters, digits and hyphens"),
  name: z.string().min(1),
  workflow: z.string().min(1),
  enabled: z.boolean().optional(),
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
  })
  .optional();

const rawConfigSchema = z.object({
  version: z.literal(1),
  server: rawServerSchema,
  scheduler: rawSchedulerSchema,
  projects: z.array(rawProjectSchema).min(1),
  retention: rawRetentionSchema,
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
  }));

  const scheduler: TeamSchedulerConfig = {
    maxConcurrentRuns: parsed.scheduler?.max_concurrent_runs ?? 2,
    maxConcurrentRunsPerProject:
      parsed.scheduler?.max_concurrent_runs_per_project ?? 1,
    leaseTtlMs: parsed.scheduler?.lease_ttl_ms ?? 900_000,
    pollIntervalMs: parsed.scheduler?.poll_interval_ms ?? 10_000,
  };

  const retention: TeamRetentionConfig = {
    successfulRunDays: parsed.retention?.successful_run_days ?? 7,
    // Defaults mirror V2 spec §6/§11: failed/blocked workspaces stay for 30
    // days to preserve failure forensics; max workspace usage caps at 50GB
    // before the retention sweep starts trimming oldest terminal runs.
    failedRunDays: parsed.retention?.failed_run_days ?? 30,
    maxWorkspaceGb: parsed.retention?.max_workspace_gb ?? 50,
  };

  return {
    version: 1,
    server: {
      host: parsed.server?.host ?? "127.0.0.1",
      port: parsed.server?.port ?? 4738,
    },
    scheduler,
    projects,
    retention,
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
