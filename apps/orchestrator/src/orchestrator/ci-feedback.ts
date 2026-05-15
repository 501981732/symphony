import { randomUUID } from "node:crypto";

import { redact, type EventBus } from "@issuepilot/observability";
import type {
  IssuePilotInternalEvent,
  PipelineStatus,
} from "@issuepilot/shared-contracts";

import type { RuntimeState } from "../runtime/state.js";

/**
 * GitLab adapter slice consumed by the CI feedback scanner. The
 * orchestrator wires the real `@issuepilot/tracker-gitlab` adapter; tests
 * can plug in a hand-rolled mock that only implements these four methods.
 */
export interface CiFeedbackGitLabSlice {
  findMergeRequestBySourceBranch(sourceBranch: string): Promise<{
    iid: number;
    webUrl: string;
    state: string;
    sourceBranch: string;
    title: string;
    description: string;
    updatedAt?: string;
  } | null>;
  getPipelineStatus(ref: string): Promise<PipelineStatus>;
  transitionLabels(
    iid: number,
    opts: {
      add: readonly string[];
      remove: readonly string[];
      requireCurrent?: readonly string[];
    },
  ): Promise<{ labels: string[] } | void>;
  createIssueNote(iid: number, body: string): Promise<{ id: number }>;
  /**
   * Locate an existing GitLab issue note that already carries the
   * scanner's per-run marker (`<!-- issuepilot:ci-feedback:<runId> -->`),
   * so we can skip writing the manual / rework note a second time.
   * Returns `null` when no such note exists.
   */
  findWorkpadNote(
    iid: number,
    marker: string,
  ): Promise<{ id: number; body: string } | null>;
}

export interface CiFeedbackWorkflowSlice {
  tracker: {
    handoffLabel: string;
    reworkLabel: string;
  };
  ci: {
    enabled: boolean;
    onFailure: "ai-rework" | "human-review";
    waitForPipeline: boolean;
  };
}

/**
 * Dependencies for the CI feedback scanner. `now` is injectable so tests
 * can pin `latestCiCheckedAt` to a deterministic value.
 */
export interface ScanCiFeedbackDeps {
  state: RuntimeState;
  gitlab: CiFeedbackGitLabSlice;
  workflow: CiFeedbackWorkflowSlice;
  eventBus: EventBus<IssuePilotInternalEvent>;
  now?: () => Date;
}

interface ReviewRun {
  runId: string;
  branch: string;
  issueIid: number;
  issue: {
    id: string;
    iid: number;
    title: string;
    url: string;
    projectId: string;
    labels: readonly string[];
  };
  latestCiStatus?: PipelineStatus;
}

interface IssueLike {
  id?: string;
  iid?: unknown;
  title?: string;
  url?: string;
  projectId?: string;
  labels?: unknown;
}

function asReviewRun(record: Record<string, unknown>): ReviewRun | null {
  const runId = record["runId"];
  if (typeof runId !== "string") return null;
  const branch = record["branch"];
  if (typeof branch !== "string" || branch.length === 0) return null;
  const issue = record["issue"] as IssueLike | undefined;
  if (!issue) return null;
  const iid = typeof issue.iid === "number" ? issue.iid : Number(issue.iid);
  if (!Number.isFinite(iid)) return null;
  const labels = Array.isArray(issue.labels)
    ? (issue.labels as string[])
    : [];

  const out: ReviewRun = {
    runId,
    branch,
    issueIid: iid,
    issue: {
      id: issue.id ?? String(iid),
      iid,
      title: issue.title ?? "",
      url: issue.url ?? "",
      projectId: issue.projectId ?? "",
      labels,
    },
  };
  if (typeof record["latestCiStatus"] === "string") {
    out.latestCiStatus = record["latestCiStatus"] as PipelineStatus;
  }
  return out;
}

function nowIso(deps: ScanCiFeedbackDeps): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

function emit(
  deps: ScanCiFeedbackDeps,
  run: ReviewRun,
  type:
    | "ci_status_observed"
    | "ci_status_rework_triggered"
    | "ci_status_lookup_failed",
  data: Record<string, unknown>,
): void {
  const ts = nowIso(deps);
  // The scanner publishes directly to the event bus rather than going
  // through daemon.ts's `publishEvent` wrapper (which centralises
  // redaction). Running the redactor here protects future contributors
  // who may add tokens / pipeline log lines / job names into the event
  // payload without realising those would otherwise bypass redaction.
  const redactedData = redact(data);
  const safeData =
    redactedData && typeof redactedData === "object" && !Array.isArray(redactedData)
      ? (redactedData as Record<string, unknown>)
      : data;
  const event: IssuePilotInternalEvent = {
    id: randomUUID(),
    runId: run.runId,
    type,
    message: `${type}:${safeData["status"] ?? safeData["reason"] ?? "unknown"}`,
    data: safeData,
    createdAt: ts,
    ts,
    issue: {
      id: run.issue.id,
      iid: run.issue.iid,
      title: run.issue.title,
      url: run.issue.url,
      projectId: run.issue.projectId,
    },
  };
  deps.eventBus.publish(event);
}

function markerForRun(runId: string): string {
  return `<!-- issuepilot:ci-feedback:${runId} -->`;
}

interface MergeRequestRef {
  iid: number;
  webUrl: string;
}

function buildFailureNote(run: ReviewRun, mr: MergeRequestRef): string {
  return [
    markerForRun(run.runId),
    "## IssuePilot detected a failing CI pipeline",
    "",
    "The latest pipeline on the run's source branch failed; the issue",
    `has been moved back to \`ai-rework\` so IssuePilot can iterate.`,
    "",
    `- Run: \`${run.runId}\``,
    `- Branch: \`${run.branch}\``,
    `- MR: !${mr.iid} ${mr.webUrl}`,
  ].join("\n");
}

function buildManualNote(
  run: ReviewRun,
  status: PipelineStatus,
  mr: MergeRequestRef,
): string {
  return [
    markerForRun(run.runId),
    `## IssuePilot observed an unusual CI status: \`${status}\``,
    "",
    "The latest pipeline on the run's source branch is in a non-actionable",
    "state. A human reviewer should decide whether to re-trigger CI, mark",
    "the issue as failed, or accept the run as-is.",
    "",
    `- Run: \`${run.runId}\``,
    `- Branch: \`${run.branch}\``,
    `- MR: !${mr.iid} ${mr.webUrl}`,
  ].join("\n");
}

/**
 * Best-effort idempotency for marker-tagged notes. The caller already
 * picks the action (rework / manual prompt); this helper just decides
 * whether the GitLab note has been written for `runId` previously. We
 * swallow lookup errors so an outage on the `notes` endpoint does not
 * block label transitions — the next tick will retry.
 */
async function hasExistingCiNote(
  deps: ScanCiFeedbackDeps,
  run: ReviewRun,
): Promise<boolean> {
  try {
    const existing = await deps.gitlab.findWorkpadNote(
      run.issueIid,
      markerForRun(run.runId),
    );
    return existing !== null;
  } catch {
    return false;
  }
}

function setLatestCi(
  deps: ScanCiFeedbackDeps,
  run: ReviewRun,
  status: PipelineStatus,
): void {
  const record = deps.state.getRun(run.runId);
  if (!record) return;
  deps.state.setRun(run.runId, {
    ...record,
    latestCiStatus: status,
    latestCiCheckedAt: nowIso(deps),
  });
}

/**
 * Run statuses considered "parked at human-review" for the purpose of
 * CI feedback scanning. `RunRecord.issue.labels` is captured at claim
 * time and not refreshed, so we cannot use it to detect the
 * human-review stage; the dispatch pipeline reliably parks the run at
 * `completed` once reconciliation finishes, which is the moment we
 * want to start polling pipelines.
 */
const REVIEW_RUN_STATUSES = new Set<string>(["completed"]);

/**
 * Scan every run currently parked at completion (which V1 dispatch
 * uses as a proxy for "issue is in human-review") and update labels /
 * audit notes based on the latest pipeline classification:
 *
 * - `success` → emit `ci_status_observed { action: noop }`, do not touch
 *   labels.
 * - `failed` + `onFailure === "ai-rework"` → move labels to `ai-rework`,
 *   write a marker note, emit `ci_status_rework_triggered`.
 * - `failed` + `onFailure === "human-review"` → emit
 *   `ci_status_observed { action: noop }` to record the observation
 *   without changing labels.
 * - `running` / `pending` → emit `ci_status_observed { action: wait }`.
 * - `canceled` / `unknown` → emit `ci_status_observed { action: manual }`
 *   plus a prompt note for the reviewer.
 *
 * Label transitions always pass `requireCurrent: [handoffLabel]` so a
 * stale completion (issue already merged-closed or reopened by a human)
 * fails fast inside GitLab instead of mis-tagging the issue. The thrown
 * stale-label error is swallowed and we move on.
 *
 * Any pipeline-lookup throws are caught and translated into
 * `ci_status_lookup_failed`; the run remains in its current state.
 *
 * The marker `<!-- issuepilot:ci-feedback:<runId> -->` makes it possible
 * to detect existing rework notes on retry so we never duplicate them.
 */
export async function scanCiFeedbackOnce(
  deps: ScanCiFeedbackDeps,
): Promise<void> {
  if (!deps.workflow.ci.enabled) return;

  const candidates: ReviewRun[] = [];
  for (const record of deps.state.allRuns()) {
    if (record["archivedAt"]) continue;
    // I1: once human-review reconciliation observes the MR landing
    // (merged → issue closed) or the MR getting closed without merge
    // (run already escalated to `ai-rework`), the daemon stamps
    // `endedAt` on the run. Skip those here so the scanner does not
    // keep pinging GitLab for runs that have left the review loop.
    if (typeof record["endedAt"] === "string" && record["endedAt"].length > 0) {
      continue;
    }
    const status = record["status"];
    if (typeof status !== "string" || !REVIEW_RUN_STATUSES.has(status)) {
      continue;
    }
    const review = asReviewRun(record as Record<string, unknown>);
    if (!review) continue;
    candidates.push(review);
  }

  for (const run of candidates) {
    const mr = await deps.gitlab.findMergeRequestBySourceBranch(run.branch);
    if (!mr) {
      emit(deps, run, "ci_status_observed", {
        reason: "no_mr",
        branch: run.branch,
      });
      continue;
    }

    let status: PipelineStatus;
    try {
      status = await deps.gitlab.getPipelineStatus(run.branch);
    } catch (err) {
      emit(deps, run, "ci_status_lookup_failed", {
        reason: "lookup_failed",
        branch: run.branch,
        mrIid: mr.iid,
        mrUrl: mr.webUrl,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    setLatestCi(deps, run, status);

    if (status === "success") {
      emit(deps, run, "ci_status_observed", {
        status,
        action: "noop",
        branch: run.branch,
        mrIid: mr.iid,
        mrUrl: mr.webUrl,
      });
      continue;
    }

    if (status === "running" || status === "pending") {
      emit(deps, run, "ci_status_observed", {
        status,
        action: "wait",
        branch: run.branch,
        mrIid: mr.iid,
        mrUrl: mr.webUrl,
      });
      continue;
    }

    if (status === "failed") {
      if (deps.workflow.ci.onFailure === "ai-rework") {
        try {
          await deps.gitlab.transitionLabels(run.issueIid, {
            add: [deps.workflow.tracker.reworkLabel],
            remove: [deps.workflow.tracker.handoffLabel],
            requireCurrent: [deps.workflow.tracker.handoffLabel],
          });
        } catch (err) {
          emit(deps, run, "ci_status_observed", {
            status,
            action: "stale",
            branch: run.branch,
            mrIid: mr.iid,
            mrUrl: mr.webUrl,
            message: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        // C1: skip the note when a previous tick already wrote one for
        // this `runId`. transitionLabels has its own `requireCurrent`
        // safety net so labels stay consistent; we still emit the
        // rework event for the audit log.
        if (!(await hasExistingCiNote(deps, run))) {
          await deps.gitlab.createIssueNote(
            run.issueIid,
            buildFailureNote(run, mr),
          );
        }
        emit(deps, run, "ci_status_rework_triggered", {
          status,
          action: "rework",
          branch: run.branch,
          mrIid: mr.iid,
          mrUrl: mr.webUrl,
        });
      } else {
        emit(deps, run, "ci_status_observed", {
          status,
          action: "noop",
          branch: run.branch,
          mrIid: mr.iid,
          mrUrl: mr.webUrl,
        });
      }
      continue;
    }

    // canceled / unknown: prompt a reviewer, but only once per run —
    // GitLab pipelines often dwell in `unknown` (no pipeline yet) or
    // `canceled` while the human investigates, and we must not spam
    // the issue thread.
    if (!(await hasExistingCiNote(deps, run))) {
      await deps.gitlab.createIssueNote(
        run.issueIid,
        buildManualNote(run, status, mr),
      );
    }
    emit(deps, run, "ci_status_observed", {
      status,
      action: "manual",
      branch: run.branch,
      mrIid: mr.iid,
      mrUrl: mr.webUrl,
    });
  }
}
