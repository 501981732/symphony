import type { GitLabApi, RawIssue } from "./api-shape.js";
import type { GitLabClient } from "./client.js";
import type { IssueRef } from "./types.js";

export interface ListCandidateIssuesOpts {
  /** Labels that mark an issue as eligible for IssuePilot (e.g. ai-ready, ai-rework). */
  activeLabels: readonly string[];
  /** Labels that disqualify an issue regardless of active labels (e.g. ai-running, ai-failed). */
  excludeLabels: readonly string[];
  /** Defaults to 50; matches spec §11 default page size. */
  perPage?: number;
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
): Promise<IssueRef & { description: string }> {
  return client.request("issues.get", async (api) => {
    const raw = await api.Issues.show(iid, { projectId: client.projectId });
    return {
      ...toIssueRef(raw),
      description: typeof raw.description === "string" ? raw.description : "",
    };
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
