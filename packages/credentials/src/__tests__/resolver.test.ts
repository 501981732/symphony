import { describe, expect, it, vi } from "vitest";

import { OAuthError } from "../device-flow.js";
import {
  CredentialError,
  createCredentialResolver,
} from "../resolver.js";
import type { CredentialsStore } from "../store.js";
import type {
  OAuthTokenResponse,
  StoredCredential,
} from "../types.js";

function fakeStore(initial: StoredCredential[] = []): CredentialsStore {
  const data = new Map<string, StoredCredential>();
  for (const cred of initial) data.set(cred.hostname, cred);
  return {
    async read(hostname) {
      return data.get(hostname) ?? null;
    },
    async write(cred) {
      data.set(cred.hostname, cred);
    },
    async delete(hostname) {
      data.delete(hostname);
    },
    async list() {
      return Array.from(data.values());
    },
  };
}

function envFromMap(env: Record<string, string>): { get: (n: string) => string | undefined } {
  return { get: (name) => env[name] };
}

describe("createCredentialResolver", () => {
  it("prefers env when trackerTokenEnv is set and present", async () => {
    const store = fakeStore();
    const readSpy = vi.spyOn(store, "read");
    const resolver = createCredentialResolver({
      store,
      env: envFromMap({ GITLAB_TOKEN: "glpat-test-env-1234567890abcdefghij" }),
    });
    const result = await resolver.resolve({
      hostname: "gitlab.example.com",
      trackerTokenEnv: "GITLAB_TOKEN",
    });
    expect(result.source).toBe("env");
    expect(result.accessToken).toBe("glpat-test-env-1234567890abcdefghij");
    expect(result.refresh).toBeUndefined();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("falls back to credentials file when env is missing", async () => {
    const cred: StoredCredential = {
      version: 1,
      hostname: "gitlab.example.com",
      clientId: "issuepilot-cli",
      accessToken: "oauth-test-access",
      refreshToken: "oauth-test-refresh",
      tokenType: "Bearer",
      obtainedAt: new Date(Date.now()).toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const store = fakeStore([cred]);
    const resolver = createCredentialResolver({
      store,
      env: envFromMap({}),
    });
    const result = await resolver.resolve({
      hostname: "gitlab.example.com",
      trackerTokenEnv: "GITLAB_TOKEN",
    });
    expect(result.source).toBe("oauth");
    expect(result.accessToken).toBe("oauth-test-access");
    expect(typeof result.refresh).toBe("function");
  });

  it("auto-refreshes when expiresAt is within the skew window", async () => {
    const now = Date.now();
    const cred: StoredCredential = {
      version: 1,
      hostname: "gitlab.example.com",
      clientId: "issuepilot-cli",
      accessToken: "oauth-test-old",
      refreshToken: "oauth-test-refresh",
      tokenType: "Bearer",
      obtainedAt: new Date(now - 7_200_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(), // 1 minute left
    };
    const store = fakeStore([cred]);
    const refresh = vi.fn(async (): Promise<OAuthTokenResponse> => ({
      accessToken: "oauth-test-new",
      refreshToken: "oauth-test-refresh-2",
      tokenType: "Bearer",
      expiresAt: new Date(now + 7_200_000).toISOString(),
    }));
    const resolver = createCredentialResolver({
      store,
      env: envFromMap({}),
      refresh,
      refreshSkewMs: 5 * 60_000, // 5 min
      now: () => now,
    });
    const result = await resolver.resolve({
      hostname: "gitlab.example.com",
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(result.accessToken).toBe("oauth-test-new");
    const stored = await store.read("gitlab.example.com");
    expect(stored?.accessToken).toBe("oauth-test-new");
    expect(stored?.refreshToken).toBe("oauth-test-refresh-2");
  });

  it("throws CredentialError when neither env nor store has credentials", async () => {
    const store = fakeStore();
    const resolver = createCredentialResolver({
      store,
      env: envFromMap({}),
    });
    await expect(
      resolver.resolve({
        hostname: "gitlab.example.com",
        trackerTokenEnv: "GITLAB_TOKEN",
      }),
    ).rejects.toBeInstanceOf(CredentialError);
  });

  it("propagates OAuthError from refresh and does not overwrite the store", async () => {
    const now = Date.now();
    const cred: StoredCredential = {
      version: 1,
      hostname: "gitlab.example.com",
      clientId: "issuepilot-cli",
      accessToken: "oauth-test-old",
      refreshToken: "oauth-test-bad",
      tokenType: "Bearer",
      obtainedAt: new Date(now - 7_200_000).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(),
    };
    const store = fakeStore([cred]);
    const writeSpy = vi.spyOn(store, "write");
    const refresh = vi.fn(async () => {
      throw new OAuthError("refresh failed", {
        category: "invalid_grant",
        retriable: false,
      });
    });
    const resolver = createCredentialResolver({
      store,
      env: envFromMap({}),
      refresh,
      now: () => now,
    });
    await expect(
      resolver.resolve({ hostname: "gitlab.example.com" }),
    ).rejects.toBeInstanceOf(OAuthError);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("explicit refresh() callback rotates the cached credential", async () => {
    const now = Date.now();
    const cred: StoredCredential = {
      version: 1,
      hostname: "gitlab.example.com",
      clientId: "issuepilot-cli",
      accessToken: "oauth-test-old",
      refreshToken: "oauth-test-refresh",
      tokenType: "Bearer",
      obtainedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 7_200_000).toISOString(),
    };
    const store = fakeStore([cred]);
    const refresh = vi.fn(async (): Promise<OAuthTokenResponse> => ({
      accessToken: "oauth-test-new",
      refreshToken: "oauth-test-refresh-2",
      tokenType: "Bearer",
      expiresAt: new Date(now + 7_200_000).toISOString(),
    }));
    const resolver = createCredentialResolver({
      store,
      env: envFromMap({}),
      refresh,
      now: () => now,
    });
    const first = await resolver.resolve({ hostname: "gitlab.example.com" });
    expect(refresh).not.toHaveBeenCalled();
    const second = await first.refresh!();
    expect(refresh).toHaveBeenCalledOnce();
    expect(second.accessToken).toBe("oauth-test-new");
    expect((await store.read("gitlab.example.com"))?.accessToken).toBe(
      "oauth-test-new",
    );
  });
});
