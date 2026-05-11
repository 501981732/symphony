import type { GitLabErrorCategory } from "./types.js";

export interface GitLabErrorInit {
  category: GitLabErrorCategory;
  status?: number;
  retriable?: boolean;
  cause?: unknown;
}

export class GitLabError extends Error {
  override name = "GitLabError";
  readonly category: GitLabErrorCategory;
  readonly status?: number;
  readonly retriable: boolean;

  constructor(message: string, init: GitLabErrorInit) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.category = init.category;
    if (init.status !== undefined) this.status = init.status;
    this.retriable = init.retriable ?? defaultRetriable(init.category);
  }
}

function defaultRetriable(c: GitLabErrorCategory): boolean {
  return c === "rate_limit" || c === "transient";
}

export function classifyHttpStatus(status: number): GitLabErrorCategory {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 409 || status === 400 || status === 422) return "validation";
  if (status === 429) return "rate_limit";
  if (status >= 500 && status <= 599) return "transient";
  return "unknown";
}

/**
 * Extract HTTP status from arbitrary thrown values. We try the shapes
 * `@gitbeaker/rest` and friends actually use, then fall back to `undefined`.
 */
export function extractStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.status === "number") return e.status;
  const cause = e.cause as Record<string, unknown> | undefined;
  if (cause && typeof cause === "object") {
    if (typeof cause.status === "number") return cause.status;
    const response = cause.response as Record<string, unknown> | undefined;
    if (response && typeof response.status === "number") return response.status;
  }
  const response = e.response as Record<string, unknown> | undefined;
  if (response && typeof response.status === "number") return response.status;
  return undefined;
}

/**
 * Normalize any thrown value into a `GitLabError`. Already-classified errors
 * pass through unchanged so callers can wrap and rethrow safely.
 */
export function toGitLabError(err: unknown, label: string): GitLabError {
  if (err instanceof GitLabError) return err;
  const status = extractStatus(err);
  if (status !== undefined) {
    return new GitLabError(`GitLab ${label} failed (status ${status})`, {
      category: classifyHttpStatus(status),
      status,
      cause: err,
    });
  }
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "unknown error";
  return new GitLabError(`GitLab ${label} failed: ${message}`, {
    category: "transient",
    retriable: true,
    cause: err,
  });
}
