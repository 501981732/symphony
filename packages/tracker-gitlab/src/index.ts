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
  getIssue,
  listCandidateIssues,
  toIssueRef,
  type ListCandidateIssuesOpts,
} from "./issues.js";
export {
  createGitLabAdapter,
  type CreateGitLabAdapterInput,
  type GitLabAdapterHandle,
} from "./adapter.js";
export {
  transitionLabels,
  type TransitionLabelsOpts,
  type TransitionLabelsResult,
} from "./labels.js";
export {
  createIssueNote,
  findWorkpadNote,
  updateIssueNote,
  type CreateIssueNoteResult,
  type WorkpadNote,
} from "./notes.js";
export {
  createMergeRequest,
  getMergeRequest,
  listMergeRequestNotes,
  updateMergeRequest,
  type CreateMergeRequestInput,
  type CreatedMergeRequest,
  type MergeRequestNote,
  type MergeRequestSummary,
  type MergeRequestUpdates,
} from "./merge-requests.js";
export {
  classifyPipelineStatus,
  getPipelineStatus,
  type PipelineStatus,
} from "./pipelines.js";
export type {
  GitLabAdapter,
  GitLabErrorCategory,
  IssueRef,
} from "./types.js";

export const PACKAGE_NAME = "@issuepilot/tracker-gitlab";
export const VERSION = "0.0.0";
