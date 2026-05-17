import { readFile } from "node:fs/promises";

import matter from "gray-matter";
import YAML from "yaml";
import { z, ZodError } from "zod";

import { parseWorkflowString, WorkflowConfigError } from "./parse.js";
import type { WorkflowConfig } from "./types.js";

/**
 * Thrown when the central workflow config (team project file + workflow
 * profile) cannot be compiled into a valid effective {@link
 * WorkflowConfig}.
 *
 * `path` is a dotted path scoped to the central-config layer it came
 * from so the operator can tell whether they need to edit the project
 * file, the profile, or the resulting effective workflow:
 *
 *  - `project`              — the project file could not be read.
 *  - `profile`              — the workflow profile could not be read.
 *  - `project.<dotted>`     — schema/validation issue inside the
 *                             project file (e.g. `project.tracker.token_env`
 *                             rejects an attempt to override a high-risk
 *                             runtime field).
 *  - `profile.<dotted>`     — schema/validation issue inside the
 *                             profile's front matter.
 *  - `effective.<dotted>`   — the compiled WorkflowConfig itself failed
 *                             schema validation (e.g. profile + project
 *                             combined into something the workflow
 *                             parser rejects).
 */
export class CentralWorkflowConfigError extends Error {
  override readonly name = "CentralWorkflowConfigError";
  constructor(
    message: string,
    public readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Defaults block surfaced from `issuepilot.team.yaml` for use by the
 * central workflow compiler. `labelsPath` / `codexPath` are accepted for
 * forward-compat with policy files but are not consumed yet; the compiler
 * still uses `workspaceRoot` / `repoCacheRoot` to fill in the workspace
 * section of the effective workflow when the profile doesn't override it.
 */
export interface CentralWorkflowDefaults {
  labelsPath: string | null;
  codexPath: string | null;
  workspaceRoot: string;
  repoCacheRoot: string;
}

export interface CompileCentralWorkflowProjectInput {
  projectId: string;
  projectPath: string;
  workflowProfilePath: string;
  defaults: CentralWorkflowDefaults;
  /**
   * Virtual path recorded on the effective {@link WorkflowConfig}'s
   * `source.path`. Pointing this at a deterministic
   * `<configDir>/.generated/<projectId>.workflow.md` keeps `render-workflow`
   * output and dashboard "workflow source" rows reproducible without
   * actually persisting the generated text on disk.
   */
  generatedSourcePath: string;
}

// Project files only encode stable project facts and a small allow-list of
// runtime knobs. High-risk fields (tracker.token_env, codex.*, agent.runner,
// hooks) are intentionally absent so business repos cannot raise sandbox or
// swap the runner via project YAML — that's the "experiment-period runtime
// guardrail" surface called out in the design doc §7.
const ProjectFileSchema = z.strictObject({
  tracker: z.strictObject({
    kind: z.literal("gitlab"),
    base_url: z.string().url(),
    project_id: z.string().min(1),
  }),
  git: z.strictObject({
    repo_url: z.string().min(1),
    base_branch: z.string().min(1).default("main"),
    branch_prefix: z.string().min(1).default("ai"),
  }),
  agent: z
    .strictObject({
      max_turns: z.number().int().min(1).optional(),
      max_attempts: z.number().int().min(1).optional(),
      retry_backoff_ms: z.number().int().min(0).optional(),
    })
    .optional(),
  ci: z
    .strictObject({
      enabled: z.boolean().optional(),
      on_failure: z.enum(["ai-rework", "human-review"]).optional(),
      wait_for_pipeline: z.boolean().optional(),
    })
    .optional(),
});

// Profiles own everything the project file is not allowed to override:
// labels, runner identity, codex sandbox, hooks, ci defaults, poll cadence.
// All values are optional so a bare `---\n---\n` profile still compiles
// against the V1 workflow schema defaults.
const ProfileFrontMatterSchema = z.strictObject({
  tracker: z
    .strictObject({
      active_labels: z.array(z.string().min(1)).optional(),
      running_label: z.string().min(1).optional(),
      handoff_label: z.string().min(1).optional(),
      failed_label: z.string().min(1).optional(),
      blocked_label: z.string().min(1).optional(),
      rework_label: z.string().min(1).optional(),
      merging_label: z.string().min(1).optional(),
    })
    .optional(),
  agent: z
    .strictObject({
      runner: z.literal("codex-app-server").optional(),
      max_concurrent_agents: z.number().int().min(1).optional(),
      max_turns: z.number().int().min(1).optional(),
      max_attempts: z.number().int().min(1).optional(),
      retry_backoff_ms: z.number().int().min(0).optional(),
    })
    .optional(),
  codex: z
    .strictObject({
      command: z.string().min(1).optional(),
      approval_policy: z.enum(["never", "untrusted", "on-request"]).optional(),
      thread_sandbox: z.enum(["workspace-write", "read-only"]).optional(),
      turn_timeout_ms: z.number().int().min(1000).optional(),
      turn_sandbox_policy: z
        .strictObject({
          type: z.enum(["workspaceWrite", "readOnly"]).optional(),
        })
        .optional(),
    })
    .optional(),
  hooks: z
    .strictObject({
      after_create: z.string().min(1).optional(),
      before_run: z.string().min(1).optional(),
      after_run: z.string().min(1).optional(),
    })
    .optional(),
  ci: z
    .strictObject({
      enabled: z.boolean().optional(),
      on_failure: z.enum(["ai-rework", "human-review"]).optional(),
      wait_for_pipeline: z.boolean().optional(),
    })
    .optional(),
  poll_interval_ms: z.number().int().min(1000).optional(),
});

/**
 * Compile one team project (central project file + workflow profile +
 * team defaults) into the same {@link WorkflowConfig} shape the V1 single
 * workflow parser produces. The result is fed to the orchestrator,
 * GitLab tracker, workspace planner and runner unchanged so the team
 * runtime can keep consuming `WorkflowConfig` directly.
 *
 * The compiler intentionally does *not* persist the generated effective
 * workflow to disk — `generatedSourcePath` is a virtual location used
 * only for `source.path`, so `render-workflow` and the dashboard can
 * show a stable origin without touching the filesystem.
 */
export async function compileCentralWorkflowProject(
  input: CompileCentralWorkflowProjectInput,
): Promise<WorkflowConfig> {
  const [projectRaw, profileRaw] = await Promise.all([
    readText(input.projectPath, "project"),
    readText(input.workflowProfilePath, "profile"),
  ]);

  const project = parseProjectFile(projectRaw);
  const profile = parseProfileFile(profileRaw);

  // Build the equivalent of a V1 WORKFLOW.md front matter by merging
  // defaults + profile + project. Order matters: profile fills the
  // "runtime guardrail" fields first, then project facts overlay the
  // tracker / git surface they own. Anything not provided drops through
  // to the workflow parser's defaults (see WorkflowFrontMatterSchema).
  const frontMatter = {
    tracker: {
      kind: project.tracker.kind,
      base_url: project.tracker.base_url,
      project_id: project.tracker.project_id,
      active_labels: profile.data.tracker?.active_labels ?? [
        "ai-ready",
        "ai-rework",
      ],
      running_label: profile.data.tracker?.running_label ?? "ai-running",
      handoff_label: profile.data.tracker?.handoff_label ?? "human-review",
      failed_label: profile.data.tracker?.failed_label ?? "ai-failed",
      blocked_label: profile.data.tracker?.blocked_label ?? "ai-blocked",
      rework_label: profile.data.tracker?.rework_label ?? "ai-rework",
      merging_label: profile.data.tracker?.merging_label ?? "ai-merging",
    },
    workspace: {
      root: input.defaults.workspaceRoot,
      strategy: "worktree",
      repo_cache_root: input.defaults.repoCacheRoot,
    },
    git: project.git,
    agent: {
      runner: profile.data.agent?.runner ?? "codex-app-server",
      max_concurrent_agents: profile.data.agent?.max_concurrent_agents ?? 1,
      max_turns:
        project.agent?.max_turns ?? profile.data.agent?.max_turns ?? 10,
      max_attempts:
        project.agent?.max_attempts ?? profile.data.agent?.max_attempts ?? 2,
      retry_backoff_ms:
        project.agent?.retry_backoff_ms ??
        profile.data.agent?.retry_backoff_ms ??
        30000,
    },
    codex: profile.data.codex ?? {},
    hooks: profile.data.hooks ?? {},
    ci: project.ci ?? profile.data.ci ?? {},
    poll_interval_ms: profile.data.poll_interval_ms ?? 10000,
  };

  const generatedRaw = `---\n${YAML.stringify(frontMatter).trimEnd()}\n---\n\n${profile.content.replace(
    /^\n+/,
    "",
  )}`;

  try {
    return parseWorkflowString(generatedRaw, input.generatedSourcePath);
  } catch (err) {
    if (err instanceof WorkflowConfigError) {
      throw new CentralWorkflowConfigError(
        err.message,
        `effective.${err.path}`,
        { cause: err },
      );
    }
    throw err;
  }
}

async function readText(
  filePath: string,
  label: "project" | "profile",
): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    throw new CentralWorkflowConfigError(
      `failed to read ${label} file: ${err instanceof Error ? err.message : String(err)}`,
      label,
      { cause: err },
    );
  }
}

function parseProjectFile(raw: string): z.infer<typeof ProjectFileSchema> {
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new CentralWorkflowConfigError(
      `project: failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
      "project",
      { cause: err },
    );
  }
  try {
    return ProjectFileSchema.parse(parsed);
  } catch (err) {
    throw zodToCentralError("project", err);
  }
}

function parseProfileFile(raw: string): {
  data: z.infer<typeof ProfileFrontMatterSchema>;
  content: string;
} {
  const parsed = matter(raw, {
    engines: {
      yaml: {
        parse: (input: string): object => {
          const result: unknown = YAML.parse(input, { prettyErrors: true });
          if (result === null || result === undefined) return {};
          if (typeof result !== "object" || Array.isArray(result)) {
            throw new Error("front matter must be a YAML mapping");
          }
          return result as object;
        },
        stringify: (input: unknown): string => YAML.stringify(input),
      },
    },
  });
  try {
    const data = ProfileFrontMatterSchema.parse(parsed.data ?? {});
    return { data, content: parsed.content };
  } catch (err) {
    throw zodToCentralError("profile", err);
  }
}

function zodToCentralError(
  prefix: "project" | "profile",
  err: unknown,
): CentralWorkflowConfigError {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const suffix =
      first && first.code === "unrecognized_keys"
        ? [...first.path.map(String), ...first.keys].join(".")
        : (first?.path ?? []).map(String).join(".");
    const path = suffix ? `${prefix}.${suffix}` : prefix;
    return new CentralWorkflowConfigError(
      `${path}: ${first?.message ?? "invalid central workflow config"}`,
      path,
      { cause: err },
    );
  }
  return new CentralWorkflowConfigError(String(err), prefix, { cause: err });
}
