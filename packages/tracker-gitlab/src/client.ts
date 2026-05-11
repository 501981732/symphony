import { Gitlab } from "@gitbeaker/rest";

import { resolveGitLabToken, type EnvLike } from "./auth.js";
import { toGitLabError } from "./errors.js";

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

export interface GitLabClient<TApi = unknown> {
  readonly baseUrl: string;
  readonly projectId: string;
  readonly api: TApi;
  /**
   * Run `fn` against the underlying client and normalize any thrown value into
   * a `GitLabError` tagged with a coarse-grained category. `label` is a short
   * operation name only used to build human-readable error messages.
   */
  request<T>(label: string, fn: (api: TApi) => T | Promise<T>): Promise<T>;
  /**
   * Serialization explicitly omits the bearer token so accidental
   * `JSON.stringify` (e.g. inside log lines or SSE replies) cannot leak it.
   */
  toJSON(): { baseUrl: string; projectId: string };
}

export function createGitLabClient<TApi = unknown>(
  input: CreateGitLabClientInput,
): GitLabClient<TApi> {
  const token = resolveGitLabToken(
    input.env !== undefined
      ? { tokenEnv: input.tokenEnv, env: input.env }
      : { tokenEnv: input.tokenEnv },
  );
  const Ctor = (input.GitlabCtor ?? (Gitlab as unknown as GitlabCtor));
  const api = new Ctor({ host: input.baseUrl, token }) as TApi;

  const baseUrl = input.baseUrl;
  const projectId = input.projectId;

  const client: GitLabClient<TApi> = {
    baseUrl,
    projectId,
    api,
    async request(label, fn) {
      try {
        return await fn(api);
      } catch (err) {
        throw toGitLabError(err, label);
      }
    },
    toJSON() {
      return { baseUrl, projectId };
    },
  };

  Object.defineProperty(client, "_token", {
    value: token,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return client;
}
