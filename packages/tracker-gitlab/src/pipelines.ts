import type { GitLabApi } from "./api-shape.js";
import type { GitLabClient } from "./client.js";

export type PipelineStatus =
  | "running"
  | "success"
  | "failed"
  | "pending"
  | "canceled"
  | "unknown";

/**
 * Return the status of the most recent pipeline for `ref`.
 *
 * GitLab exposes ~12 different pipeline statuses; the orchestrator only cares
 * about a coarse-grained 6-way classification. The mapping here is biased
 * toward "don't surface a surprising state to the dashboard": unknown
 * statuses become `unknown`, and `skipped` is grouped with `canceled` since
 * neither means "the gating job actually ran".
 */
export async function getPipelineStatus(
  client: GitLabClient<GitLabApi>,
  ref: string,
): Promise<PipelineStatus> {
  return client.request("pipelines.status", async (api) => {
    const list = await api.Pipelines.all(client.projectId, {
      ref,
      perPage: 1,
      orderBy: "updated_at",
      sort: "desc",
    });
    const latest = list[0];
    if (!latest) return "unknown";
    return classifyPipelineStatus(latest.status);
  });
}

export function classifyPipelineStatus(raw: string): PipelineStatus {
  switch (raw) {
    case "running":
    case "success":
    case "failed":
    case "pending":
    case "canceled":
      return raw;
    case "created":
    case "manual":
    case "scheduled":
    case "preparing":
    case "waiting_for_resource":
      return "pending";
    case "skipped":
      return "canceled";
    default:
      return "unknown";
  }
}
