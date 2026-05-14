import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  chooseMergeRequest,
  parseIssuePilotWorkpad,
  reconcileHumanReview,
  type HumanReviewInput,
} from "../human-review.js";

function createMocks() {
  return {
    gitlab: {
      listHumanReviewIssues: vi.fn(async () => []),
      getIssue: vi.fn(async (iid: number) => ({
        iid,
        title: `Issue ${iid}`,
        labels: ["human-review"],
        state: "opened",
      })),
      findLatestIssuePilotWorkpadNote: vi.fn(async () => null),
      listMergeRequestsBySourceBranch: vi.fn(async () => []),
      createIssueNote: vi.fn(async () => ({ id: 1 })),
      closeIssue: vi.fn(async () => ({
        labels: [],
        state: "closed",
      })),
      transitionLabels: vi.fn(async () => ({
        labels: ["ai-rework"],
      })),
    },
    events: [] as Array<{ type: string; [key: string]: unknown }>,
  };
}

function baseInput(mocks: ReturnType<typeof createMocks>): HumanReviewInput {
  return {
    handoffLabel: "human-review",
    reworkLabel: "ai-rework",
    gitlab: mocks.gitlab,
    onEvent: (event) => mocks.events.push(event),
  };
}

function workpad(runId = "run-7", branch = "ai/7-add-x"): string {
  return [
    `<!-- issuepilot:run:${runId} -->`,
    `**IssuePilot run** \`${runId}\` - attempt 1`,
    "",
    `- Branch: \`${branch}\``,
    "- Status: completed",
  ].join("\n");
}

function expectIssueMrEvent(
  events: ReturnType<typeof createMocks>["events"],
  type: string,
  mrState: string,
): void {
  expect(events).toContainEqual(
    expect.objectContaining({
      type,
      issueIid: 7,
      runId: "run-7",
      detail: expect.objectContaining({
        branch: "ai/7-add-x",
        mrIid: 70,
        mrState,
      }),
    }),
  );
}

describe("parseIssuePilotWorkpad", () => {
  it("parses colon marker and backticked branch", () => {
    expect(parseIssuePilotWorkpad(workpad("run-7", "ai/7-add-x"))).toEqual({
      runId: "run-7",
      branch: "ai/7-add-x",
    });
  });

  it("parses equals marker and plain branch", () => {
    expect(
      parseIssuePilotWorkpad(
        [
          "<!-- issuepilot:run=run-8 -->",
          "**IssuePilot run** `run-8` - attempt 1",
          "",
          "- Branch: ai/8-add-y",
        ].join("\n"),
      ),
    ).toEqual({
      runId: "run-8",
      branch: "ai/8-add-y",
    });
  });
});

describe("chooseMergeRequest", () => {
  it("prioritizes opened, then recent merged, then recent closed with defensive dates", () => {
    expect(
      chooseMergeRequest([
        {
          iid: 1,
          webUrl: "https://gitlab.example.com/mr/1",
          state: "merged",
          sourceBranch: "ai/1-add-x",
          updatedAt: "2026-05-13T10:00:00.000Z",
        },
        {
          iid: 2,
          webUrl: "https://gitlab.example.com/mr/2",
          state: "opened",
          sourceBranch: "ai/1-add-x",
          updatedAt: "not-a-date",
        },
      ])?.iid,
    ).toBe(2);

    expect(
      chooseMergeRequest([
        {
          iid: 3,
          webUrl: "https://gitlab.example.com/mr/3",
          state: "closed",
          sourceBranch: "ai/1-add-x",
          updatedAt: "2026-05-14T10:00:00.000Z",
        },
        {
          iid: 4,
          webUrl: "https://gitlab.example.com/mr/4",
          state: "merged",
          sourceBranch: "ai/1-add-x",
          updatedAt: "2026-05-13T10:00:00.000Z",
        },
        {
          iid: 5,
          webUrl: "https://gitlab.example.com/mr/5",
          state: "merged",
          sourceBranch: "ai/1-add-x",
          updatedAt: "2026-05-14T09:00:00.000Z",
        },
      ])?.iid,
    ).toBe(5);

    expect(
      chooseMergeRequest([
        {
          iid: 6,
          webUrl: "https://gitlab.example.com/mr/6",
          state: "closed",
          sourceBranch: "ai/1-add-x",
          updatedAt: "invalid",
        },
        {
          iid: 7,
          webUrl: "https://gitlab.example.com/mr/7",
          state: "closed",
          sourceBranch: "ai/1-add-x",
          updatedAt: "2026-05-14T09:00:00.000Z",
        },
      ])?.iid,
    ).toBe(7);
  });
});

describe("reconcileHumanReview", () => {
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
    mocks.gitlab.listHumanReviewIssues.mockResolvedValue([
      {
        iid: 7,
        title: "Add x",
        labels: ["human-review"],
        state: "opened",
      },
    ]);
    mocks.gitlab.findLatestIssuePilotWorkpadNote.mockResolvedValue({
      id: 10,
      body: workpad("run-7", "ai/7-add-x"),
    });
  });

  it("emits MR merged and closes the issue when the matching MR is merged", async () => {
    mocks.gitlab.listMergeRequestsBySourceBranch.mockResolvedValue([
      {
        iid: 70,
        webUrl: "https://gitlab.example.com/mr/70",
        state: "merged",
        sourceBranch: "ai/7-add-x",
        updatedAt: "2026-05-14T09:00:00.000Z",
      },
    ]);

    await reconcileHumanReview(baseInput(mocks));

    expect(mocks.gitlab.getIssue).toHaveBeenCalledWith(7);
    expect(mocks.gitlab.createIssueNote).toHaveBeenCalledWith(
      7,
      expect.stringContaining("MR !70 was merged"),
    );
    expect(mocks.gitlab.closeIssue).toHaveBeenCalledWith(7, {
      removeLabels: ["human-review"],
      requireCurrent: ["human-review"],
    });
    expectIssueMrEvent(mocks.events, "human_review_mr_merged", "merged");
    expectIssueMrEvent(mocks.events, "human_review_issue_closed", "merged");
  });

  it("keeps the issue unchanged when the matching MR is opened", async () => {
    mocks.gitlab.listMergeRequestsBySourceBranch.mockResolvedValue([
      {
        iid: 70,
        webUrl: "https://gitlab.example.com/mr/70",
        state: "opened",
        sourceBranch: "ai/7-add-x",
      },
    ]);

    await reconcileHumanReview(baseInput(mocks));

    expect(mocks.gitlab.createIssueNote).not.toHaveBeenCalled();
    expect(mocks.gitlab.closeIssue).not.toHaveBeenCalled();
    expect(mocks.gitlab.transitionLabels).not.toHaveBeenCalled();
    expectIssueMrEvent(
      mocks.events,
      "human_review_mr_still_open",
      "opened",
    );
  });

  it("emits MR closed unmerged and moves the issue to ai-rework", async () => {
    mocks.gitlab.listMergeRequestsBySourceBranch.mockResolvedValue([
      {
        iid: 70,
        webUrl: "https://gitlab.example.com/mr/70",
        state: "closed",
        sourceBranch: "ai/7-add-x",
      },
    ]);

    await reconcileHumanReview(baseInput(mocks));

    expect(mocks.gitlab.transitionLabels).toHaveBeenCalledWith(7, {
      add: ["ai-rework"],
      remove: ["human-review"],
      requireCurrent: ["human-review"],
    });
    expect(mocks.gitlab.closeIssue).not.toHaveBeenCalled();
    expectIssueMrEvent(
      mocks.events,
      "human_review_mr_closed_unmerged",
      "closed",
    );
    expectIssueMrEvent(mocks.events, "human_review_rework_requested", "closed");
  });

  it("does not close when no workpad note exists", async () => {
    mocks.gitlab.findLatestIssuePilotWorkpadNote.mockResolvedValue(null);

    await reconcileHumanReview(baseInput(mocks));

    expect(mocks.gitlab.listMergeRequestsBySourceBranch).not.toHaveBeenCalled();
    expect(mocks.gitlab.closeIssue).not.toHaveBeenCalled();
    expect(mocks.events).toContainEqual(
      expect.objectContaining({
        type: "human_review_mr_missing",
        issueIid: 7,
        runId: "human-review-scan",
        detail: expect.objectContaining({ reason: "missing_workpad" }),
      }),
    );
  });

  it("does not close when the issue lost human-review before close", async () => {
    mocks.gitlab.listMergeRequestsBySourceBranch.mockResolvedValue([
      {
        iid: 70,
        webUrl: "https://gitlab.example.com/mr/70",
        state: "merged",
        sourceBranch: "ai/7-add-x",
      },
    ]);
    mocks.gitlab.getIssue.mockResolvedValue({
      iid: 7,
      title: "Add x",
      labels: [],
      state: "opened",
    });

    await reconcileHumanReview(baseInput(mocks));

    expect(mocks.gitlab.createIssueNote).not.toHaveBeenCalled();
    expect(mocks.gitlab.closeIssue).not.toHaveBeenCalled();
    expect(mocks.events).toContainEqual(
      expect.objectContaining({
        type: "human_review_reconcile_failed",
        issueIid: 7,
        runId: "run-7",
        detail: expect.objectContaining({
          reason: "issue_state_changed",
          branch: "ai/7-add-x",
          mrIid: 70,
          mrState: "merged",
        }),
      }),
    );
  });
});
