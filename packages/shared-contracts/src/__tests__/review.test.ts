import { describe, it, expect, expectTypeOf } from "vitest";

import type {
  ReviewComment,
  ReviewFeedbackSummary,
} from "../review.js";

describe("@issuepilot/shared-contracts/review", () => {
  it("ReviewComment requires the structured note fields used by the prompt injector", () => {
    expectTypeOf<ReviewComment>().toHaveProperty("noteId").toEqualTypeOf<number>();
    expectTypeOf<ReviewComment>().toHaveProperty("author").toEqualTypeOf<string>();
    expectTypeOf<ReviewComment>().toHaveProperty("body").toEqualTypeOf<string>();
    expectTypeOf<ReviewComment>().toHaveProperty("url").toEqualTypeOf<string>();
    expectTypeOf<ReviewComment>()
      .toHaveProperty("createdAt")
      .toEqualTypeOf<string>();
    expectTypeOf<ReviewComment>()
      .toHaveProperty("resolved")
      .toEqualTypeOf<boolean>();
    expectTypeOf<ReviewComment>()
      .toHaveProperty("discussionId")
      .toEqualTypeOf<string | undefined>();
  });

  it("ReviewFeedbackSummary tracks the MR context, ISO cursor and the comment list", () => {
    expectTypeOf<ReviewFeedbackSummary>()
      .toHaveProperty("mrIid")
      .toEqualTypeOf<number>();
    expectTypeOf<ReviewFeedbackSummary>()
      .toHaveProperty("mrUrl")
      .toEqualTypeOf<string>();
    expectTypeOf<ReviewFeedbackSummary>()
      .toHaveProperty("generatedAt")
      .toEqualTypeOf<string>();
    expectTypeOf<ReviewFeedbackSummary>()
      .toHaveProperty("cursor")
      .toEqualTypeOf<string>();
    expectTypeOf<ReviewFeedbackSummary>()
      .toHaveProperty("comments")
      .toEqualTypeOf<ReviewComment[]>();
  });

  it("ReviewFeedbackSummary literal compiles with no comments and an ISO cursor", () => {
    const summary: ReviewFeedbackSummary = {
      mrIid: 42,
      mrUrl: "https://gitlab.example.com/group/web/-/merge_requests/42",
      generatedAt: "2026-05-16T00:00:00.000Z",
      cursor: "2026-05-16T00:00:00.000Z",
      comments: [],
    };

    expect(summary.comments).toEqual([]);
  });

  it("ReviewFeedbackSummary carries hand-curated reviewer comments", () => {
    const comment: ReviewComment = {
      noteId: 1001,
      author: "alice",
      body: "Please remove the debug log before merging.",
      url: "https://gitlab.example.com/group/web/-/merge_requests/42#note_1001",
      createdAt: "2026-05-16T00:01:00.000Z",
      discussionId: "disc-1",
      resolved: false,
    };

    const summary: ReviewFeedbackSummary = {
      mrIid: 42,
      mrUrl: "https://gitlab.example.com/group/web/-/merge_requests/42",
      generatedAt: "2026-05-16T00:01:00.000Z",
      cursor: "2026-05-16T00:01:00.000Z",
      comments: [comment],
    };

    expect(summary.comments).toHaveLength(1);
    expect(summary.comments[0]?.author).toBe("alice");
    expect(summary.comments[0]?.resolved).toBe(false);
  });
});
