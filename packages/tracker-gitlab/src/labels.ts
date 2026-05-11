import type { GitLabApi } from "./api-shape.js";
import type { GitLabClient } from "./client.js";
import { GitLabError } from "./errors.js";

export interface TransitionLabelsOpts {
  /** Labels to add (idempotent — duplicates ignored). */
  add: readonly string[];
  /** Labels to remove. */
  remove: readonly string[];
  /**
   * Labels that MUST be on the issue when we read it. If any are missing
   * we abort with `claim_conflict`, leaving the issue untouched. This is the
   * optimistic-lock used by orchestrator claim (spec §8).
   */
  requireCurrent?: readonly string[];
}

export interface TransitionLabelsResult {
  labels: string[];
}

const CLAIM_CONFLICT_PREFIX = "claim_conflict";

function claimConflict(detail: string): GitLabError {
  return new GitLabError(`${CLAIM_CONFLICT_PREFIX}: ${detail}`, {
    category: "validation",
    status: 409,
    retriable: false,
  });
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const aSet = new Set(a);
  for (const l of b) if (!aSet.has(l)) return false;
  return true;
}

/**
 * Transition an issue's labels with an optimistic concurrency check.
 *
 * 1. `Issues.show` — read current labels.
 * 2. Reject with `claim_conflict` if `requireCurrent` labels are missing.
 * 3. Compute `next = (current \ remove) ∪ add` preserving the existing order.
 * 4. `Issues.edit` if `next` differs from `current`.
 * 5. `Issues.show` again — verify the post-state still has every `add` and no
 *    leftover `remove`; if not, `claim_conflict`.
 *
 * Verifying twice is intentional: GitLab REST has no `If-Match`, so we rely on
 * the second read to catch races where another actor edited between our
 * pre-check and edit.
 */
export async function transitionLabels(
  client: GitLabClient<GitLabApi>,
  iid: number,
  opts: TransitionLabelsOpts,
): Promise<TransitionLabelsResult> {
  return client.request("issues.transitionLabels", async (api) => {
    const before = await api.Issues.show(iid, { projectId: client.projectId });
    const currentLabels = [...(before.labels ?? [])];

    if (opts.requireCurrent && opts.requireCurrent.length > 0) {
      const currentSet = new Set(currentLabels);
      const missing = opts.requireCurrent.filter((l) => !currentSet.has(l));
      if (missing.length > 0) {
        throw claimConflict(
          `issue ${iid} missing required label(s): ${missing.join(", ")}`,
        );
      }
    }

    const removeSet = new Set(opts.remove);
    const next = currentLabels.filter((l) => !removeSet.has(l));
    for (const l of opts.add) {
      if (!next.includes(l)) next.push(l);
    }

    if (!sameSet(currentLabels, next)) {
      await api.Issues.edit(client.projectId, iid, {
        labels: next.join(","),
      });
    }

    const verified = await api.Issues.show(iid, { projectId: client.projectId });
    const finalLabels = [...(verified.labels ?? [])];
    const finalSet = new Set(finalLabels);
    const stillMissing = opts.add.filter((l) => !finalSet.has(l));
    const stillPresent = opts.remove.filter((l) => finalSet.has(l));
    if (stillMissing.length > 0 || stillPresent.length > 0) {
      throw claimConflict(
        `issue ${iid} label state diverged after edit ` +
          `(missing=[${stillMissing.join(", ")}], present=[${stillPresent.join(", ")}])`,
      );
    }

    return { labels: finalLabels };
  });
}
