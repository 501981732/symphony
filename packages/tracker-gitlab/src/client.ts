import { Gitlab } from "@gitbeaker/rest";
import type { ResolvedCredential } from "@issuepilot/credentials";

import { resolveGitLabToken, type EnvLike } from "./auth.js";
import { GitLabError, toGitLabError } from "./errors.js";

/**
 * `@gitbeaker/rest`'s default export shape. We accept any constructor with the
 * same call signature so tests can inject a stub without spinning up HTTP.
 */
export type GitlabCtor = new (opts: {
  host: string;
  token: string;
}) => unknown;

export interface CreateGitLabClientInput {
  baseUrl: string;
  tokenEnv: string;
  projectId: string;
  env?: EnvLike;
  /** Test seam — defaults to `@gitbeaker/rest`'s `Gitlab`. */
  GitlabCtor?: GitlabCtor;
}

/**
 * Inputs accepted by the credential-aware client factory. Callers (the
 * orchestrator daemon, the `auth` CLI subcommands) resolve a credential
 * up-front via `@issuepilot/credentials` and hand it to us; we just hold
 * onto the access token plus a refresh callback so we can recover from a
 * single 401 transparently.
 */
export interface CreateGitLabClientFromCredentialInput {
  baseUrl: string;
  projectId: string;
  credential: ResolvedCredential;
  GitlabCtor?: GitlabCtor;
}

export interface GitLabClient<TApi = unknown> {
  readonly baseUrl: string;
  readonly projectId: string;
  readonly api: TApi;
  /**
   * Run `fn` against the underlying client and normalize any thrown value into
   * a `GitLabError` tagged with a coarse-grained category. `label` is a short
   * operation name only used to build human-readable error messages.
   *
   * When the active credential supports refresh (OAuth flow) and the
   * underlying call comes back with `category === "auth"`, the client will
   * silently refresh the token *once* and retry `fn` exactly once before
   * giving up. Tokens from `tracker.token_env` cannot be refreshed and so a
   * 401 surfaces immediately.
   */
  request<T>(label: string, fn: (api: TApi) => T | Promise<T>): Promise<T>;
  /**
   * Serialization explicitly omits the bearer token so accidental
   * `JSON.stringify` (e.g. inside log lines or SSE replies) cannot leak it.
   */
  toJSON(): { baseUrl: string; projectId: string };
}

interface InternalClientState {
  api: unknown;
  token: string;
}

function buildApi(Ctor: GitlabCtor, host: string, token: string): unknown {
  return new Ctor({ host, token });
}

function defineHiddenToken<T extends GitLabClient<unknown>>(
  client: T,
  token: string,
): void {
  Object.defineProperty(client, "_token", {
    value: token,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

/**
 * Backwards-compatible factory used by every existing test and the legacy
 * env-only orchestration path. Resolves the token synchronously and never
 * attempts to refresh on 401.
 */
export function createGitLabClient<TApi = unknown>(
  input: CreateGitLabClientInput,
): GitLabClient<TApi> {
  const token = resolveGitLabToken(
    input.env !== undefined
      ? { tokenEnv: input.tokenEnv, env: input.env }
      : { tokenEnv: input.tokenEnv },
  );
  const Ctor = input.GitlabCtor ?? (Gitlab as unknown as GitlabCtor);
  const state: InternalClientState = {
    api: buildApi(Ctor, input.baseUrl, token),
    token,
  };

  const client: GitLabClient<TApi> = {
    baseUrl: input.baseUrl,
    projectId: input.projectId,
    get api() {
      return state.api as TApi;
    },
    async request(label, fn) {
      try {
        return await fn(state.api as TApi);
      } catch (err) {
        throw toGitLabError(err, label);
      }
    },
    toJSON() {
      return { baseUrl: input.baseUrl, projectId: input.projectId };
    },
  };

  defineHiddenToken(client, token);
  return client;
}

/**
 * Credential-aware factory. The caller provides an already-resolved
 * `ResolvedCredential` plus a Gitlab constructor; we own the 401 → refresh
 * → retry-once policy so each adapter method can stay a one-liner.
 */
export function createGitLabClientFromCredential<TApi = unknown>(
  input: CreateGitLabClientFromCredentialInput,
): GitLabClient<TApi> {
  const Ctor = input.GitlabCtor ?? (Gitlab as unknown as GitlabCtor);
  const state: InternalClientState = {
    api: buildApi(Ctor, input.baseUrl, input.credential.accessToken),
    token: input.credential.accessToken,
  };
  let credential = input.credential;

  const client: GitLabClient<TApi> = {
    baseUrl: input.baseUrl,
    projectId: input.projectId,
    get api() {
      return state.api as TApi;
    },
    async request(label, fn) {
      try {
        return await fn(state.api as TApi);
      } catch (err) {
        const classified = toGitLabError(err, label);
        const canRefresh =
          credential.source === "oauth" &&
          typeof credential.refresh === "function";
        if (classified.category !== "auth" || !canRefresh) {
          throw classified;
        }
        // Refresh-and-retry once. We deliberately don't loop: a second 401
        // after a fresh token almost certainly means revoked access.
        let refreshed: ResolvedCredential;
        try {
          refreshed = await credential.refresh!();
        } catch (refreshErr) {
          if (refreshErr instanceof GitLabError) throw refreshErr;
          throw new GitLabError(
            `GitLab ${label} failed: token refresh rejected`,
            {
              category: "auth",
              retriable: false,
              cause: refreshErr,
            },
          );
        }
        credential = refreshed;
        state.token = refreshed.accessToken;
        state.api = buildApi(Ctor, input.baseUrl, refreshed.accessToken);
        defineHiddenToken(client, refreshed.accessToken);
        try {
          return await fn(state.api as TApi);
        } catch (retryErr) {
          throw toGitLabError(retryErr, label);
        }
      }
    },
    toJSON() {
      return { baseUrl: input.baseUrl, projectId: input.projectId };
    },
  };

  defineHiddenToken(client, state.token);
  return client;
}
