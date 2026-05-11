import { describe, expect, it, vi } from "vitest";

import { createGitLabClient, type GitLabClient } from "./client.js";
import { GitLabError } from "./errors.js";

function makeClient(
  GitlabCtor: unknown = vi.fn(() => ({})) as unknown,
): GitLabClient {
  return createGitLabClient({
    baseUrl: "https://gitlab.example.com",
    tokenEnv: "GL_TOKEN",
    projectId: "group/project",
    env: { get: (n) => (n === "GL_TOKEN" ? "glpat-secret-xyz" : undefined) },
    GitlabCtor: GitlabCtor as never,
  });
}

describe("createGitLabClient", () => {
  it("invokes the Gitlab constructor with host + resolved token", () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctor = vi.fn(function (this: object, opts: Record<string, unknown>) {
      seen.push(opts);
      return this;
    });
    createGitLabClient({
      baseUrl: "https://gitlab.example.com",
      tokenEnv: "GL_TOKEN",
      projectId: "group/project",
      env: { get: () => "glpat-secret-xyz" },
      GitlabCtor: ctor as never,
    });
    expect(seen[0]?.host).toBe("https://gitlab.example.com");
    expect(seen[0]?.token).toBe("glpat-secret-xyz");
  });

  it("hides the resolved token in JSON / inspect output", () => {
    const c = makeClient();
    const json = JSON.stringify(c);
    expect(json).not.toContain("glpat-secret-xyz");
    expect(JSON.parse(json)).toMatchObject({
      baseUrl: "https://gitlab.example.com",
      projectId: "group/project",
    });
    expect(Object.keys(c)).not.toContain("_token");
    expect(Object.getOwnPropertyNames(c)).toContain("_token");
  });

  it("propagates GitLabError instances unchanged", async () => {
    const c = makeClient();
    const sentinel = new GitLabError("nope", { category: "permission", status: 403 });
    await expect(
      c.request("test", () => {
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);
  });

  it("classifies HTTP statuses (401/403/404/422/429/500/503)", async () => {
    const c = makeClient();
    const cases: Array<{
      status: number;
      category: GitLabError["category"];
      retriable: boolean;
    }> = [
      { status: 401, category: "auth", retriable: false },
      { status: 403, category: "permission", retriable: false },
      { status: 404, category: "not_found", retriable: false },
      { status: 422, category: "validation", retriable: false },
      { status: 429, category: "rate_limit", retriable: true },
      { status: 500, category: "transient", retriable: true },
      { status: 503, category: "transient", retriable: true },
    ];
    for (const { status, category, retriable } of cases) {
      const err = await c.request("ping", () => {
        const e: unknown = Object.assign(new Error("boom"), {
          cause: { response: { status } },
        });
        throw e;
      }).catch((e) => e);
      expect(err).toBeInstanceOf(GitLabError);
      expect(err.category).toBe(category);
      expect(err.status).toBe(status);
      expect(err.retriable).toBe(retriable);
    }
  });

  it("maps network / unknown failures to transient + retriable", async () => {
    const c = makeClient();
    const err = await c
      .request("ping", () => {
        throw new Error("ECONNRESET");
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GitLabError);
    expect(err.category).toBe("transient");
    expect(err.status).toBeUndefined();
    expect(err.retriable).toBe(true);
  });

  it("returns the resolved value when the fn succeeds", async () => {
    const c = makeClient();
    await expect(c.request("ok", async () => 42)).resolves.toBe(42);
  });

  it("missing env throws auth error before constructing the Gitlab instance", () => {
    const ctor = vi.fn(() => ({}));
    expect(() =>
      createGitLabClient({
        baseUrl: "https://gitlab.example.com",
        tokenEnv: "MISSING",
        projectId: "group/project",
        env: { get: () => undefined },
        GitlabCtor: ctor as never,
      }),
    ).toThrowError(GitLabError);
    expect(ctor).not.toHaveBeenCalled();
  });
});
