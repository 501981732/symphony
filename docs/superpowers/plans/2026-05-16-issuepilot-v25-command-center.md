# IssuePilot V2.5 Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the V2.5 Linear-like Command Center around a persisted `RunReportArtifact`, including List / Board views, Review Packet, report-backed GitLab notes, and merge readiness dry run.

**Architecture:** Add report contracts in `@issuepilot/shared-contracts`, keep report persistence local to the orchestrator runtime, and expose report summaries through the existing Fastify API. GitLab handoff/failure/closing notes render from the report so dashboard, notes, and Markdown exports share one fact source. Dashboard changes consume report summaries first, with legacy fallbacks for runs created before reports exist.

**Tech Stack:** TypeScript, Node.js 22, Fastify, Next.js App Router, React, Tailwind/shadcn-style primitives, Vitest, pnpm workspace.

---

## File Structure

Create:

- `packages/shared-contracts/src/report.ts` — canonical `RunReportArtifact`, summaries, merge readiness and type guards.
- `packages/shared-contracts/src/__tests__/report.test.ts` — contract tests for status values, fallbacks and summary derivation.
- `apps/orchestrator/src/reports/store.ts` — in-memory + JSON file report store facade.
- `apps/orchestrator/src/reports/lifecycle.ts` — pure helpers for creating and updating report artifacts.
- `apps/orchestrator/src/reports/render.ts` — GitLab note and Markdown renderers from a report.
- `apps/orchestrator/src/reports/merge-readiness.ts` — dry-run evaluator.
- `apps/orchestrator/src/reports/__tests__/store.test.ts`
- `apps/orchestrator/src/reports/__tests__/lifecycle.test.ts`
- `apps/orchestrator/src/reports/__tests__/render.test.ts`
- `apps/orchestrator/src/reports/__tests__/merge-readiness.test.ts`
- `apps/dashboard/components/command-center/command-center-page.tsx`
- `apps/dashboard/components/command-center/view-toggle.tsx`
- `apps/dashboard/components/command-center/run-list-view.tsx`
- `apps/dashboard/components/command-center/run-board-view.tsx`
- `apps/dashboard/components/command-center/review-packet-inspector.tsx`
- `apps/dashboard/components/command-center/command-center-page.test.tsx`
- `apps/dashboard/components/command-center/run-board-view.test.tsx`
- `apps/dashboard/components/detail/review-packet.tsx`
- `apps/dashboard/components/detail/review-packet.test.tsx`
- `apps/dashboard/app/reports/page.tsx`
- `apps/dashboard/components/reports/reports-page.tsx`
- `apps/dashboard/components/reports/reports-page.test.tsx`

Modify:

- `packages/shared-contracts/src/index.ts` — export report contracts.
- `packages/shared-contracts/src/api.ts` — add report fields to run list/detail responses.
- `apps/orchestrator/src/runtime/state.ts` — hold report summaries alongside run records.
- `apps/orchestrator/src/server/index.ts` — inject report store and return report data from `/api/runs`, `/api/runs/:runId`, `/api/reports`.
- `apps/orchestrator/src/daemon.ts` — create/update reports during claim, dispatch, reconcile, failure, CI sweep, review sweep and human-review closure.
- `apps/orchestrator/src/orchestrator/reconcile.ts` — accept report renderer output and return note/MR metadata for report updates.
- `apps/orchestrator/src/orchestrator/human-review.ts` — use report-backed closing note rendering.
- `apps/orchestrator/src/orchestrator/ci-feedback.ts` — update report CI state and readiness.
- `apps/orchestrator/src/orchestrator/review-feedback.ts` — update report review feedback state and readiness.
- `apps/dashboard/lib/api.ts` — expose report-aware API types.
- `apps/dashboard/app/page.tsx` — render Command Center instead of old overview composition.
- `apps/dashboard/components/overview/*` — keep reusable pieces where useful; do not delete until Command Center tests pass.
- `apps/dashboard/components/detail/run-detail-page.tsx` — promote top half to Review Packet.
- `README.md`, `README.zh-CN.md`, `USAGE.md`, `USAGE.zh-CN.md` — update roadmap / usage once implementation behavior exists.

---

## Task 1: Shared Report Contracts

**Files:**
- Create: `packages/shared-contracts/src/report.ts`
- Create: `packages/shared-contracts/src/__tests__/report.test.ts`
- Modify: `packages/shared-contracts/src/index.ts`
- Modify: `packages/shared-contracts/src/api.ts`

- [ ] **Step 1: Write failing contract tests**

Add `packages/shared-contracts/src/__tests__/report.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  MERGE_READINESS_STATUS_VALUES,
  RUN_REPORT_VERSION,
  buildRunReportSummary,
  isMergeReadinessStatus,
  type RunReportArtifact,
} from "../report.js";

const baseReport: RunReportArtifact = {
  version: RUN_REPORT_VERSION,
  runId: "run-1",
  issue: {
    projectId: "group/project",
    iid: 42,
    title: "Fix checkout",
    url: "https://gitlab.example.com/group/project/-/issues/42",
    labels: ["human-review"],
  },
  run: {
    status: "completed",
    attempt: 1,
    branch: "ai/42-fix-checkout",
    workspacePath: "/tmp/ws",
    startedAt: "2026-05-16T00:00:00.000Z",
    endedAt: "2026-05-16T00:05:00.000Z",
    durations: { totalMs: 300000, agentMs: 180000 },
  },
  mergeRequest: {
    iid: 7,
    url: "https://gitlab.example.com/group/project/-/merge_requests/7",
    state: "opened",
  },
  handoff: {
    summary: "Updated checkout copy.",
    validation: ["pnpm --filter @issuepilot/dashboard test passed"],
    risks: [{ level: "low", text: "Copy-only change." }],
    followUps: [],
    nextAction: "Review and merge the MR.",
  },
  diff: {
    summary: "1 file changed",
    filesChanged: 1,
    additions: 4,
    deletions: 1,
    notableFiles: ["apps/dashboard/app/page.tsx"],
  },
  checks: [
    {
      name: "dashboard tests",
      status: "passed",
      command: "pnpm --filter @issuepilot/dashboard test",
      durationMs: 12000,
    },
  ],
  mergeReadiness: {
    mode: "dry-run",
    status: "ready",
    reasons: [
      {
        code: "all_checks_satisfied",
        severity: "info",
        message: "CI, approvals, review feedback and risk checks passed.",
      },
    ],
    evaluatedAt: "2026-05-16T00:06:00.000Z",
  },
  notes: { handoffNoteId: 100 },
};

describe("report contracts", () => {
  it("exports the fixed report version", () => {
    expect(RUN_REPORT_VERSION).toBe(1);
  });

  it("recognises merge readiness statuses", () => {
    expect(MERGE_READINESS_STATUS_VALUES).toEqual([
      "ready",
      "not-ready",
      "blocked",
      "unknown",
    ]);
    expect(isMergeReadinessStatus("ready")).toBe(true);
    expect(isMergeReadinessStatus("enabled")).toBe(false);
  });

  it("builds a stable list summary from a full report", () => {
    expect(buildRunReportSummary(baseReport)).toEqual({
      runId: "run-1",
      issueIid: 42,
      issueTitle: "Fix checkout",
      projectId: "group/project",
      status: "completed",
      labels: ["human-review"],
      attempt: 1,
      branch: "ai/42-fix-checkout",
      mergeRequestUrl: "https://gitlab.example.com/group/project/-/merge_requests/7",
      ciStatus: undefined,
      mergeReadinessStatus: "ready",
      highestRisk: "low",
      updatedAt: "2026-05-16T00:05:00.000Z",
      totalMs: 300000,
    });
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
pnpm --filter @issuepilot/shared-contracts test -- src/__tests__/report.test.ts
```

Expected: FAIL because `../report.js` does not exist.

- [ ] **Step 3: Add the report contracts**

Create `packages/shared-contracts/src/report.ts`:

```ts
import type { PipelineStatus, RunStatus } from "./run.js";

export const RUN_REPORT_VERSION = 1 as const;

export const RISK_LEVEL_VALUES = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVEL_VALUES)[number];

export const MERGE_READINESS_STATUS_VALUES = [
  "ready",
  "not-ready",
  "blocked",
  "unknown",
] as const;
export type MergeReadinessStatus =
  (typeof MERGE_READINESS_STATUS_VALUES)[number];

export const isMergeReadinessStatus = (
  value: unknown,
): value is MergeReadinessStatus =>
  typeof value === "string" &&
  (MERGE_READINESS_STATUS_VALUES as readonly string[]).includes(value);

export interface MergeReadinessReason {
  code: string;
  severity: "info" | "warning" | "blocking";
  message: string;
}

export interface MergeReadinessResult {
  mode: "dry-run";
  status: MergeReadinessStatus;
  reasons: MergeReadinessReason[];
  evaluatedAt: string;
}

export interface RunReportArtifact {
  version: typeof RUN_REPORT_VERSION;
  runId: string;
  issue: {
    projectId: string;
    iid: number;
    title: string;
    url: string;
    labels: string[];
  };
  run: {
    status: RunStatus;
    attempt: number;
    branch: string;
    workspacePath: string;
    startedAt: string;
    endedAt?: string;
    durations: {
      totalMs?: number;
      queueMs?: number;
      workspaceMs?: number;
      agentMs?: number;
      reconcileMs?: number;
      reviewWaitMs?: number;
    };
    lastError?: {
      code: string;
      message: string;
      classification?: "failed" | "blocked" | "cancelled" | "unknown";
    };
  };
  mergeRequest?: {
    iid: number;
    url: string;
    state: "opened" | "merged" | "closed";
    approvals?: {
      required?: number;
      approvedBy: string[];
      satisfied: boolean;
    };
  };
  handoff: {
    summary: string;
    validation: string[];
    risks: Array<{ level: RiskLevel; text: string }>;
    followUps: string[];
    nextAction: string;
  };
  diff: {
    summary: string;
    filesChanged: number;
    additions?: number;
    deletions?: number;
    notableFiles: string[];
  };
  checks: Array<{
    name: string;
    status: "passed" | "failed" | "skipped" | "unknown";
    command?: string;
    durationMs?: number;
    details?: string;
  }>;
  ci?: {
    status: PipelineStatus;
    pipelineUrl?: string;
    checkedAt: string;
  };
  reviewFeedback?: {
    latestCursor?: string;
    unresolvedCount: number;
    comments: Array<{
      author: string;
      body: string;
      url: string;
      resolved: boolean;
      createdAt: string;
    }>;
  };
  mergeReadiness: MergeReadinessResult;
  notes: {
    handoffNoteId?: number;
    failureNoteId?: number;
    closingNoteId?: number;
  };
}

export interface RunReportSummary {
  runId: string;
  issueIid: number;
  issueTitle: string;
  projectId: string;
  status: RunStatus;
  labels: string[];
  attempt: number;
  branch: string;
  mergeRequestUrl?: string;
  ciStatus?: PipelineStatus;
  mergeReadinessStatus: MergeReadinessStatus;
  highestRisk?: RiskLevel;
  updatedAt: string;
  totalMs?: number;
}

const riskRank: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export function buildRunReportSummary(
  report: RunReportArtifact,
): RunReportSummary {
  const highestRisk = report.handoff.risks
    .map((risk) => risk.level)
    .sort((a, b) => riskRank[b] - riskRank[a])[0];
  return {
    runId: report.runId,
    issueIid: report.issue.iid,
    issueTitle: report.issue.title,
    projectId: report.issue.projectId,
    status: report.run.status,
    labels: [...report.issue.labels],
    attempt: report.run.attempt,
    branch: report.run.branch,
    ...(report.mergeRequest?.url
      ? { mergeRequestUrl: report.mergeRequest.url }
      : {}),
    ...(report.ci?.status ? { ciStatus: report.ci.status } : {}),
    mergeReadinessStatus: report.mergeReadiness.status,
    ...(highestRisk ? { highestRisk } : {}),
    updatedAt: report.run.endedAt ?? report.run.startedAt,
    ...(report.run.durations.totalMs !== undefined
      ? { totalMs: report.run.durations.totalMs }
      : {}),
  };
}
```

Update `packages/shared-contracts/src/index.ts`:

```ts
export * from "./report.js";
```

Append to existing exports, do not remove current exports.

- [ ] **Step 4: Extend API contracts**

In `packages/shared-contracts/src/api.ts`, import report types:

```ts
import {
  type RunReportArtifact,
  type RunReportSummary,
} from "./report.js";
```

Change `RunsListResponse`:

```ts
export interface RunsListResponse {
  runs: RunRecord[];
  reports?: RunReportSummary[];
}
```

Change `RunDetailResponse`:

```ts
export interface RunDetailResponse {
  run: RunRecord;
  events: IssuePilotEvent[];
  logsTail: string[];
  report?: RunReportArtifact;
}
```

Add:

```ts
export interface ReportsListResponse {
  reports: RunReportSummary[];
}
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm --filter @issuepilot/shared-contracts test -- src/__tests__/report.test.ts
pnpm --filter @issuepilot/shared-contracts typecheck
```

Expected: PASS.

Commit:

```bash
git add packages/shared-contracts/src/report.ts packages/shared-contracts/src/__tests__/report.test.ts packages/shared-contracts/src/index.ts packages/shared-contracts/src/api.ts
git commit -m "feat(contracts): add run report artifact"
```

---

## Task 2: Orchestrator Report Store and Lifecycle Helpers

**Files:**
- Create: `apps/orchestrator/src/reports/store.ts`
- Create: `apps/orchestrator/src/reports/lifecycle.ts`
- Create: `apps/orchestrator/src/reports/__tests__/store.test.ts`
- Create: `apps/orchestrator/src/reports/__tests__/lifecycle.test.ts`
- Modify: `apps/orchestrator/src/runtime/state.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Create `apps/orchestrator/src/reports/__tests__/lifecycle.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  createInitialReport,
  markReportFailed,
  updateReportHandoff,
} from "../lifecycle.js";

describe("report lifecycle", () => {
  it("creates an initial unknown-readiness report at claim time", () => {
    const report = createInitialReport({
      runId: "run-1",
      issue: {
        id: "issue-42",
        iid: 42,
        title: "Fix checkout",
        url: "https://gitlab.example.com/issues/42",
        projectId: "group/project",
        labels: ["ai-running"],
      },
      status: "running",
      attempt: 1,
      branch: "ai/42-fix-checkout",
      workspacePath: "/tmp/ws",
      startedAt: "2026-05-16T00:00:00.000Z",
    });

    expect(report.mergeReadiness).toEqual({
      mode: "dry-run",
      status: "unknown",
      reasons: [
        {
          code: "run_not_in_review",
          severity: "warning",
          message: "Run has not reached human-review yet.",
        },
      ],
      evaluatedAt: "2026-05-16T00:00:00.000Z",
    });
    expect(report.handoff.summary).toBe("not reported");
    expect(report.diff.summary).toBe("not available");
  });

  it("updates handoff fields without losing existing run metadata", () => {
    const report = createInitialReport({
      runId: "run-1",
      issue: {
        id: "issue-42",
        iid: 42,
        title: "Fix checkout",
        url: "https://gitlab.example.com/issues/42",
        projectId: "group/project",
        labels: ["ai-running"],
      },
      status: "running",
      attempt: 1,
      branch: "ai/42-fix-checkout",
      workspacePath: "/tmp/ws",
      startedAt: "2026-05-16T00:00:00.000Z",
    });

    const next = updateReportHandoff(report, {
      summary: "Updated checkout copy.",
      validation: ["pnpm test passed"],
      risks: [{ level: "low", text: "Copy-only." }],
      followUps: [],
      nextAction: "Review and merge the MR.",
    });

    expect(next.run.branch).toBe("ai/42-fix-checkout");
    expect(next.handoff.summary).toBe("Updated checkout copy.");
    expect(next.handoff.validation).toEqual(["pnpm test passed"]);
  });

  it("records failure classification on the run", () => {
    const report = createInitialReport({
      runId: "run-1",
      issue: {
        id: "issue-42",
        iid: 42,
        title: "Fix checkout",
        url: "https://gitlab.example.com/issues/42",
        projectId: "group/project",
        labels: ["ai-running"],
      },
      status: "running",
      attempt: 1,
      branch: "ai/42-fix-checkout",
      workspacePath: "/tmp/ws",
      startedAt: "2026-05-16T00:00:00.000Z",
    });

    const failed = markReportFailed(report, {
      status: "blocked",
      endedAt: "2026-05-16T00:02:00.000Z",
      lastError: {
        code: "missing_secret",
        message: "GITLAB_TOKEN is missing.",
        classification: "blocked",
      },
    });

    expect(failed.run.status).toBe("blocked");
    expect(failed.run.lastError?.code).toBe("missing_secret");
    expect(failed.run.durations.totalMs).toBe(120000);
  });
});
```

- [ ] **Step 2: Write failing store tests**

Create `apps/orchestrator/src/reports/__tests__/store.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createInitialReport } from "../lifecycle.js";
import { createReportStore } from "../store.js";

describe("report store", () => {
  it("persists reports as redacted JSON files and lists summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "issuepilot-report-"));
    try {
      const store = createReportStore({ rootDir: root });
      const report = createInitialReport({
        runId: "run-1",
        issue: {
          id: "issue-42",
          iid: 42,
          title: "Fix checkout",
          url: "https://gitlab.example.com/issues/42",
          projectId: "group/project",
          labels: ["ai-running"],
        },
        status: "running",
        attempt: 1,
        branch: "ai/42-fix-checkout",
        workspacePath: "/tmp/ws",
        startedAt: "2026-05-16T00:00:00.000Z",
      });

      await store.save(report);

      expect(await store.get("run-1")).toEqual(report);
      expect(store.summary("run-1")?.issueIid).toBe(42);
      expect(store.allSummaries()).toHaveLength(1);

      const body = await readFile(join(root, "reports", "run-1.json"), "utf8");
      expect(JSON.parse(body).runId).toBe("run-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Add lifecycle helpers**

Create `apps/orchestrator/src/reports/lifecycle.ts`:

```ts
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
  return {
    ...report,
    run: {
      ...report.run,
      status: input.status,
      endedAt: input.endedAt,
      lastError: input.lastError,
      durations: {
        ...report.run.durations,
        totalMs: elapsedMs(report.run.startedAt, input.endedAt),
      },
    },
  };
}
```

- [ ] **Step 4: Add report store**

Create `apps/orchestrator/src/reports/store.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { redact } from "@issuepilot/observability";
import {
  buildRunReportSummary,
  type RunReportArtifact,
  type RunReportSummary,
} from "@issuepilot/shared-contracts";

export interface ReportStore {
  save(report: RunReportArtifact): Promise<void>;
  get(runId: string): Promise<RunReportArtifact | undefined>;
  summary(runId: string): RunReportSummary | undefined;
  allSummaries(): RunReportSummary[];
}

export function createReportStore(opts: { rootDir: string }): ReportStore {
  const reports = new Map<string, RunReportArtifact>();
  const dir = join(opts.rootDir, "reports");

  async function save(report: RunReportArtifact): Promise<void> {
    reports.set(report.runId, report);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${report.runId}.json`),
      `${JSON.stringify(redact(report), null, 2)}\n`,
      "utf8",
    );
  }

  return {
    async save(report) {
      await save(report);
    },
    async get(runId) {
      const current = reports.get(runId);
      if (current) return current;
      try {
        const body = await readFile(join(dir, `${runId}.json`), "utf8");
        const parsed = JSON.parse(body) as RunReportArtifact;
        reports.set(runId, parsed);
        return parsed;
      } catch {
        return undefined;
      }
    },
    summary(runId) {
      const current = reports.get(runId);
      return current ? buildRunReportSummary(current) : undefined;
    },
    allSummaries() {
      return [...reports.values()].map(buildRunReportSummary);
    },
  };
}
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/reports/__tests__/lifecycle.test.ts src/reports/__tests__/store.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/orchestrator/src/reports packages/shared-contracts/src
git commit -m "feat(orchestrator): add run report store"
```

---

## Task 3: Report-Backed Note Rendering

**Files:**
- Create: `apps/orchestrator/src/reports/render.ts`
- Create: `apps/orchestrator/src/reports/__tests__/render.test.ts`
- Modify: `apps/orchestrator/src/orchestrator/reconcile.ts`
- Modify: `apps/orchestrator/src/orchestrator/human-review.ts`

- [ ] **Step 1: Write renderer tests**

Create `apps/orchestrator/src/reports/__tests__/render.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createInitialReport, updateReportHandoff } from "../lifecycle.js";
import {
  renderClosingNote,
  renderFailureNote,
  renderHandoffNote,
} from "../render.js";

function report() {
  return updateReportHandoff(
    {
      ...createInitialReport({
        runId: "run-1",
        issue: {
          id: "issue-42",
          iid: 42,
          title: "Fix checkout",
          url: "https://gitlab.example.com/issues/42",
          projectId: "group/project",
          labels: ["human-review"],
        },
        status: "completed",
        attempt: 1,
        branch: "ai/42-fix-checkout",
        workspacePath: "/tmp/ws",
        startedAt: "2026-05-16T00:00:00.000Z",
      }),
      mergeRequest: {
        iid: 7,
        url: "https://gitlab.example.com/group/project/-/merge_requests/7",
        state: "opened",
      },
    },
    {
      summary: "Updated checkout copy.",
      validation: ["pnpm test passed"],
      risks: [{ level: "low", text: "Copy-only." }],
      followUps: [],
      nextAction: "Review and merge the MR.",
    },
  );
}

describe("report renderers", () => {
  it("renders the handoff note from report fields", () => {
    const body = renderHandoffNote(report(), { handoffLabel: "human-review" });
    expect(body).toContain("<!-- issuepilot:run:run-1 -->");
    expect(body).toContain("## IssuePilot handoff");
    expect(body).toContain("- Status: human-review");
    expect(body).toContain("- MR: !7 https://gitlab.example.com/group/project/-/merge_requests/7");
    expect(body).toContain("### What changed\nUpdated checkout copy.");
    expect(body).toContain("### Validation\n- pnpm test passed");
    expect(body).toContain("### Risks / follow-ups\n- low: Copy-only.");
  });

  it("renders failure notes with lastError", () => {
    const failed = {
      ...report(),
      run: {
        ...report().run,
        status: "blocked" as const,
        lastError: {
          code: "missing_secret",
          message: "GITLAB_TOKEN is missing.",
          classification: "blocked" as const,
        },
      },
    };
    const body = renderFailureNote(failed, {
      statusLabel: "ai-blocked",
      readyLabel: "ai-ready",
    });
    expect(body).toContain("## IssuePilot run blocked");
    expect(body).toContain("- Status: ai-blocked");
    expect(body).toContain("GITLAB_TOKEN is missing.");
    expect(body).toContain("move this Issue back to `ai-ready`");
  });

  it("renders closing notes from merged MR state", () => {
    const closed = {
      ...report(),
      mergeRequest: {
        iid: 7,
        url: "https://gitlab.example.com/group/project/-/merge_requests/7",
        state: "merged" as const,
      },
    };
    const body = renderClosingNote(closed, { handoffLabel: "human-review" });
    expect(body).toContain("## IssuePilot closed this issue");
    expect(body).toContain("- Status: closed");
    expect(body).toContain("- MR: !7 https://gitlab.example.com/group/project/-/merge_requests/7");
  });
});
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/reports/__tests__/render.test.ts
```

Expected: FAIL because `../render.js` does not exist.

- [ ] **Step 3: Add renderers**

Create `apps/orchestrator/src/reports/render.ts`:

```ts
import type { RunReportArtifact } from "@issuepilot/shared-contracts";

function marker(report: RunReportArtifact): string {
  return `<!-- issuepilot:run:${report.runId} -->`;
}

function mrLine(report: RunReportArtifact): string {
  const mr = report.mergeRequest;
  if (!mr) return "not created";
  return `!${mr.iid} ${mr.url}`;
}

function bulletList(values: readonly string[]): string {
  return values.length === 0 ? "not reported" : values.map((v) => `- ${v}`).join("\n");
}

function riskList(report: RunReportArtifact): string {
  return report.handoff.risks.length === 0
    ? "None reported."
    : report.handoff.risks
        .map((risk) => `- ${risk.level}: ${risk.text}`)
        .join("\n");
}

export function renderHandoffNote(
  report: RunReportArtifact,
  opts: { handoffLabel: string },
): string {
  return [
    marker(report),
    "## IssuePilot handoff",
    "",
    `- Status: ${opts.handoffLabel}`,
    `- Run: \`${report.runId}\``,
    `- Attempt: ${report.run.attempt}`,
    `- Branch: \`${report.run.branch}\``,
    `- MR: ${mrLine(report)}`,
    "",
    "### What changed",
    report.handoff.summary,
    "",
    "### Validation",
    bulletList(report.handoff.validation),
    "",
    "### Risks / follow-ups",
    riskList(report),
    "",
    "### Next action",
    report.handoff.nextAction,
  ].join("\n");
}

export function renderFailureNote(
  report: RunReportArtifact,
  opts: { statusLabel: string; readyLabel: string },
): string {
  const blocked = report.run.status === "blocked";
  const title = blocked
    ? "## IssuePilot run blocked"
    : "## IssuePilot run failed";
  const error = report.run.lastError;
  return [
    title,
    "",
    `- Status: ${opts.statusLabel}`,
    `- Run: \`${report.runId}\``,
    `- Attempt: ${report.run.attempt}`,
    `- Branch: \`${report.run.branch}\``,
    "",
    "### Reason",
    error ? `${error.code}: ${error.message}` : "unknown",
    "",
    "### Next action",
    `Provide the missing information, permission, or fix, then move this Issue back to \`${opts.readyLabel}\`.`,
  ].join("\n");
}

export function renderClosingNote(
  report: RunReportArtifact,
  opts: { handoffLabel: string },
): string {
  return [
    "## IssuePilot closed this issue",
    "",
    "- Status: closed",
    `- Run: \`${report.runId}\``,
    `- Branch: \`${report.run.branch}\``,
    `- MR: ${mrLine(report)}`,
    "",
    "### Result",
    `The linked MR was merged by a human reviewer, so IssuePilot removed \`${opts.handoffLabel}\` and closed this Issue.`,
  ].join("\n");
}
```

- [ ] **Step 4: Refactor reconcile to use renderer**

Modify `apps/orchestrator/src/orchestrator/reconcile.ts` so `reconcile` accepts an optional report and returns side-effect metadata:

```ts
import type { RunReportArtifact } from "@issuepilot/shared-contracts";
import { renderHandoffNote } from "../reports/render.js";

export interface ReconcileResult {
  mergeRequest?: { iid: number; webUrl?: string };
  handoffNoteId?: number;
  hadNewCommits: boolean;
}
```

Add to `ReconcileInput`:

```ts
  report?: RunReportArtifact | undefined;
```

Replace `const noteBody = buildHandoffNote(input, handoffMr);` with:

```ts
  const noteBody = input.report
    ? renderHandoffNote(
        {
          ...input.report,
          mergeRequest: {
            iid: handoffMr.iid,
            url: handoffMr.webUrl ?? "",
            state: "opened",
          },
        },
        { handoffLabel: input.handoffLabel },
      )
    : buildHandoffNote(input, handoffMr);
```

Return `{ mergeRequest: handoffMr, handoffNoteId, hadNewCommits: true }` after note create/update. Keep old `buildHandoffNote` fallback in place for incremental rollout.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/reports/__tests__/render.test.ts src/orchestrator/__tests__/reconcile.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/orchestrator/src/reports/render.ts apps/orchestrator/src/reports/__tests__/render.test.ts apps/orchestrator/src/orchestrator/reconcile.ts
git commit -m "feat(orchestrator): render notes from run reports"
```

---

## Task 4: Merge Readiness Dry Run

**Files:**
- Create: `apps/orchestrator/src/reports/merge-readiness.ts`
- Create: `apps/orchestrator/src/reports/__tests__/merge-readiness.test.ts`
- Modify: `apps/orchestrator/src/orchestrator/ci-feedback.ts`
- Modify: `apps/orchestrator/src/orchestrator/review-feedback.ts`

- [ ] **Step 1: Write readiness tests**

Create `apps/orchestrator/src/reports/__tests__/merge-readiness.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createInitialReport } from "../lifecycle.js";
import { evaluateMergeReadiness } from "../merge-readiness.js";

function report() {
  return {
    ...createInitialReport({
      runId: "run-1",
      issue: {
        id: "issue-42",
        iid: 42,
        title: "Fix checkout",
        url: "https://gitlab.example.com/issues/42",
        projectId: "group/project",
        labels: ["human-review"],
      },
      status: "completed",
      attempt: 1,
      branch: "ai/42-fix-checkout",
      workspacePath: "/tmp/ws",
      startedAt: "2026-05-16T00:00:00.000Z",
    }),
    mergeRequest: {
      iid: 7,
      url: "https://gitlab.example.com/mr/7",
      state: "opened" as const,
      approvals: { required: 1, approvedBy: ["wangmeng5"], satisfied: true },
    },
    ci: {
      status: "success" as const,
      checkedAt: "2026-05-16T00:03:00.000Z",
    },
  };
}

describe("merge readiness dry run", () => {
  it("returns ready when all gates pass", () => {
    expect(
      evaluateMergeReadiness(report(), {
        evaluatedAt: "2026-05-16T00:04:00.000Z",
      }).status,
    ).toBe("ready");
  });

  it("blocks on missing approval", () => {
    const result = evaluateMergeReadiness(
      {
        ...report(),
        mergeRequest: {
          ...report().mergeRequest!,
          approvals: { required: 1, approvedBy: [], satisfied: false },
        },
      },
      { evaluatedAt: "2026-05-16T00:04:00.000Z" },
    );

    expect(result.status).toBe("blocked");
    expect(result.reasons.map((r) => r.code)).toContain("approval_missing");
  });

  it("blocks on unresolved review feedback", () => {
    const result = evaluateMergeReadiness(
      {
        ...report(),
        reviewFeedback: { unresolvedCount: 2, comments: [] },
      },
      { evaluatedAt: "2026-05-16T00:04:00.000Z" },
    );

    expect(result.status).toBe("blocked");
    expect(result.reasons.map((r) => r.code)).toContain("review_unresolved");
  });

  it("returns unknown when CI is unavailable", () => {
    const { ci: _ci, ...withoutCi } = report();
    const result = evaluateMergeReadiness(withoutCi, {
      evaluatedAt: "2026-05-16T00:04:00.000Z",
    });

    expect(result.status).toBe("unknown");
    expect(result.reasons.map((r) => r.code)).toContain("ci_unknown");
  });
});
```

- [ ] **Step 2: Add evaluator**

Create `apps/orchestrator/src/reports/merge-readiness.ts`:

```ts
import type {
  MergeReadinessReason,
  MergeReadinessResult,
  RunReportArtifact,
} from "@issuepilot/shared-contracts";

export interface MergeReadinessOptions {
  evaluatedAt: string;
  requireApproval?: boolean;
  requireCiSuccess?: boolean;
  blockOnHighRisk?: boolean;
  blockOnUnresolvedReview?: boolean;
}

export function evaluateMergeReadiness(
  report: RunReportArtifact,
  opts: MergeReadinessOptions,
): MergeReadinessResult {
  const reasons: MergeReadinessReason[] = [];

  if (report.run.status === "failed" || report.run.status === "blocked") {
    reasons.push({
      code: "run_not_successful",
      severity: "blocking",
      message: "Run is failed or blocked.",
    });
  }

  if (!report.issue.labels.includes("human-review")) {
    reasons.push({
      code: "issue_not_in_human_review",
      severity: "blocking",
      message: "Issue is not in human-review.",
    });
  }

  if (!report.mergeRequest) {
    reasons.push({
      code: "mr_missing",
      severity: "blocking",
      message: "Merge request is missing.",
    });
  } else if (report.mergeRequest.state !== "opened") {
    reasons.push({
      code: "mr_not_open",
      severity: "blocking",
      message: `Merge request state is ${report.mergeRequest.state}.`,
    });
  }

  if ((opts.requireCiSuccess ?? true) && !report.ci) {
    reasons.push({
      code: "ci_unknown",
      severity: "warning",
      message: "CI status is unavailable.",
    });
  } else if ((opts.requireCiSuccess ?? true) && report.ci?.status !== "success") {
    reasons.push({
      code: "ci_not_success",
      severity: "blocking",
      message: `CI status is ${report.ci?.status ?? "unknown"}.`,
    });
  }

  const approvals = report.mergeRequest?.approvals;
  if ((opts.requireApproval ?? true) && approvals && !approvals.satisfied) {
    reasons.push({
      code: "approval_missing",
      severity: "blocking",
      message: "Required approval is missing.",
    });
  }

  if (
    (opts.blockOnUnresolvedReview ?? true) &&
    (report.reviewFeedback?.unresolvedCount ?? 0) > 0
  ) {
    reasons.push({
      code: "review_unresolved",
      severity: "blocking",
      message: "Unresolved review feedback is present.",
    });
  }

  if (
    (opts.blockOnHighRisk ?? true) &&
    report.handoff.risks.some((risk) => risk.level === "high")
  ) {
    reasons.push({
      code: "high_risk",
      severity: "blocking",
      message: "High-risk handoff item is present.",
    });
  }

  const blocking = reasons.some((reason) => reason.severity === "blocking");
  const warningOnly =
    reasons.length > 0 && reasons.every((reason) => reason.severity === "warning");

  return {
    mode: "dry-run",
    status: blocking ? "blocked" : warningOnly ? "unknown" : "ready",
    reasons:
      reasons.length === 0
        ? [
            {
              code: "all_checks_satisfied",
              severity: "info",
              message: "CI, approval, review feedback and risk checks passed.",
            },
          ]
        : reasons,
    evaluatedAt: opts.evaluatedAt,
  };
}
```

- [ ] **Step 3: Wire evaluator into CI/review sweeps**

After CI or review feedback updates a run record, fetch the report, update `ci` or `reviewFeedback`, recompute readiness, and save. The call shape in both sweep modules should look like:

```ts
const currentReport = await deps.reports?.get(run.runId);
if (currentReport) {
  const nextReport = {
    ...currentReport,
    ci: {
      status,
      checkedAt: checkedAtIso,
    },
  };
  await deps.reports?.save({
    ...nextReport,
    mergeReadiness: evaluateMergeReadiness(nextReport, {
      evaluatedAt: checkedAtIso,
    }),
  });
}
```

Add optional `reports?: ReportStore` to the scanner dependency interfaces so existing tests can omit it.

- [ ] **Step 4: Verify and commit**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/reports/__tests__/merge-readiness.test.ts src/orchestrator/__tests__/ci-feedback.test.ts src/orchestrator/__tests__/review-feedback.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/orchestrator/src/reports/merge-readiness.ts apps/orchestrator/src/reports/__tests__/merge-readiness.test.ts apps/orchestrator/src/orchestrator/ci-feedback.ts apps/orchestrator/src/orchestrator/review-feedback.ts
git commit -m "feat(orchestrator): evaluate merge readiness dry run"
```

---

## Task 5: API Integration

**Files:**
- Modify: `apps/orchestrator/src/server/index.ts`
- Modify: `apps/orchestrator/src/server/__tests__/server.test.ts`
- Modify: `apps/dashboard/lib/api.ts`
- Modify: `apps/dashboard/lib/api.test.ts`

- [ ] **Step 1: Add server tests for report payloads**

In `apps/orchestrator/src/server/__tests__/server.test.ts`, add a test that starts the server with a fake report store and asserts:

```ts
expect(await app.inject({ method: "GET", url: "/api/runs" })).toMatchObject({
  statusCode: 200,
});

const listBody = JSON.parse(listResponse.body);
expect(listBody[0].report.mergeReadinessStatus).toBe("ready");

const detailBody = JSON.parse(detailResponse.body);
expect(detailBody.report.runId).toBe("run-1");
```

Use a fake report store object:

```ts
const reports = {
  summary: (runId: string) =>
    runId === "run-1"
      ? {
          runId: "run-1",
          issueIid: 42,
          issueTitle: "Fix checkout",
          projectId: "group/project",
          status: "completed",
          labels: ["human-review"],
          attempt: 1,
          branch: "ai/42-fix-checkout",
          mergeReadinessStatus: "ready",
          updatedAt: "2026-05-16T00:00:00.000Z",
        }
      : undefined,
  get: async (runId: string) =>
    runId === "run-1" ? fullReportFixture : undefined,
  allSummaries: () => [summaryFixture],
};
```

- [ ] **Step 2: Extend server dependencies and response shaping**

In `apps/orchestrator/src/server/index.ts`, import:

```ts
import type { ReportStore } from "../reports/store.js";
```

Add to `ServerDeps`:

```ts
  reports?: ReportStore;
```

Change `enrichRunForDashboard` return to include report summary when present:

```ts
function enrichRunForDashboard<T extends Record<string, unknown>>(
  run: T,
  events: EventRecord[],
  reports?: ReportStore,
): T & {
  turnCount: number;
  lastEvent?: { type: string; message: string; createdAt?: string };
  report?: ReturnType<ReportStore["summary"]>;
} {
  const lastEvent = summarizeLastEvent(events);
  const runId = typeof run["runId"] === "string" ? run["runId"] : "";
  const report = runId ? reports?.summary(runId) : undefined;
  return {
    ...run,
    turnCount: countTurnEvents(events),
    ...(lastEvent ? { lastEvent } : {}),
    ...(report ? { report } : {}),
  };
}
```

Pass `deps.reports` from `/api/runs` and `/api/runs/:runId`. In detail route, also add:

```ts
const report = await deps.reports?.get(runId);
return {
  run: enrichRunForDashboard(run, events, deps.reports),
  events,
  logsTail,
  ...(report ? { report } : {}),
};
```

Add:

```ts
app.get("/api/reports", async () => {
  return { reports: deps.reports?.allSummaries() ?? [] };
});
```

- [ ] **Step 3: Update dashboard API tests**

In `apps/dashboard/lib/api.test.ts`, assert `getRunDetail` preserves the optional `report` field. Use a mocked fetch response with:

```ts
{
  run: runFixture,
  events: [],
  logsTail: [],
  report: reportFixture,
}
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/server/__tests__/server.test.ts
pnpm --filter @issuepilot/dashboard test -- lib/api.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
pnpm --filter @issuepilot/dashboard typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/orchestrator/src/server/index.ts apps/orchestrator/src/server/__tests__/server.test.ts apps/dashboard/lib/api.ts apps/dashboard/lib/api.test.ts packages/shared-contracts/src/api.ts
git commit -m "feat(api): expose run reports to dashboard"
```

---

## Task 6: Command Center List and Board UI

**Files:**
- Create: `apps/dashboard/components/command-center/command-center-page.tsx`
- Create: `apps/dashboard/components/command-center/view-toggle.tsx`
- Create: `apps/dashboard/components/command-center/run-list-view.tsx`
- Create: `apps/dashboard/components/command-center/run-board-view.tsx`
- Create: `apps/dashboard/components/command-center/review-packet-inspector.tsx`
- Create: `apps/dashboard/components/command-center/command-center-page.test.tsx`
- Create: `apps/dashboard/components/command-center/run-board-view.test.tsx`
- Modify: `apps/dashboard/app/page.tsx`

- [ ] **Step 1: Add UI tests**

Create `apps/dashboard/components/command-center/command-center-page.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CommandCenterPage } from "./command-center-page";

const runs = [
  {
    runId: "run-1",
    issue: {
      id: "issue-42",
      iid: 42,
      title: "Fix checkout",
      url: "https://gitlab.example.com/issues/42",
      projectId: "group/project",
      labels: ["human-review"],
    },
    status: "completed",
    attempt: 1,
    branch: "ai/42-fix-checkout",
    workspacePath: "/tmp/ws",
    startedAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:05:00.000Z",
    report: {
      runId: "run-1",
      issueIid: 42,
      issueTitle: "Fix checkout",
      projectId: "group/project",
      status: "completed",
      labels: ["human-review"],
      attempt: 1,
      branch: "ai/42-fix-checkout",
      mergeRequestUrl: "https://gitlab.example.com/mr/7",
      ciStatus: "success",
      mergeReadinessStatus: "ready",
      highestRisk: "low",
      updatedAt: "2026-05-16T00:05:00.000Z",
      totalMs: 300000,
    },
  },
] as const;

describe("CommandCenterPage", () => {
  it("renders list view and opens inspector from a run row", async () => {
    render(
      <CommandCenterPage
        initialSnapshot={{
          service: {
            status: "ready",
            workflowPath: "/repo/WORKFLOW.md",
            gitlabProject: "group/project",
            pollIntervalMs: 10000,
            concurrency: 2,
            lastConfigReloadAt: null,
            lastPollAt: null,
          },
          summary: {
            running: 0,
            retrying: 0,
            "human-review": 1,
            failed: 0,
            blocked: 0,
          },
        }}
        initialRuns={[...runs]}
        refetch={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Command Center" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Fix checkout/ }));
    expect(screen.getByText("Review Packet")).toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
  });
});
```

Create `apps/dashboard/components/command-center/run-board-view.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RunBoardView } from "./run-board-view";

describe("RunBoardView", () => {
  it("groups runs by workflow label", () => {
    render(
      <RunBoardView
        runs={[
          {
            runId: "run-1",
            issue: {
              id: "issue-42",
              iid: 42,
              title: "Fix checkout",
              url: "https://gitlab.example.com/issues/42",
              projectId: "group/project",
              labels: ["human-review"],
            },
            status: "completed",
            attempt: 1,
            branch: "ai/42-fix-checkout",
            workspacePath: "/tmp/ws",
            startedAt: "2026-05-16T00:00:00.000Z",
            updatedAt: "2026-05-16T00:05:00.000Z",
          },
        ]}
        selectedRunId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "human-review" })).toBeInTheDocument();
    expect(screen.getByText("Fix checkout")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement view toggle and grouping**

`view-toggle.tsx`:

```tsx
export type CommandCenterView = "list" | "board";

export function ViewToggle({
  value,
  onChange,
}: {
  value: CommandCenterView;
  onChange: (value: CommandCenterView) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-zinc-200 bg-white p-0.5">
      {(["list", "board"] as const).map((view) => (
        <button
          key={view}
          type="button"
          className={
            value === view
              ? "rounded px-3 py-1.5 text-sm font-medium text-white bg-zinc-900"
              : "rounded px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-900"
          }
          aria-pressed={value === view}
          onClick={() => onChange(view)}
        >
          {view === "list" ? "List" : "Board"}
        </button>
      ))}
    </div>
  );
}
```

`run-board-view.tsx` should group by labels in this order:

```ts
const COLUMNS = [
  "ai-ready",
  "ai-running",
  "ai-rework",
  "human-review",
  "ai-failed",
  "ai-blocked",
] as const;
```

Use button cards, not draggable cards. Each card calls `onSelect(run.runId)`.

- [ ] **Step 3: Replace home page composition**

In `apps/dashboard/app/page.tsx`, replace `OverviewPage` with `CommandCenterPage`, keeping the same `fetchOverview` and `refreshAction` shape.

- [ ] **Step 4: Verify and commit**

Run:

```bash
pnpm --filter @issuepilot/dashboard test -- components/command-center/command-center-page.test.tsx components/command-center/run-board-view.test.tsx
pnpm --filter @issuepilot/dashboard typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/dashboard/app/page.tsx apps/dashboard/components/command-center
git commit -m "feat(dashboard): add command center views"
```

---

## Task 7: Review Packet and Reports Page

**Files:**
- Create: `apps/dashboard/components/detail/review-packet.tsx`
- Create: `apps/dashboard/components/detail/review-packet.test.tsx`
- Create: `apps/dashboard/app/reports/page.tsx`
- Create: `apps/dashboard/components/reports/reports-page.tsx`
- Create: `apps/dashboard/components/reports/reports-page.test.tsx`
- Modify: `apps/dashboard/components/detail/run-detail-page.tsx`

- [ ] **Step 1: Add Review Packet test**

Create `apps/dashboard/components/detail/review-packet.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReviewPacket } from "./review-packet";

describe("ReviewPacket", () => {
  it("renders handoff, checks and merge readiness from report", () => {
    render(
      <ReviewPacket
        report={{
          version: 1,
          runId: "run-1",
          issue: {
            projectId: "group/project",
            iid: 42,
            title: "Fix checkout",
            url: "https://gitlab.example.com/issues/42",
            labels: ["human-review"],
          },
          run: {
            status: "completed",
            attempt: 1,
            branch: "ai/42-fix-checkout",
            workspacePath: "/tmp/ws",
            startedAt: "2026-05-16T00:00:00.000Z",
            durations: {},
          },
          handoff: {
            summary: "Updated checkout copy.",
            validation: ["pnpm test passed"],
            risks: [{ level: "low", text: "Copy-only." }],
            followUps: [],
            nextAction: "Review and merge the MR.",
          },
          diff: {
            summary: "1 file changed",
            filesChanged: 1,
            notableFiles: ["apps/dashboard/app/page.tsx"],
          },
          checks: [{ name: "dashboard tests", status: "passed" }],
          mergeReadiness: {
            mode: "dry-run",
            status: "ready",
            reasons: [
              {
                code: "all_checks_satisfied",
                severity: "info",
                message: "CI, approval, review feedback and risk checks passed.",
              },
            ],
            evaluatedAt: "2026-05-16T00:05:00.000Z",
          },
          notes: {},
        }}
      />,
    );

    expect(screen.getByText("Updated checkout copy.")).toBeInTheDocument();
    expect(screen.getByText("pnpm test passed")).toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement `ReviewPacket`**

Create `apps/dashboard/components/detail/review-packet.tsx`:

```tsx
import type { RunReportArtifact } from "@issuepilot/shared-contracts";

import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

export function ReviewPacket({ report }: { report: RunReportArtifact }) {
  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Handoff</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>{report.handoff.summary}</p>
          <div>
            <h3 className="text-xs font-semibold uppercase text-slate-500">
              Validation
            </h3>
            <ul className="mt-1 list-disc pl-5">
              {report.handoff.validation.length === 0 ? (
                <li>not reported</li>
              ) : (
                report.handoff.validation.map((item) => <li key={item}>{item}</li>)
              )}
            </ul>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Merge readiness</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Badge tone={report.mergeReadiness.status === "ready" ? "success" : "warning"}>
            {report.mergeReadiness.status}
          </Badge>
          <ul className="list-disc pl-5">
            {report.mergeReadiness.reasons.map((reason) => (
              <li key={reason.code}>{reason.message}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}
```

- [ ] **Step 3: Use Review Packet in run detail**

In `apps/dashboard/components/detail/run-detail-page.tsx`, accept `report?: RunReportArtifact` and render:

```tsx
{report ? (
  <ReviewPacket report={report} />
) : (
  <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
    This is a legacy run without a generated report. Timeline and logs remain available below.
  </p>
)}
```

Wire `report` from `apps/dashboard/app/runs/[runId]/page.tsx`.

- [ ] **Step 4: Add Reports page**

`apps/dashboard/app/reports/page.tsx` fetches `/api/reports` through `apiGet<ReportsListResponse>("/api/reports")` and renders `ReportsPage`.

`ReportsPage` should show:

- total reports
- ready-to-merge count
- blocked count
- failed count
- simple duration table

Keep charts as accessible tables for the first implementation.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm --filter @issuepilot/dashboard test -- components/detail/review-packet.test.tsx components/reports/reports-page.test.tsx
pnpm --filter @issuepilot/dashboard typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/dashboard/components/detail apps/dashboard/app/runs apps/dashboard/app/reports apps/dashboard/components/reports
git commit -m "feat(dashboard): add review packet and reports"
```

---

## Task 8: End-to-End Wiring and Docs

**Files:**
- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `apps/orchestrator/src/__tests__/daemon.test.ts`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `USAGE.md`
- Modify: `USAGE.zh-CN.md`

- [ ] **Step 1: Wire report store into daemon**

In `apps/orchestrator/src/daemon.ts`, create the store near runtime state setup, immediately after `eventStore`:

```ts
const reportStore = createReportStore({
  rootDir: path.join(workflow.workspace.root, ".issuepilot"),
});
```

Pass `reportStore` to these call sites:

- `createServer({ reports: reportStore, ... })`
- `reconcile({ report: await reportStore.get(runId), ... })`
- CI feedback scanner
- review feedback scanner

At claim time, save `createInitialReport` with the claimed issue, `runId`, `attempt`, `branch`, `workspacePath`, and `startedAt` already used for the `RunRecord`.

At failure time, load report, call `markReportFailed` with the existing `classification`, save report, and render failure note from report.

- [ ] **Step 2: Add daemon integration test**

In `apps/orchestrator/src/__tests__/daemon.test.ts`, add a fake run assertion:

```ts
expect(await api.get(`/api/runs/${runId}`)).toMatchObject({
  report: {
    runId,
    mergeReadiness: { mode: "dry-run" },
  },
});
```

If daemon test helpers use direct Fastify injection, assert the injected JSON response instead of `api.get`.

- [ ] **Step 3: Update docs**

Update README/USAGE in English and Chinese:

- V2.5 Command Center supports List / Board.
- Review Packet uses Run Report.
- merge readiness is dry-run only.
- true auto merge is still out of scope.
- Reports show quality and timing metrics from local report artifacts.

Use the same meaning in both languages.

- [ ] **Step 4: Run full verification**

Run:

```bash
git diff --check
pnpm --filter @issuepilot/shared-contracts test
pnpm --filter @issuepilot/orchestrator test
pnpm --filter @issuepilot/dashboard test
pnpm --filter @issuepilot/shared-contracts typecheck
pnpm --filter @issuepilot/orchestrator typecheck
pnpm --filter @issuepilot/dashboard typecheck
```

Expected: PASS.

If package entrypoints fail because `dist` is missing in a fresh worktree, run:

```bash
pnpm -w turbo run build
```

Then rerun the failed package command.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/daemon.ts apps/orchestrator/src/__tests__/daemon.test.ts README.md README.zh-CN.md USAGE.md USAGE.zh-CN.md
git commit -m "feat(issuepilot): wire v25 command center reports"
```

---

## Self-Review Notes

Spec coverage:

- Command Center List / Board: Task 6.
- Review Packet: Task 7.
- RunReportArtifact: Task 1.
- Report store and lifecycle: Task 2.
- GitLab note rendering from report: Task 3.
- Merge readiness dry run: Task 4.
- API surface: Task 5.
- Reports and docs: Task 7 and Task 8.
- Rollback safety: incremental commits allow UI, renderer, evaluator and store rollback separately.

Risk controls:

- Old note renderer remains as fallback during Task 3 until daemon wiring is complete.
- Dashboard supports missing `report` for legacy runs.
- Merge readiness is dry-run only and never calls GitLab merge APIs.
- Board View is non-dragging; status remains controlled by GitLab labels and orchestrator.
