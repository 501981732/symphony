import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  createCredentialResolver,
  createCredentialsStore,
  type CredentialResolver,
  type CredentialsStore,
} from "@issuepilot/credentials";
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
  createGitLabAdapterFromCredential,
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
import { execa } from "execa";

import { claimCandidates } from "./orchestrator/claim.js";
import { classifyError, type Classification } from "./orchestrator/classify.js";
import { dispatch } from "./orchestrator/dispatch.js";
import {
  reconcileHumanReview,
  type HumanReviewEvent,
} from "./orchestrator/human-review.js";
import { startLoop } from "./orchestrator/loop.js";
import { reconcile } from "./orchestrator/reconcile.js";
import { createConcurrencySlots } from "./runtime/slots.js";
import { createRuntimeState, type RuntimeState } from "./runtime/state.js";
import { createServer } from "./server/index.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4738;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const HUMAN_REVIEW_SCAN_RUN_ID = "human-review-scan";

type OrchestratorEvent = {
  id: string;
  runId: string;
  type: string;
  message: string;
  createdAt: string;
  ts: string;
  data: unknown;
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
  createGitLab?:
    | ((cfg: WorkflowConfig) => GitLabAdapter | Promise<GitLabAdapter>)
    | undefined;
  /**
   * Override credential resolution. When omitted, the daemon assembles its
   * own resolver backed by the on-disk credentials store and the env var
   * named in `tracker.token_env` (if any). Tests inject a fake resolver to
   * skip both fs and HTTP.
   */
  credentialResolver?: CredentialResolver | undefined;
  /** Override the on-disk credentials store (mostly useful for tests). */
  credentialsStore?: CredentialsStore | undefined;
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

/**
 * Extract a bare hostname from `tracker.baseUrl`. The credentials store
 * keys entries by hostname, so reusing the URL parser keeps that mapping
 * deterministic instead of leaking trailing slashes / paths into the
 * credentials file.
 */
export function hostnameFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  }
}

function toEventRecord(event: {
  type: string;
  runId: string;
  ts: string;
  detail: Record<string, unknown>;
}): OrchestratorEvent {
  const data = redact(event.detail);
  const detail =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  return {
    id: randomUUID(),
    runId: event.runId,
    type: event.type,
    message: event.type,
    createdAt: event.ts,
    ts: event.ts,
    data,
    ...detail,
  };
}

function syncHumanReviewFinalLabels(
  state: RuntimeState,
  event: HumanReviewEvent,
): void {
  if (
    event.type !== "human_review_issue_closed" &&
    event.type !== "human_review_rework_requested"
  ) {
    return;
  }
  if (event.issueIid <= 0 || !Array.isArray(event.detail["labels"])) return;

  const labels = event.detail["labels"];
  if (!labels.every((label): label is string => typeof label === "string")) {
    return;
  }

  for (const run of state.allRuns()) {
    const issue = run["issue"];
    if (
      typeof issue !== "object" ||
      issue === null ||
      !("iid" in issue) ||
      Number((issue as { iid: unknown }).iid) !== event.issueIid
    ) {
      continue;
    }

    state.setRun(run.runId, {
      ...run,
      issue: {
        ...issue,
        labels: [...labels],
      },
    });
  }
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
  input: {
    runId: string;
    branch: string;
    classification: Classification;
    attempt: number;
    statusLabel: string;
    readyLabel: string;
  },
): Promise<void> {
  const title =
    input.classification.kind === "blocked"
      ? "IssuePilot run blocked"
      : "IssuePilot run failed";
  await gitlab.createIssueNote(
    iid,
    [
      `## ${title}`,
      "",
      `- Status: ${input.statusLabel}`,
      `- Run: \`${input.runId}\``,
      `- Attempt: ${input.attempt}`,
      `- Branch: \`${input.branch}\``,
      "",
      "### Reason",
      input.classification.reason,
      "",
      "### Next action",
      `Address the reason above, then move this Issue back to \`${input.readyLabel}\`.`,
    ].join("\n"),
  );
}

function readyLabel(workflow: WorkflowConfig): string {
  return workflow.tracker.activeLabels[0] ?? "ai-ready";
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

  /**
   * Resolve GitLab credentials before the server starts taking traffic. The
   * order is:
   *
   *   1. Test seam (`deps.createGitLab`) — kept for the existing in-memory
   *      e2e tests that drive the daemon entirely with fakes.
   *   2. Credential resolver (env var or `~/.issuepilot/credentials`) →
   *      adapter that knows how to refresh on 401.
   *
   * Failing fast here is intentional: spec §17 says the daemon should
   * refuse to start when neither credential source is available, with a
   * pointer at `issuepilot auth login`.
   */
  let gitlab: GitLabAdapter;
  if (deps.createGitLab) {
    gitlab = await deps.createGitLab(workflow);
  } else {
    const hostname = hostnameFromBaseUrl(workflow.tracker.baseUrl);
    const resolver =
      deps.credentialResolver ??
      createCredentialResolver({
        store: deps.credentialsStore ?? createCredentialsStore(),
      });
    let credential;
    try {
      const resolveInput: { hostname: string; trackerTokenEnv?: string } = {
        hostname,
      };
      if (workflow.tracker.tokenEnv) {
        resolveInput.trackerTokenEnv = workflow.tracker.tokenEnv;
      }
      credential = await resolver.resolve(resolveInput);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to resolve GitLab credentials for ${hostname}: ${message}`,
      );
    }
    if (credential.source === "env" && workflow.tracker.tokenEnv) {
      // Preserve the existing fast path so the synchronous sandbox-friendly
      // adapter is used when callers still rely on `tracker.token_env`.
      gitlab = createGitLabAdapter({
        baseUrl: workflow.tracker.baseUrl,
        projectId: workflow.tracker.projectId,
        tokenEnv: workflow.tracker.tokenEnv,
      });
    } else {
      gitlab = createGitLabAdapterFromCredential({
        baseUrl: workflow.tracker.baseUrl,
        projectId: workflow.tracker.projectId,
        credential,
      });
    }
  }

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

  const publishHumanReviewEvent = (event: HumanReviewEvent): void => {
    syncHumanReviewFinalLabels(state, event);
    if (event.issueIid > 0) {
      const key = runKey(workflow, event.issueIid);
      if (event.runId === HUMAN_REVIEW_SCAN_RUN_ID) {
        const record = toEventRecord({
          type: event.type,
          runId: event.runId,
          ts: event.ts,
          detail: {
            issueIid: event.issueIid,
            ...event.detail,
          },
        });
        eventBus.publish(record);
        void eventStore
          .append(key.projectSlug, key.issueIid, record)
          .catch((err) => {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === "ENOENT") return;
            console.error(err);
          });
        return;
      }
      runIndex.set(event.runId, key);
    }
    publishEvent({
      type: event.type,
      runId: event.runId,
      ts: event.ts,
      detail: {
        issueIid: event.issueIid,
        ...event.detail,
      },
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
          return Promise.all(
            issues.map(async (issue) => {
              const fullIssue = await gitlab.getIssue(issue.iid);
              return {
                ...fullIssue,
                labels: [...fullIssue.labels],
              };
            }),
          );
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
          const issueBranch = branchName({
            prefix: workflow.git.branchPrefix,
            iid: issue.iid,
            titleSlug: slugify(issue.title),
          });

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

          try {
            await createFailureNote(gitlab, issue.iid, {
              runId: syntheticRunId,
              branch: issueBranch,
              classification,
              attempt: 1,
              statusLabel: workflow.tracker.blockedLabel,
              readyLabel: readyLabel(workflow),
            });
          } catch {
            // A token that cannot transition labels may also be unable to
            // write notes. Keep the claim_failed event as the durable signal.
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
          reworkLabel: workflow.tracker.reworkLabel,
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
                findMergeRequest: (sourceBranch) =>
                  gitlab.findMergeRequestBySourceBranch(sourceBranch),
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
            await createFailureNote(gitlab, issue.iid, {
              runId: _failedRunId,
              branch,
              classification,
              attempt,
              statusLabel: label,
              readyLabel: readyLabel(workflow),
            });
          },
        },
      );
    },
    reconcileRunning: async () => {
      const runningLabel = workflow.tracker.runningLabel;
      const failedLabel = workflow.tracker.failedLabel;
      const blockedLabel = workflow.tracker.blockedLabel;
      await reconcileHumanReview({
        handoffLabel: workflow.tracker.handoffLabel,
        reworkLabel: workflow.tracker.reworkLabel,
        gitlab: {
          listHumanReviewIssues: async () => {
            const issues = await gitlab.listCandidateIssues({
              activeLabels: [workflow.tracker.handoffLabel],
              excludeLabels: [runningLabel, failedLabel, blockedLabel],
            });
            return Promise.all(
              issues.map(async (issue) => {
                const fullIssue = await gitlab.getIssue(issue.iid);
                return {
                  ...fullIssue,
                  labels: [...fullIssue.labels],
                };
              }),
            );
          },
          findLatestIssuePilotWorkpadNote:
            gitlab.findLatestIssuePilotWorkpadNote,
          listMergeRequestsBySourceBranch:
            gitlab.listMergeRequestsBySourceBranch,
          getIssue: async (iid) => {
            const fullIssue = await gitlab.getIssue(iid);
            return {
              ...fullIssue,
              labels: [...fullIssue.labels],
            };
          },
          createIssueNote: gitlab.createIssueNote,
          closeIssue: gitlab.closeIssue,
          transitionLabels: gitlab.transitionLabels,
        },
        onEvent: publishHumanReviewEvent,
      });
    },
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
