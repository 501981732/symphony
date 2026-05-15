export interface TrackerConfig {
  kind: "gitlab";
  baseUrl: string;
  projectId: string;
  /**
   * Name of the env var that supplies a static GitLab access token (PAT,
   * Group Access Token, etc.). Optional — when omitted the orchestrator
   * falls back to OAuth credentials stored in `~/.issuepilot/credentials`
   * (see spec §22 decision 3).
   */
  tokenEnv?: string;
  activeLabels: string[];
  runningLabel: string;
  handoffLabel: string;
  failedLabel: string;
  blockedLabel: string;
  reworkLabel: string;
  mergingLabel: string;
}

export interface WorkspaceConfig {
  root: string;
  strategy: "worktree";
  repoCacheRoot: string;
}

export interface GitConfig {
  repoUrl: string;
  baseBranch: string;
  branchPrefix: string;
}

export interface AgentConfig {
  runner: "codex-app-server";
  maxConcurrentAgents: number;
  maxTurns: number;
  maxAttempts: number;
  retryBackoffMs: number;
}

export type CodexApprovalPolicy = "never" | "untrusted" | "on-request";

export type CodexThreadSandbox = "workspace-write" | "read-only";

export type CodexTurnSandboxType = "workspaceWrite" | "readOnly";

export interface CodexTurnSandboxPolicy {
  type: CodexTurnSandboxType;
}

export interface CodexConfig {
  command: string;
  approvalPolicy: CodexApprovalPolicy;
  threadSandbox: CodexThreadSandbox;
  turnTimeoutMs: number;
  turnSandboxPolicy: CodexTurnSandboxPolicy;
}

export interface HooksConfig {
  afterCreate?: string;
  beforeRun?: string;
  afterRun?: string;
}

/**
 * CI feedback policy applied during the `human-review` reconciliation
 * loop (V2 spec §9). When `enabled`, the orchestrator polls the latest
 * pipeline on the run's source branch:
 *
 * - `success` keeps the run in `human-review` and merely records the
 *   observation.
 * - `failed` recycles the issue to `onFailure` (`ai-rework` by default,
 *   meaning "ask Codex to retry"; setting `human-review` keeps the run
 *   parked but emits the observation event for visibility).
 * - `running` / `pending` are no-ops aside from emitting `ci_status_observed`.
 *
 * `waitForPipeline` is reserved for a follow-up plan and currently maps
 * to a no-op flag carried through configuration to avoid breaking team
 * configs that already encode user intent. Defaults match V2 spec §9:
 * `{ enabled: false, onFailure: "ai-rework", waitForPipeline: true }`.
 */
export interface CiConfig {
  enabled: boolean;
  onFailure: "ai-rework" | "human-review";
  waitForPipeline: boolean;
}

export interface WorkflowSource {
  path: string;
  sha256: string;
  loadedAt: string;
}

export interface WorkflowConfig {
  tracker: TrackerConfig;
  workspace: WorkspaceConfig;
  git: GitConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  hooks: HooksConfig;
  ci: CiConfig;
  /** Orchestrator main-loop poll interval in milliseconds. Defaults to 10 000. */
  pollIntervalMs: number;
  promptTemplate: string;
  source: WorkflowSource;
}

export interface IssuePromptInfo {
  id: string;
  iid: number;
  identifier: string;
  title: string;
  description: string;
  labels: string[];
  url: string;
  author: string;
  assignees: string[];
}

export interface PromptContext {
  issue: IssuePromptInfo;
  attempt: number;
  workspace: { path: string };
  git: { branch: string };
}
