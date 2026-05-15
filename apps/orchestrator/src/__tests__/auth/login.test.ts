import type {
  CredentialsStore,
  StoredCredential,
} from "@issuepilot/credentials";
import { describe, expect, it, vi } from "vitest";

import {
  authLogin,
  authLogout,
  authStatus,
  type CliConsole,
} from "../../auth/index.js";

function fakeStore(initial: StoredCredential[] = []): CredentialsStore {
  const data = new Map<string, StoredCredential>();
  for (const c of initial) data.set(c.hostname, c);
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

function captureConsole(): CliConsole & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    log: (m) => lines.push(m),
    error: (m) => errors.push(m),
  };
}

describe("authLogin", () => {
  it("runs device flow and persists the credential, never printing the access token", async () => {
    const store = fakeStore();
    const cliConsole = captureConsole();
    const requestDeviceCode = vi.fn(async () => ({
      deviceCode: "dev-abc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://gitlab.example.com/-/oauth/device",
      verificationUriComplete:
        "https://gitlab.example.com/-/oauth/device?user_code=ABCD-EFGH",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      pollIntervalMs: 1_000,
    }));
    const expiresAt = new Date(Date.now() + 7_200_000).toISOString();
    const pollForToken = vi.fn(async () => ({
      accessToken: "oauth-test-supersecret-1234567890abcdef",
      refreshToken: "oauth-test-refresh-zzzzzzzzzzzzzzzzzz",
      tokenType: "Bearer",
      scope: "api read_repository write_repository",
      expiresAt,
    }));
    const result = await authLogin(
      {
        hostname: "gitlab.example.com",
        scope: ["api", "read_repository", "write_repository"],
        clientId: "test-client",
      },
      {
        store,
        console: cliConsole,
        requestDeviceCode,
        pollForToken,
      },
    );
    expect(requestDeviceCode).toHaveBeenCalledOnce();
    expect(pollForToken).toHaveBeenCalledOnce();
    const stored = await store.read("gitlab.example.com");
    expect(stored?.accessToken).toBe("oauth-test-supersecret-1234567890abcdef");
    expect(stored?.refreshToken).toBe("oauth-test-refresh-zzzzzzzzzzzzzzzzzz");
    expect(stored?.scope).toBe("api read_repository write_repository");
    expect(result.credential.clientId).toBe("test-client");

    const fullOutput = cliConsole.lines.join("\n");
    expect(fullOutput).not.toContain("oauth-test-supersecret-1234567890abcdef");
    expect(fullOutput).not.toContain("oauth-test-refresh-zzzzzzzzzzzzzzzzzz");
    expect(fullOutput).toContain("ABCD-EFGH");
  });

  it("surfaces a useful error when device endpoint rejects the client", async () => {
    const store = fakeStore();
    const cliConsole = captureConsole();
    const requestDeviceCode = vi.fn(async () => {
      const { OAuthError } = await import("@issuepilot/credentials");
      throw new OAuthError("invalid_client", {
        category: "invalid_client",
        retriable: false,
      });
    });
    const pollForToken = vi.fn();
    await expect(
      authLogin(
        { hostname: "gitlab.example.com", clientId: "x" },
        {
          store,
          console: cliConsole,
          requestDeviceCode,
          pollForToken,
        },
      ),
    ).rejects.toThrow(/invalid_client/);
    expect(pollForToken).not.toHaveBeenCalled();
  });
});

describe("authStatus", () => {
  it("prints stored entries without ever printing the access token", async () => {
    const cred: StoredCredential = {
      version: 1,
      hostname: "gitlab.example.com",
      clientId: "issuepilot-cli",
      accessToken: "oauth-test-supersecret-9876543210",
      refreshToken: "oauth-test-refresh-aaa",
      tokenType: "Bearer",
      scope: "api",
      obtainedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    };
    const store = fakeStore([cred]);
    const cliConsole = captureConsole();
    await authStatus({}, { store, console: cliConsole });
    const output = cliConsole.lines.join("\n");
    expect(output).toContain("gitlab.example.com");
    expect(output).toContain("issuepilot-cli");
    expect(output).not.toContain("oauth-test-supersecret-9876543210");
  });

  it("falls back to the empty-state message when nothing is stored", async () => {
    const store = fakeStore();
    const cliConsole = captureConsole();
    const result = await authStatus({}, { store, console: cliConsole });
    expect(result.entries).toEqual([]);
    expect(cliConsole.lines.join("\n")).toMatch(/issuepilot auth login/);
  });
});

describe("authLogout", () => {
  it("removes a single hostname", async () => {
    const cred: StoredCredential = {
      version: 1,
      hostname: "gitlab.example.com",
      clientId: "issuepilot-cli",
      accessToken: "oauth-test-x",
      tokenType: "Bearer",
      obtainedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const store = fakeStore([cred]);
    const cliConsole = captureConsole();
    const result = await authLogout(
      { hostname: "gitlab.example.com" },
      { store, console: cliConsole },
    );
    expect(result.removed).toEqual(["gitlab.example.com"]);
    expect(await store.list()).toEqual([]);
  });

  it("refuses to wipe everything without --all", async () => {
    const store = fakeStore();
    const cliConsole = captureConsole();
    const result = await authLogout({}, { store, console: cliConsole });
    expect(result.removed).toEqual([]);
    expect(cliConsole.errors.join("\n")).toMatch(/--all/);
  });
});
