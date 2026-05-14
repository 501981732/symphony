import type { ResolvedCredential } from "@issuepilot/credentials";
import { describe, expect, it, vi } from "vitest";

import {
  createGitLabClientFromCredential,
  type GitlabCtor,
} from "../client.js";
import { GitLabError } from "../errors.js";

interface FakeApi {
  __token: string;
  fetchIssue: () => Promise<unknown>;
}

function makeFakeCtor(
  seenTokens: string[],
  seenOpts: Array<Record<string, unknown>> = [],
): GitlabCtor {
  return vi.fn(function (
    this: object,
    opts: { host: string; token?: string; oauthToken?: string },
  ) {
    seenOpts.push(opts);
    seenTokens.push(opts.token ?? opts.oauthToken ?? "");
    const api: FakeApi = {
      __token: opts.token ?? opts.oauthToken ?? "",
      fetchIssue: async () => ({}),
    };
    return Object.assign(this, api);
  }) as unknown as GitlabCtor;
}

function envCredential(token: string): ResolvedCredential {
  return {
    source: "env",
    hostname: "gitlab.example.com",
    accessToken: token,
  };
}

function oauthCredential(
  token: string,
  refresh: () => Promise<ResolvedCredential>,
): ResolvedCredential {
  return {
    source: "oauth",
    hostname: "gitlab.example.com",
    accessToken: token,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refresh,
  };
}

describe("createGitLabClientFromCredential", () => {
  it("instantiates the gitlab API with the credential token", () => {
    const tokens: string[] = [];
    const ctor = makeFakeCtor(tokens);
    createGitLabClientFromCredential<FakeApi>({
      baseUrl: "https://gitlab.example.com",
      projectId: "group/project",
      credential: envCredential("env-token-1"),
      GitlabCtor: ctor,
    });
    expect(tokens).toEqual(["env-token-1"]);
  });

  it("uses oauthToken for OAuth credentials", () => {
    const tokens: string[] = [];
    const opts: Array<Record<string, unknown>> = [];
    const ctor = makeFakeCtor(tokens, opts);
    createGitLabClientFromCredential<FakeApi>({
      baseUrl: "https://gitlab.example.com",
      projectId: "group/project",
      credential: oauthCredential("oauth-token-1", async () =>
        oauthCredential("oauth-token-2", async () =>
          oauthCredential("oauth-token-3", async () => {
            throw new Error("unused");
          }),
        ),
      ),
      GitlabCtor: ctor,
    });
    expect(opts[0]).toMatchObject({
      host: "https://gitlab.example.com",
      oauthToken: "oauth-token-1",
    });
    expect(opts[0]).not.toHaveProperty("token");
  });

  it("does not refresh on 401 when source is env", async () => {
    const tokens: string[] = [];
    const ctor = makeFakeCtor(tokens);
    const client = createGitLabClientFromCredential<FakeApi>({
      baseUrl: "https://gitlab.example.com",
      projectId: "group/project",
      credential: envCredential("env-token"),
      GitlabCtor: ctor,
    });
    await expect(
      client.request("ping", () => {
        const e: unknown = Object.assign(new Error("nope"), {
          cause: { response: { status: 401 } },
        });
        throw e;
      }),
    ).rejects.toMatchObject({
      name: "GitLabError",
      category: "auth",
    });
    expect(tokens).toEqual(["env-token"]); // only the initial ctor call
  });

  it("refreshes once and retries fn for OAuth credentials when fn yields 401", async () => {
    const tokens: string[] = [];
    const ctor = makeFakeCtor(tokens);
    const refreshFn = vi.fn(async () =>
      oauthCredential("oauth-fresh", refreshFn),
    );
    const client = createGitLabClientFromCredential<FakeApi>({
      baseUrl: "https://gitlab.example.com",
      projectId: "group/project",
      credential: oauthCredential("oauth-stale", refreshFn),
      GitlabCtor: ctor,
    });
    let attempt = 0;
    const result = await client.request<string>("ping", (api) => {
      attempt += 1;
      if (attempt === 1) {
        const e: unknown = Object.assign(new Error("auth"), {
          cause: { response: { status: 401 } },
        });
        throw e;
      }
      return Promise.resolve(api.__token);
    });
    expect(refreshFn).toHaveBeenCalledOnce();
    expect(tokens).toEqual(["oauth-stale", "oauth-fresh"]);
    expect(result).toBe("oauth-fresh");
  });

  it("does not refresh more than once even if the retry also yields 401", async () => {
    const tokens: string[] = [];
    const ctor = makeFakeCtor(tokens);
    const refreshFn = vi.fn(async () =>
      oauthCredential("oauth-fresh", refreshFn),
    );
    const client = createGitLabClientFromCredential<FakeApi>({
      baseUrl: "https://gitlab.example.com",
      projectId: "group/project",
      credential: oauthCredential("oauth-stale", refreshFn),
      GitlabCtor: ctor,
    });
    const err = await client
      .request("ping", () => {
        const e: unknown = Object.assign(new Error("auth"), {
          cause: { response: { status: 401 } },
        });
        throw e;
      })
      .catch((e: unknown) => e);
    expect(refreshFn).toHaveBeenCalledOnce();
    expect(err).toBeInstanceOf(GitLabError);
    expect((err as GitLabError).category).toBe("auth");
    expect(tokens).toEqual(["oauth-stale", "oauth-fresh"]);
  });

  it("hides token in JSON output", () => {
    const tokens: string[] = [];
    const ctor = makeFakeCtor(tokens);
    const client = createGitLabClientFromCredential<FakeApi>({
      baseUrl: "https://gitlab.example.com",
      projectId: "group/project",
      credential: envCredential("super-secret-token-xyz-1234567890"),
      GitlabCtor: ctor,
    });
    const json = JSON.stringify(client);
    expect(json).not.toContain("super-secret-token-xyz-1234567890");
  });
});
