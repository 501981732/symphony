import type { GitLabApi, RawIssue } from "./api-shape.js";
import type { GitLabClient } from "./client.js";
import { GitLabError } from "./errors.js";
import type { IssueRef } from "./types.js";

export interface ListCandidateIssuesOpts {
  /** Labels that mark an issue as eligible for IssuePilot (e.g. ai-ready, ai-rework). */
  activeLabels: readonly string[];
  /** Labels that disqualify an issue regardless of active labels (e.g. ai-running, ai-failed). */
  excludeLabels: readonly string[];
  /** Defaults to 50; matches spec §11 default page size. */
  perPage?: number;
}

export interface CloseIssueOpts {
  requireCurrent?: readonly string[];
  removeLabels: readonly string[];
}

export interface CloseIssueResult {
  labels: string[];
  state: string | undefined;
}

const ISSUE_CONFLICT_PREFIX = "issue_conflict";

function issueConflict(detail: string): GitLabError {
  return new GitLabError(`${ISSUE_CONFLICT_PREFIX}: ${detail}`, {
    category: "validation",
    status: 409,
    retriable: false,
  });
}

/**
 * Fetch candidate issues from GitLab. The adapter only filters by labels —
 * priority + final ordering happens in the orchestrator (spec §8) so this
 * function stays a thin, side-effect-free wrapper.
 */
export async function listCandidateIssues(
  client: GitLabClient<GitLabApi>,
  opts: ListCandidateIssuesOpts,
): Promise<IssueRef[]> {
  const perPage = opts.perPage ?? 50;
  return client.request("issues.listCandidates", async (api) => {
    const rows = await Promise.all(
      opts.activeLabels.map((label) =>
        api.Issues.all({
          projectId: client.projectId,
          state: "opened",
          labels: label,
          perPage,
          orderBy: "updated_at",
          sort: "asc",
        }),
      ),
    );
    const seen = new Set<number>();
    const issues = rows.flat().filter((issue) => {
      if (seen.has(issue.id)) return false;
      seen.add(issue.id);
      return true;
    });
    const excluded = new Set(opts.excludeLabels);
    return issues
      .filter((i) => {
        const labels = i.labels ?? [];
        return !labels.some((l) => excluded.has(l));
      })
      .map(toIssueRef);
  });
}

export async function getIssue(
  client: GitLabClient<GitLabApi>,
  iid: number,
): Promise<IssueRef & { description: string; state?: string }> {
  return client.request("issues.get", async (api) => {
    const raw = await api.Issues.show(iid, { projectId: client.projectId });
    const issue = {
      ...toIssueRef(raw),
      description: typeof raw.description === "string" ? raw.description : "",
    };
    return raw.state ? { ...issue, state: raw.state } : issue;
  });
}

export async function closeIssue(
  client: GitLabClient<GitLabApi>,
  iid: number,
  opts: CloseIssueOpts,
): Promise<CloseIssueResult> {
  return client.request("issues.close", async (api) => {
    const before = await api.Issues.show(iid, { projectId: client.projectId });
    const currentLabels = [...(before.labels ?? [])];

    if (opts.requireCurrent && opts.requireCurrent.length > 0) {
      const currentSet = new Set(currentLabels);
      const missing = opts.requireCurrent.filter((l) => !currentSet.has(l));
      if (missing.length > 0) {
        throw issueConflict(
          `issue ${iid} missing required label(s): ${missing.join(", ")}`,
        );
      }
    }

    if (before.state !== "opened") {
      throw issueConflict(
        `issue ${iid} must be opened before close (state=${before.state ?? "unknown"})`,
      );
    }

    const removeSet = new Set(opts.removeLabels);
    const nextLabels = currentLabels.filter((l) => !removeSet.has(l));
    await api.Issues.edit(client.projectId, iid, {
      labels: nextLabels.join(","),
      stateEvent: "close",
    });

    const after = await api.Issues.show(iid, { projectId: client.projectId });
    return { labels: [...(after.labels ?? [])], state: after.state };
  });
}

export function toIssueRef(raw: RawIssue): IssueRef {
  return {
    id: `gid://gitlab/Issue/${raw.id}`,
    iid: raw.iid,
    title: raw.title,
    url: raw.web_url,
    projectId: String(raw.project_id),
    labels: Object.freeze([...(raw.labels ?? [])]),
  };
}
