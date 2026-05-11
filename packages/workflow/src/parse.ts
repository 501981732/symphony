import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import matter from "gray-matter";
import YAML from "yaml";
import { z, type ZodIssue } from "zod";

import type {
  AgentConfig,
  CodexConfig,
  GitConfig,
  HooksConfig,
  TrackerConfig,
  WorkflowConfig,
  WorkspaceConfig,
} from "./types.js";

/**
 * Thrown when `.agents/workflow.md` cannot be loaded or fails validation.
 *
 * `path` points at the offending field using dot-notation (e.g.
 * `tracker.project_id`), or one of the sentinel values:
 *
 * - `<file>`     — the file itself could not be read.
 * - `<front-matter>` — YAML front matter failed to parse.
 */
export class WorkflowConfigError extends Error {
  override readonly name = "WorkflowConfigError";

  constructor(
    message: string,
    public readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const TrackerSchema = z.object({
  kind: z.literal("gitlab"),
  base_url: z.string().url(),
  project_id: z.string().min(1),
  token_env: z.string().min(1),
  active_labels: z
    .array(z.string().min(1))
    .min(1)
    .default(["ai-ready", "ai-rework"]),
  running_label: z.string().min(1).default("ai-running"),
  handoff_label: z.string().min(1).default("human-review"),
  failed_label: z.string().min(1).default("ai-failed"),
  blocked_label: z.string().min(1).default("ai-blocked"),
  rework_label: z.string().min(1).default("ai-rework"),
  merging_label: z.string().min(1).default("ai-merging"),
});

const WorkspaceSchema = z
  .object({
    root: z.string().min(1).default("~/.issuepilot/workspaces"),
    strategy: z.literal("worktree").default("worktree"),
    repo_cache_root: z.string().min(1).default("~/.issuepilot/repos"),
  })
  .prefault({});

const GitSchema = z.object({
  repo_url: z.string().min(1),
  base_branch: z.string().min(1).default("main"),
  branch_prefix: z.string().min(1).default("ai"),
});

const AgentSchema = z
  .object({
    runner: z.literal("codex-app-server").default("codex-app-server"),
    max_concurrent_agents: z.number().int().min(1).default(1),
    max_turns: z.number().int().min(1).default(10),
    max_attempts: z.number().int().min(1).default(2),
    retry_backoff_ms: z.number().int().min(0).default(30_000),
  })
  .prefault({});

const CodexSchema = z
  .object({
    command: z.string().min(1).default("codex app-server"),
    approval_policy: z
      .enum(["never", "untrusted", "on-request"])
      .default("never"),
    thread_sandbox: z
      .enum(["workspace-write", "read-only", "danger-full-access"])
      .default("workspace-write"),
    turn_timeout_ms: z.number().int().min(1_000).default(3_600_000),
    turn_sandbox_policy: z
      .object({
        type: z
          .enum(["workspaceWrite", "readOnly", "dangerFullAccess"])
          .default("workspaceWrite"),
      })
      .prefault({}),
  })
  .prefault({});

const HooksSchema = z
  .object({
    after_create: z.string().min(1).optional(),
    before_run: z.string().min(1).optional(),
    after_run: z.string().min(1).optional(),
  })
  .prefault({});

const WorkflowFrontMatterSchema = z.object({
  tracker: TrackerSchema,
  workspace: WorkspaceSchema,
  git: GitSchema,
  agent: AgentSchema,
  codex: CodexSchema,
  hooks: HooksSchema,
});

type WorkflowFrontMatter = z.infer<typeof WorkflowFrontMatterSchema>;

/**
 * Parse a `.agents/workflow.md` style file into a typed {@link WorkflowConfig}.
 *
 * Throws {@link WorkflowConfigError} for IO errors, YAML errors, or any
 * Zod validation failure; in the validation case `error.path` mirrors the
 * snake_case YAML path so it can be surfaced to the user as-is.
 */
export async function parseWorkflowFile(
  filePath: string,
): Promise<WorkflowConfig> {
  const raw = await readWorkflowFile(filePath);
  const parsed = parseFrontMatter(raw);
  const fm = validateFrontMatter(parsed.data);

  const promptTemplate = parsed.content.replace(/^\n+/, "");
  const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");

  const tracker: TrackerConfig = {
    kind: fm.tracker.kind,
    baseUrl: fm.tracker.base_url,
    projectId: fm.tracker.project_id,
    tokenEnv: fm.tracker.token_env,
    activeLabels: fm.tracker.active_labels,
    runningLabel: fm.tracker.running_label,
    handoffLabel: fm.tracker.handoff_label,
    failedLabel: fm.tracker.failed_label,
    blockedLabel: fm.tracker.blocked_label,
    reworkLabel: fm.tracker.rework_label,
    mergingLabel: fm.tracker.merging_label,
  };

  const workspace: WorkspaceConfig = {
    root: fm.workspace.root,
    strategy: fm.workspace.strategy,
    repoCacheRoot: fm.workspace.repo_cache_root,
  };

  const git: GitConfig = {
    repoUrl: fm.git.repo_url,
    baseBranch: fm.git.base_branch,
    branchPrefix: fm.git.branch_prefix,
  };

  const agent: AgentConfig = {
    runner: fm.agent.runner,
    maxConcurrentAgents: fm.agent.max_concurrent_agents,
    maxTurns: fm.agent.max_turns,
    maxAttempts: fm.agent.max_attempts,
    retryBackoffMs: fm.agent.retry_backoff_ms,
  };

  const codex: CodexConfig = {
    command: fm.codex.command,
    approvalPolicy: fm.codex.approval_policy,
    threadSandbox: fm.codex.thread_sandbox,
    turnTimeoutMs: fm.codex.turn_timeout_ms,
    turnSandboxPolicy: { type: fm.codex.turn_sandbox_policy.type },
  };

  const hooks: HooksConfig = {};
  if (fm.hooks.after_create !== undefined) {
    hooks.afterCreate = fm.hooks.after_create;
  }
  if (fm.hooks.before_run !== undefined) {
    hooks.beforeRun = fm.hooks.before_run;
  }
  if (fm.hooks.after_run !== undefined) {
    hooks.afterRun = fm.hooks.after_run;
  }

  return {
    tracker,
    workspace,
    git,
    agent,
    codex,
    hooks,
    promptTemplate,
    source: {
      path: filePath,
      sha256,
      loadedAt: new Date().toISOString(),
    },
  };
}

async function readWorkflowFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : "failed to read workflow file";
    throw new WorkflowConfigError(message, "<file>", { cause });
  }
}

interface ParsedFrontMatter {
  data: unknown;
  content: string;
}

function parseFrontMatter(raw: string): ParsedFrontMatter {
  try {
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
    return { data: (parsed.data ?? {}) as unknown, content: parsed.content };
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : "failed to parse front matter";
    throw new WorkflowConfigError(message, "<front-matter>", { cause });
  }
}

function validateFrontMatter(data: unknown): WorkflowFrontMatter {
  const result = WorkflowFrontMatterSchema.safeParse(data);
  if (result.success) return result.data;

  const issue = pickPrimaryIssue(result.error.issues);
  throw new WorkflowConfigError(formatIssue(issue), formatPath(issue.path));
}

function pickPrimaryIssue(issues: ZodIssue[]): ZodIssue {
  if (issues.length === 0) {
    return {
      code: "custom",
      path: [],
      message: "invalid workflow config",
    } as ZodIssue;
  }
  const required = issues.find(
    (i) =>
      i.code === "invalid_type" &&
      "received" in i &&
      (i as { received: unknown }).received === "undefined",
  );
  return required ?? issues[0]!;
}

function formatPath(parts: ReadonlyArray<PropertyKey>): string {
  if (parts.length === 0) return "<root>";
  return parts.map((p) => String(p)).join(".");
}

function formatIssue(issue: ZodIssue): string {
  const where = formatPath(issue.path);
  return `${issue.message} (at ${where})`;
}
