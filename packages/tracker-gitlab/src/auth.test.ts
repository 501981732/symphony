import { describe, expect, it } from "vitest";

import { resolveGitLabToken, type EnvLike } from "./auth.js";
import { GitLabError } from "./errors.js";

function envOf(record: Record<string, string | undefined>): EnvLike {
  return { get: (name) => record[name] };
}

describe("resolveGitLabToken", () => {
  it("returns the configured token from the provided env", () => {
    const env = envOf({ GITLAB_TOKEN: "glpat-deadbeef" });
    expect(resolveGitLabToken({ tokenEnv: "GITLAB_TOKEN", env })).toBe(
      "glpat-deadbeef",
    );
  });

  it("trims leading and trailing whitespace", () => {
    const env = envOf({ GITLAB_TOKEN: "  glpat-trimmed\n" });
    expect(resolveGitLabToken({ tokenEnv: "GITLAB_TOKEN", env })).toBe(
      "glpat-trimmed",
    );
  });

  it("throws auth GitLabError when env var is missing", () => {
    const env = envOf({});
    try {
      resolveGitLabToken({ tokenEnv: "GITLAB_TOKEN", env });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitLabError);
      const e = err as GitLabError;
      expect(e.category).toBe("auth");
      expect(e.retriable).toBe(false);
      expect(String(e.message)).not.toContain("glpat-");
    }
  });

  it("throws auth GitLabError when env var is empty / whitespace", () => {
    const env = envOf({ GITLAB_TOKEN: "   " });
    expect(() =>
      resolveGitLabToken({ tokenEnv: "GITLAB_TOKEN", env }),
    ).toThrowError(GitLabError);
  });

  it("rejects invalid env var names without consulting process.env", () => {
    const env = envOf({ "bad name": "value" });
    expect(() =>
      resolveGitLabToken({ tokenEnv: "bad name", env }),
    ).toThrowError(GitLabError);
    expect(() => resolveGitLabToken({ tokenEnv: "", env })).toThrowError(
      GitLabError,
    );
    expect(() =>
      resolveGitLabToken({ tokenEnv: "1STARTS_WITH_DIGIT", env }),
    ).toThrowError(GitLabError);
  });
});
