import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  createEventBus,
  createEventStore,
  redact,
  type EventBus,
} from "@issuepilot/observability";
import {
  createGitLabTools,
  driveLifecycle,
  spawnRpc,
} from "@issuepilot/runner-codex-app-server";
import {
  createGitLabAdapter,
  type GitLabAdapter,
} from "@issuepilot/tracker-gitlab";
import {
  createWorkflowLoader,
  type PromptContext,
  type WorkflowConfig,
  type WorkflowLoader,
} from "@issuepilot/workflow";
import {
  branchName,
  ensureMirror,
  ensureWorktree,
  runHook,
  slugify,
} from "@issuepilot/workspace";
import { execa, execaCommand } from "execa";

import { claimCandidates } from "./orchestrator/claim.js";
import { classifyError, type Classification } from "./orchestrator/classify.js";
import { dispatch } from "./orchestrator/dispatch.js";
import { startLoop } from "./orchestrator/loop.js";
import { reconcile } from "./orchestrator/reconcile.js";
import { createConcurrencySlots } from "./runtime/slots.js";
import { createRuntimeState, type RuntimeState } from "./runtime/state.js";
import { createServer } from "./server/index.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4738;
const DEFAULT_POLL_INTERVAL_MS = 10_000;

type OrchestratorEvent = {
  id: string;
  runId: string;
  type: string;
  message: string;
  ts: string;
  [key: string]: unknown;
};

export interface DaemonHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly state: RuntimeState;
  stop(): Promise<void>;
  wait(): Promise<void>;
}

export interface StartDaemonOptions {
  workflowPath: string;
  host?: string | undefined;
  port?: number | undefined;
}

export interface StartDaemonDeps {
  workflowLoader?: WorkflowLoader | undefined;
  createGitLab?: ((cfg: WorkflowConfig) => GitLabAdapter) | undefined;
  createServer?: typeof createServer | undefined;
  startLoop?: typeof startLoop | undefined;
  state?: RuntimeState | undefined;
  eventBus?: EventBus<OrchestratorEvent> | undefined;
}

function runKey(
  cfg: WorkflowConfig,
  issueIid: number,
): {
  projectSlug: string;
  issueIid: number;
} {
  return {
    projectSlug: slugify(cfg.tracker.projectId),
    issueIid,
  };
}

function toEventRecord(event: {
  type: string;
  runId: string;
  ts: string;
  detail: Record<string, unknown>;
}): OrchestratorEvent {
  return {
    id: randomUUID(),
    runId: event.runId,
    type: event.type,
    message: event.type,
    ts: event.ts,
    ...event.detail,
  };
}

/**
 * Tokenize a `codex.command` string into `{ command, args[] }`. Supports
 * single + double quoted segments so paths containing spaces survive the
 * trip from the workflow YAML through to `execa`. Without this, an absolute
 * path like `/Users/User Name/.local/bin/codex` would be split into three
 * tokens by the previous `split(/\s+/)` and `execa` would try to spawn
 * `/Users/User`.
 *
 * Rules (intentionally a subset of POSIX shell):
 *   - Whitespace separates tokens.
 *   - `"…"` and `'…'` create a single token; the surrounding quotes are
 *     stripped. Escapes are NOT honoured inside quotes — keep paths simple.
 *   - Unbalanced quotes throw, matching the bash behaviour of refusing to
 *     execute the line.
 */
export function splitCommand(command: string): {
  command: string;
  args: string[];
} {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    throw new Error("codex.command must not be empty");
  }
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) {
    throw new Error(
      `codex.command has an unbalanced ${quote} quote: ${command}`,
    );
  }
  if (inToken) tokens.push(current);
  if (tokens.length === 0) {
    throw new Error("codex.command must not be empty");
  }
  const [cmd, ...args] = tokens;
  return { command: cmd!, args };
}

async function hasNewCommits(
  cwd: string,
  baseBranch: string,
): Promise<boolean> {
  const result = await execa("git", [
    "-C",
    cwd,
    "rev-list",
    "--count",
    `${baseBranch}..HEAD`,
  ]);
  return Number(result.stdout.trim()) > 0;
}

async function pushBranch(cwd: string, branch: string): Promise<void> {
  await execa("git", ["-C", cwd, "push", "-u", "origin", branch]);
}

async function createFailureNote(
  gitlab: GitLabAdapter,
  iid: number,
  classification: Classification,
  attempt: number,
): Promise<void> {
  await gitlab.createIssueNote(
    iid,
    [
      `**IssuePilot run failed** after attempt ${attempt}.`,
      "",
      `- Kind: \`${classification.kind}\``,
      `- Reason: ${classification.reason}`,
    ].join("\n"),
  );
}

async function readLogTail(logFile: string, limit = 200): Promise<string[]> {
  try {
    const content = await fs.readFile(logFile, "utf-8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map((line) => String(redact(line)));
  } catch {
    return [];
  }
}

export async function startDaemon(
  options: StartDaemonOptions,
  deps: StartDaemonDeps = {},
): Promise<DaemonHandle> {
  const workflowPath = path.resolve(options.workflowPath);
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const workflowLoader = deps.workflowLoader ?? createWorkflowLoader();
  let workflow = await workflowLoader.loadOnce(workflowPath);

  const state = deps.state ?? createRuntimeState();
  const slots = createConcurrencySlots(workflow.agent.maxConcurrentAgents);
  const eventBus = deps.eventBus ?? createEventBus<OrchestratorEvent>();
  const eventStore = createEventStore(
    path.join(workflow.workspace.root, ".issuepilot", "events"),
  );
  const runIndex = new Map<string, { projectSlug: string; issueIid: number }>();
  const gitlab = deps.createGitLab
    ? deps.createGitLab(workflow)
    : createGitLabAdapter({
      baseUrl: workflow.tracker.baseUrl,
      projectId: workflow.tracker.projectId,
      tokenEnv: workflow.tracker.tokenEnv,
    });

  const publishEvent = (event: {
    type: string;
    runId: string;
    ts: string;
    detail: Record<string, unknown>;
  }): void => {
    const record = toEventRecord(event);
    eventBus.publish(record);
    const existing = runIndex.get(record.runId);
    const run = state.getRun(record.runId);
    const issueIid =
      existing?.issueIid ??
      (typeof run?.["issue"] === "object" &&
        run["issue"] !== null &&
        "iid" in run["issue"]
        ? Number((run["issue"] as { iid: unknown }).iid)
        : undefined);
    if (!issueIid || !Number.isFinite(issueIid)) return;
    const key = existing ?? runKey(workflow, issueIid);
    runIndex.set(record.runId, key);
    void eventStore
      .append(key.projectSlug, key.issueIid, record)
      .catch((err) => {
        // ENOENT can fire during teardown if the workspace dir was
        // removed between scheduling the publish and flushing it. Silence
        // that specific case to keep test output clean; everything else
        // is still surfaced for diagnostics.
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") return;
        console.error(err);
      });
  };

  const serverFactory = deps.createServer ?? createServer;
  const app = await serverFactory(
    {
      state,
      eventBus,
      workflowPath,
      gitlabProject: workflow.tracker.projectId,
      handoffLabel: workflow.tracker.handoffLabel,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      concurrency: workflow.agent.maxConcurrentAgents,
      readEvents: async (runId, readOpts) => {
        const key = runIndex.get(runId);
        if (!key) return [];
        return eventStore.read(key.projectSlug, key.issueIid, readOpts);
      },
      readLogsTail: async (_runId, readOpts) =>
        readLogTail(
          path.join(
            workflow.workspace.root,
            ".issuepilot",
            "logs",
            "issuepilot.log",
          ),
          readOpts?.limit,
        ),
    },
    { host, port },
  );

  let watcher: Awaited<ReturnType<WorkflowLoader["start"]>> | undefined;
  try {
    watcher = await workflowLoader.start(workflowPath, {
      onReload: (cfg) => {
        workflow = cfg;
      },
      onError: (err) => {
        console.error(err);
      },
    });
  } catch {
    watcher = undefined;
  }

  const loopFactory = deps.startLoop ?? startLoop;
  const loop = loopFactory({
    state,
    slots,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    loadConfig: () => ({ pollIntervalMs: DEFAULT_POLL_INTERVAL_MS }),
    claim: async () => {
      const claimGitlab = {
        listCandidateIssues: async (opts: {
          activeLabels: string[];
          excludeLabels: string[];
        }) => {
          const issues = await gitlab.listCandidateIssues(opts);
          return issues.map((issue) => ({
            ...issue,
            labels: [...issue.labels],
          }));
        },
        transitionLabels: gitlab.transitionLabels,
      };
      const claimed = await claimCandidates({
        gitlab: claimGitlab,
        state,
        slots,
        activeLabels: workflow.tracker.activeLabels,
        runningLabel: workflow.tracker.runningLabel,
        excludeLabels: [
          workflow.tracker.runningLabel,
          workflow.tracker.handoffLabel,
          workflow.tracker.failedLabel,
          workflow.tracker.blockedLabel,
        ],
        onClaimError: async ({ issue, error }) => {
          // Spec §21.12 says blocked issues must surface as `ai-blocked`
          // (not silently re-polled). When a permission/auth error trips
          // the claim transition we cannot acquire a slot, but we can:
          //   1. emit a `claim_failed` event so the dashboard sees it;
          //   2. best-effort push the label into `ai-blocked` so the
          //      issue exits the active-label set and stops getting polled.
          const classification = classifyError(error);
          if (classification.kind !== "blocked") return;

          const syntheticRunId = randomUUID();
          runIndex.set(syntheticRunId, runKey(workflow, issue.iid));

          let labelTransitioned = false;
          try {
            await gitlab.transitionLabels(issue.iid, {
              add: [workflow.tracker.blockedLabel],
              remove: [
                workflow.tracker.runningLabel,
                ...workflow.tracker.activeLabels,
              ],
            });
            labelTransitioned = true;
          } catch {
            // Both the claim transition and the blocked transition failed
            // (e.g. the token has no PUT permission anywhere). The label
            // stays as-is, but the `claim_failed` event below still gives
            // operators a visible signal.
          }

          publishEvent({
            type: "claim_failed",
            runId: syntheticRunId,
            ts: new Date().toISOString(),
            detail: {
              iid: issue.iid,
              kind: classification.kind,
              code: classification.code,
              reason: classification.reason,
              labelTransitioned,
              targetLabel: workflow.tracker.blockedLabel,
            },
          });
        },
      });
      for (const c of claimed) {
        runIndex.set(c.runId, runKey(workflow, c.issue.iid));
      }
      return claimed.map((c) => ({ runId: c.runId }));
    },
    dispatch: async (runId) => {
      const run = state.getRun(runId);
      const issue = run?.["issue"] as
        | {
          id?: string | undefined;
          iid: number;
          title: string;
          url: string;
          projectId: string;
          description?: string | undefined;
          labels?: string[] | undefined;
          author?: string | undefined;
          assignees?: string[] | undefined;
        }
        | undefined;
      if (!issue) throw new Error(`Run not found or missing issue: ${runId}`);

      const projectSlug = slugify(workflow.tracker.projectId);
      const titleSlug = slugify(issue.title);
      const branch = branchName({
        prefix: workflow.git.branchPrefix,
        iid: issue.iid,
        titleSlug,
      });
      state.setRun(runId, { ...run!, branch });

      await dispatch(
        {
          runId,
          issue,
          remoteUrl: workflow.git.repoUrl,
          repoCacheRoot: workflow.workspace.repoCacheRoot,
          worktreeRoot: workflow.workspace.root,
          branch,
          baseBranch: workflow.git.baseBranch,
          runningLabel: workflow.tracker.runningLabel,
          handoffLabel: workflow.tracker.handoffLabel,
          promptTemplate: workflow.promptTemplate,
          hooks: workflow.hooks,
        },
        {
          state,
          maxAttempts: workflow.agent.maxAttempts,
          retryBackoffMs: workflow.agent.retryBackoffMs,
          ensureMirror: async (opts) =>
            ensureMirror({
              repoUrl: opts.remoteUrl,
              projectSlug,
              repoCacheRoot: opts.repoCacheRoot,
            }),
          ensureWorktree: async (opts) => {
            const result = await ensureWorktree({
              mirrorPath: opts.mirrorPath,
              projectSlug,
              issueIid: issue.iid,
              titleSlug,
              baseBranch: opts.baseBranch,
              branchPrefix: workflow.git.branchPrefix,
              workspaceRoot: opts.worktreeRoot,
            });
            return {
              worktreePath: result.workspacePath,
              created: !result.reused,
            };
          },
          runHook: (opts) =>
            runHook({
              cwd: opts.cwd,
              name: opts.name,
              script: opts.script,
              env: opts.env ?? {},
            }),
          renderPrompt: (opts) =>
            workflowLoader.render(
              opts.template,
              opts.vars as unknown as PromptContext,
            ),
          runAgent: async (opts) => {
            const cmd = splitCommand(workflow.codex.command);
            const rpc = spawnRpc({ ...cmd, cwd: opts.cwd });
            const gitlabToolsAdapter = {
              getIssue: async (iid: number) => {
                const fullIssue = await gitlab.getIssue(iid);
                return {
                  ...fullIssue,
                  labels: [...fullIssue.labels],
                };
              },
              transitionLabels: gitlab.transitionLabels,
              createIssueNote: gitlab.createIssueNote,
              updateIssueNote: (
                iid: number,
                noteId: number,
                update: { body: string },
              ) => gitlab.updateIssueNote(iid, noteId, update.body),
              createMergeRequest: gitlab.createMergeRequest,
              updateMergeRequest: gitlab.updateMergeRequest,
              getMergeRequest: gitlab.getMergeRequest,
              listMergeRequestNotes: gitlab.listMergeRequestNotes,
              getPipelineStatus: gitlab.getPipelineStatus,
            };
            try {
              const result = await driveLifecycle({
                rpc,
                maxTurns: workflow.agent.maxTurns,
                prompt: opts.prompt,
                title: issue.title,
                cwd: opts.cwd,
                threadName: `${workflow.tracker.projectId}#${issue.iid}`,
                sandboxType: workflow.codex.threadSandbox,
                approvalPolicy: workflow.codex.approvalPolicy,
                turnSandboxPolicy: workflow.codex.turnSandboxPolicy,
                turnTimeoutMs: workflow.codex.turnTimeoutMs,
                tools: createGitLabTools(gitlabToolsAdapter, {
                  id: issue.id ?? String(issue.iid),
                  iid: issue.iid,
                  title: issue.title,
                  url: issue.url,
                  projectId: issue.projectId,
                  labels: [...(issue.labels ?? [])],
                }),
                onEvent: (type, data) =>
                  publishEvent({
                    type: `codex_${type}`,
                    runId,
                    ts: new Date().toISOString(),
                    detail: { data },
                  }),
              });
              return {
                status: result.status,
                summary: result.failureReason,
              };
            } finally {
              await rpc.close();
            }
          },
          reconcile: (opts) =>
            reconcile({
              ...opts,
              git: {
                hasNewCommits,
                push: pushBranch,
              },
              gitlab: {
                findMergeRequest: async () => null,
                createMergeRequest: (mrOpts) =>
                  gitlab.createMergeRequest({
                    ...mrOpts,
                    issueIid: opts.iid,
                  }),
                updateMergeRequest: (mrIid, updates) =>
                  gitlab.updateMergeRequest(mrIid, updates),
                findWorkpadNote: (issueIid, marker) =>
                  gitlab.findWorkpadNote(issueIid, marker),
                createNote: (issueIid, body) =>
                  gitlab.createIssueNote(issueIid, body),
                updateNote: (issueIid, noteId, body) =>
                  gitlab.updateIssueNote(issueIid, noteId, body),
                transitionLabels: async (iid, labelOpts) => {
                  await gitlab.transitionLabels(iid, labelOpts);
                },
              },
              onEvent: publishEvent,
            }),
          onEvent: publishEvent,
          onFailure: async (_failedRunId, classification, attempt) => {
            const label =
              classification.kind === "blocked"
                ? workflow.tracker.blockedLabel
                : workflow.tracker.failedLabel;
            await gitlab.transitionLabels(issue.iid, {
              add: [label],
              remove: [workflow.tracker.runningLabel],
            });
            await createFailureNote(gitlab, issue.iid, classification, attempt);
          },
        },
      );
    },
    reconcileRunning: async () => undefined,
    logError: (err) => {
      console.error(err);
    },
  });

  let stopped = false;
  let resolveStopped: (() => void) | undefined;
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    await loop.stop();
    await watcher?.stop();
    await app.close();
    resolveStopped?.();
  }

  const handleSignal = (): void => {
    void stop();
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  return {
    host,
    port,
    url: `http://${host}:${port}`,
    state,
    stop,
    wait: () => stoppedPromise,
  };
}

export async function validateWorkflow(
  workflowPath: string,
): Promise<WorkflowConfig> {
  const workflowLoader = createWorkflowLoader();
  return workflowLoader.loadOnce(path.resolve(workflowPath));
}

export async function checkCodexAppServer(): Promise<string> {
  const result = await execa("codex", ["--version"]);
  return result.stdout.trim() || "available";
}
