export { resolveGitLabToken, defaultEnv, type EnvLike } from "./auth.js";
export {
  GitLabError,
  classifyHttpStatus,
  extractStatus,
  toGitLabError,
  type GitLabErrorInit,
} from "./errors.js";
export {
  createGitLabClient,
  type CreateGitLabClientInput,
  type GitLabClient,
  type GitlabCtor,
} from "./client.js";
export type {
  GitLabApi,
  IssueNotesApi,
  IssuesApi,
  MergeRequestNotesApi,
  MergeRequestsApi,
  PipelinesApi,
  RawIssue,
  RawIssueNote,
  RawMergeRequest,
  RawPipeline,
} from "./api-shape.js";
export {
  listCandidateIssues,
  toIssueRef,
  type ListCandidateIssuesOpts,
} from "./issues.js";
export type {
  GitLabAdapter,
  GitLabErrorCategory,
  IssueRef,
} from "./types.js";

export const PACKAGE_NAME = "@issuepilot/tracker-gitlab";
export const VERSION = "0.0.0";
