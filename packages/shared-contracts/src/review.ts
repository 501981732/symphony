/**
 * Structured GitLab MR note captured by the V2 Phase 4 review feedback
 * sweep. The orchestrator collects these from `listMergeRequestNotes`
 * after filtering out IssuePilot's own marker notes (handoff / failure /
 * closing / ci-feedback) so the remaining payload is purely human review.
 *
 * Comments are not summarized by an LLM at this phase — the prompt
 * template renders the raw `body`. Truncation, if any, happens at the
 * dashboard layer (see Task 5) and is never applied to the prompt
 * context. Keep this type stable: the workflow renderer iterates over
 * `comments` to build the `## Review feedback` block.
 */
export interface ReviewComment {
  /** GitLab note id (numeric); unique per MR. */
  noteId: number;
  /** GitLab username or display name of the reviewer who posted the note. */
  author: string;
  /** Raw note body. Already redacted of IssuePilot marker comments. */
  body: string;
  /** Permalink to the note on GitLab (includes `#note_<id>` anchor). */
  url: string;
  /** ISO-8601 timestamp from GitLab; also used as the sweep cursor source. */
  createdAt: string;
  /**
   * MR-side discussion id, used to group threaded replies. Optional
   * because individual notes (non-discussion) can also surface as review
   * feedback.
   */
  discussionId?: string;
  /**
   * Whether the reviewer marked the surrounding discussion as resolved.
   * The sweep still includes resolved comments in the summary (so the
   * agent can recognise prior agreements), but the dashboard may dim them.
   */
  resolved: boolean;
}

/**
 * Snapshot of review feedback for a single MR captured during one sweep.
 * Persisted on {@link RunRecord.latestReviewFeedback} and injected into
 * the next-attempt prompt context as `reviewFeedback`.
 *
 * Sweep semantics (see Phase 4 supplemental spec §6):
 *
 *  - `cursor` is the maximum `createdAt` of any note included in this
 *    summary. The next sweep only emits comments whose `createdAt > cursor`.
 *  - Empty `comments` is a valid summary: it means "the sweep ran but
 *    nothing new was observed". In that case the cursor is unchanged.
 *  - `mrIid` / `mrUrl` mirror the MR linked to the run; both are required
 *    so the dashboard can deep-link.
 */
export interface ReviewFeedbackSummary {
  /** Internal MR identifier (`iid`) on the GitLab project. */
  mrIid: number;
  /** Permalink to the MR. */
  mrUrl: string;
  /** ISO-8601 timestamp captured when the sweep finished. */
  generatedAt: string;
  /** ISO-8601 cursor representing the latest note included in this summary. */
  cursor: string;
  /** Reviewer comments in `createdAt` ascending order. */
  comments: ReviewComment[];
}
