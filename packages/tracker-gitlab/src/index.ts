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
  GitLabAdapter,
  GitLabErrorCategory,
  IssueRef,
} from "./types.js";

export const PACKAGE_NAME = "@issuepilot/tracker-gitlab";
export const VERSION = "0.0.0";
