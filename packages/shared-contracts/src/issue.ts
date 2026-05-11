/**
 * Minimal projection of a GitLab Issue shared between the tracker adapter
 * and downstream consumers (orchestrator, runner, dashboard).
 *
 * Keep this surface boring — anything richer (labels metadata, milestone,
 * iteration, etc.) belongs in `@issuepilot/tracker-gitlab`-internal types.
 */
export interface IssueRef {
  /** GitLab global id (e.g. "gid://gitlab/Issue/12345"). */
  id: string;
  /** Project-scoped issue iid; what humans paste in URLs. */
  iid: number;
  title: string;
  /** Canonical browser URL for the issue. */
  url: string;
  /** GitLab project identifier (slug "group/project" or numeric id). */
  projectId: string;
  labels: readonly string[];
}
