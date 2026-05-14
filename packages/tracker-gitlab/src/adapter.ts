import type { GitLabApi } from "./api-shape.js";
import {
  createGitLabClient,
  createGitLabClientFromCredential,
  type CreateGitLabClientFromCredentialInput,
  type CreateGitLabClientInput,
  type GitLabClient,
} from "./client.js";
import { getIssue, listCandidateIssues } from "./issues.js";
import { transitionLabels } from "./labels.js";
import {
  createMergeRequest,
  getMergeRequest,
  listMergeRequestNotes,
  updateMergeRequest,
} from "./merge-requests.js";
import {
  createIssueNote,
  findWorkpadNote,
  updateIssueNote,
} from "./notes.js";
import { getPipelineStatus } from "./pipelines.js";
import type { GitLabAdapter } from "./types.js";

export type CreateGitLabAdapterInput = CreateGitLabClientInput;
export type CreateGitLabAdapterFromCredentialInput =
  CreateGitLabClientFromCredentialInput;

/**
 * Concrete `GitLabAdapter` plus the underlying client. The client is exposed
 * so callers (orchestrator startup, `issuepilot doctor`) can run probe
 * requests without going through one of the typed methods, but production
 * code should always prefer the adapter surface.
 */
export interface GitLabAdapterHandle extends GitLabAdapter {
  readonly client: GitLabClient<GitLabApi>;
}

function bindAdapter(
  client: GitLabClient<GitLabApi>,
): GitLabAdapterHandle {
  return {
    client,
    listCandidateIssues: (opts) => listCandidateIssues(client, opts),
    getIssue: (iid) => getIssue(client, iid),
    transitionLabels: (iid, opts) => transitionLabels(client, iid, opts),
    createIssueNote: (iid, body) => createIssueNote(client, iid, body),
    updateIssueNote: (iid, noteId, body) =>
      updateIssueNote(client, iid, noteId, body),
    findWorkpadNote: (iid, marker) => findWorkpadNote(client, iid, marker),
    createMergeRequest: (mrInput) => createMergeRequest(client, mrInput),
    updateMergeRequest: (mrIid, updates) =>
      updateMergeRequest(client, mrIid, updates),
    getMergeRequest: (mrIid) => getMergeRequest(client, mrIid),
    listMergeRequestNotes: (mrIid) => listMergeRequestNotes(client, mrIid),
    getPipelineStatus: (ref) => getPipelineStatus(client, ref),
  };
}

/**
 * Compose the adapter from the per-capability helpers. Each method is a thin
 * binding so the adapter stays stateless and trivially testable — the
 * heavy-lifting tests live next to the helpers themselves.
 */
export function createGitLabAdapter(
  input: CreateGitLabAdapterInput,
): GitLabAdapterHandle {
  return bindAdapter(createGitLabClient<GitLabApi>(input));
}

/**
 * Credential-aware variant. Use this when the caller has already resolved a
 * `ResolvedCredential` via `@issuepilot/credentials` — for OAuth-sourced
 * credentials the underlying client will refresh + retry once on a 401.
 */
export function createGitLabAdapterFromCredential(
  input: CreateGitLabAdapterFromCredentialInput,
): GitLabAdapterHandle {
  return bindAdapter(createGitLabClientFromCredential<GitLabApi>(input));
}
