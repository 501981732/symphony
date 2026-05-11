import type { GitLabApi } from "./api-shape.js";
import type { GitLabClient } from "./client.js";

export interface CreateMergeRequestInput {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  /**
   * The issue this MR resolves. The adapter passes it through verbatim — any
   * close-link semantics belong in the orchestrator-side description template
   * (spec §12).
   */
  issueIid: number;
}

export interface CreatedMergeRequest {
  id: number;
  iid: number;
  webUrl: string;
}

export type MergeRequestUpdates = Partial<{
  title: string;
  description: string;
  targetBranch: string;
}>;

export interface MergeRequestSummary {
  iid: number;
  webUrl: string;
  state: string;
}

export interface MergeRequestNote {
  id: number;
  body: string;
  /** Resolved username; falls back to display name and finally `"unknown"`. */
  author: string;
}

/**
 * Create a merge request — or return the existing opened MR if one already
 * exists for the same source branch. The reconcile loop (spec §12) calls this
 * after every dispatch, so it MUST be safe to retry without producing a fork.
 */
export async function createMergeRequest(
  client: GitLabClient<GitLabApi>,
  input: CreateMergeRequestInput,
): Promise<CreatedMergeRequest> {
  return client.request("mergeRequests.create", async (api) => {
    const opened = await api.MergeRequests.all({
      projectId: client.projectId,
      sourceBranch: input.sourceBranch,
      state: "opened",
      perPage: 5,
    });
    const existing = opened.find(
      (mr) =>
        mr.source_branch === input.sourceBranch && mr.state === "opened",
    );
    if (existing) {
      return {
        id: existing.id,
        iid: existing.iid,
        webUrl: existing.web_url,
      };
    }
    const created = await api.MergeRequests.create(
      client.projectId,
      input.sourceBranch,
      input.targetBranch,
      input.title,
      {
        description: input.description,
        issueIid: input.issueIid,
      },
    );
    return { id: created.id, iid: created.iid, webUrl: created.web_url };
  });
}

/**
 * Apply optional updates to an MR. Skips the network entirely when the caller
 * has nothing to change — this keeps the reconciler quiet when an MR is
 * already in the desired shape (spec §12).
 */
export async function updateMergeRequest(
  client: GitLabClient<GitLabApi>,
  mrIid: number,
  updates: MergeRequestUpdates,
): Promise<void> {
  if (Object.keys(updates).length === 0) return;
  await client.request("mergeRequests.edit", async (api) => {
    await api.MergeRequests.edit(client.projectId, mrIid, updates);
  });
}

export async function getMergeRequest(
  client: GitLabClient<GitLabApi>,
  mrIid: number,
): Promise<MergeRequestSummary> {
  return client.request("mergeRequests.show", async (api) => {
    const mr = await api.MergeRequests.show(client.projectId, mrIid);
    return { iid: mr.iid, webUrl: mr.web_url, state: mr.state };
  });
}

export async function listMergeRequestNotes(
  client: GitLabClient<GitLabApi>,
  mrIid: number,
): Promise<MergeRequestNote[]> {
  return client.request("mergeRequestNotes.all", async (api) => {
    const rows = await api.MergeRequestNotes.all(client.projectId, mrIid, {
      perPage: 100,
    });
    return rows.map((n) => ({
      id: n.id,
      body: typeof n.body === "string" ? n.body : "",
      author:
        n.author?.username && n.author.username.length > 0
          ? n.author.username
          : n.author?.name && n.author.name.length > 0
            ? n.author.name
            : "unknown",
    }));
  });
}
