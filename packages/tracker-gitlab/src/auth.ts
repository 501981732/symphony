import { GitLabError } from "./errors.js";

/**
 * Minimal env-lookup interface. Defaults to `process.env`, but callers can
 * inject any string→string map to keep tests hermetic.
 */
export interface EnvLike {
  get(name: string): string | undefined;
}

export function defaultEnv(): EnvLike {
  return {
    get: (name) => process.env[name],
  };
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ResolveGitLabTokenInput {
  tokenEnv: string;
  env?: EnvLike;
}

/**
 * Look up a GitLab Personal/Group Access Token by env var name. The token is
 * the only secret in this package — every API call funnels through this so we
 * fail closed when ops forgets to wire `tracker.token_env`.
 */
export function resolveGitLabToken(input: ResolveGitLabTokenInput): string {
  const { tokenEnv } = input;
  if (typeof tokenEnv !== "string" || !ENV_NAME_RE.test(tokenEnv)) {
    throw new GitLabError("Invalid GitLab token env var name", {
      category: "auth",
      retriable: false,
    });
  }
  const env = input.env ?? defaultEnv();
  const raw = env.get(tokenEnv);
  if (raw === undefined || raw === null) {
    throw new GitLabError(`GitLab token env var is not set: ${tokenEnv}`, {
      category: "auth",
      retriable: false,
    });
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new GitLabError(
      `GitLab token env var is empty after trim: ${tokenEnv}`,
      { category: "auth", retriable: false },
    );
  }
  return trimmed;
}
