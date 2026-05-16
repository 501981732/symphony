import {
  RUN_REPORT_VERSION,
  type RunReportArtifact,
  type RunStatus,
} from "@issuepilot/shared-contracts";

interface IssueInput {
  id?: string;
  iid: number;
  title: string;
  url: string;
  projectId: string;
  labels: readonly string[];
}

export interface CreateInitialReportInput {
  runId: string;
  issue: IssueInput;
  status: RunStatus;
  attempt: number;
  branch: string;
  workspacePath: string;
  startedAt: string;
}

function elapsedMs(startedAt: string, endedAt: string): number | undefined {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

export function createInitialReport(
  input: CreateInitialReportInput,
): RunReportArtifact {
  return {
    version: RUN_REPORT_VERSION,
    runId: input.runId,
    issue: {
      projectId: input.issue.projectId,
      iid: input.issue.iid,
      title: input.issue.title,
      url: input.issue.url,
      labels: [...input.issue.labels],
    },
    run: {
      status: input.status,
      attempt: input.attempt,
      branch: input.branch,
      workspacePath: input.workspacePath,
      startedAt: input.startedAt,
      durations: {},
    },
    handoff: {
      summary: "not reported",
      validation: [],
      risks: [],
      followUps: [],
      nextAction: "not reported",
    },
    diff: {
      summary: "not available",
      filesChanged: 0,
      notableFiles: [],
    },
    checks: [],
    mergeReadiness: {
      mode: "dry-run",
      status: "unknown",
      reasons: [
        {
          code: "run_not_in_review",
          severity: "warning",
          message: "Run has not reached human-review yet.",
        },
      ],
      evaluatedAt: input.startedAt,
    },
    notes: {},
  };
}

export function updateReportHandoff(
  report: RunReportArtifact,
  handoff: RunReportArtifact["handoff"],
): RunReportArtifact {
  return { ...report, handoff };
}

export function markReportFailed(
  report: RunReportArtifact,
  input: {
    status: "failed" | "blocked";
    endedAt: string;
    lastError: NonNullable<RunReportArtifact["run"]["lastError"]>;
  },
): RunReportArtifact {
  const totalMs = elapsedMs(report.run.startedAt, input.endedAt);
  return {
    ...report,
    run: {
      ...report.run,
      status: input.status,
      endedAt: input.endedAt,
      lastError: input.lastError,
      durations: {
        ...report.run.durations,
        ...(totalMs !== undefined ? { totalMs } : {}),
      },
    },
  };
}
