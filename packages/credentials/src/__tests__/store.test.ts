import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CredentialsPermissionError } from "../paths.js";
import { createCredentialsStore } from "../store.js";
import type { StoredCredential } from "../types.js";

function sample(hostname: string, suffix: string): StoredCredential {
  return {
    version: 1,
    hostname,
    clientId: "issuepilot-cli",
    accessToken: `oauth-test-access-${suffix}`,
    refreshToken: `oauth-test-refresh-${suffix}`,
    tokenType: "Bearer",
    scope: "api",
    obtainedAt: new Date(1_700_000_000_000).toISOString(),
    expiresAt: new Date(1_700_000_000_000 + 7_200_000).toISOString(),
  };
}

describe("CredentialsStore", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ipilot-store-"));
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("write → read returns the same credential", async () => {
    const store = createCredentialsStore({ homeDir: tmpHome });
    const cred = sample("gitlab.example.com", "1");
    await store.write(cred);

    const round = await store.read("gitlab.example.com");
    expect(round).toEqual(cred);
  });

  it("read returns null when no entry exists", async () => {
    const store = createCredentialsStore({ homeDir: tmpHome });
    expect(await store.read("missing.example.com")).toBeNull();
  });

  it("write replaces the entry for the same hostname", async () => {
    const store = createCredentialsStore({ homeDir: tmpHome });
    await store.write(sample("gitlab.example.com", "1"));
    await store.write(sample("gitlab.example.com", "2"));
    const got = await store.read("gitlab.example.com");
    expect(got?.accessToken).toBe("oauth-test-access-2");
  });

  it("list returns every hostname; delete removes the requested one", async () => {
    const store = createCredentialsStore({ homeDir: tmpHome });
    await store.write(sample("gitlab.a.com", "a"));
    await store.write(sample("gitlab.b.com", "b"));
    expect((await store.list()).map((c) => c.hostname).sort()).toEqual([
      "gitlab.a.com",
      "gitlab.b.com",
    ]);
    await store.delete("gitlab.a.com");
    expect((await store.list()).map((c) => c.hostname)).toEqual([
      "gitlab.b.com",
    ]);
  });

  it("writes the file with mode 0600 and dir with mode 0700", async () => {
    if (process.platform === "win32") return;
    const store = createCredentialsStore({ homeDir: tmpHome });
    await store.write(sample("gitlab.example.com", "1"));
    const file = path.join(tmpHome, ".issuepilot", "credentials");
    const dir = path.join(tmpHome, ".issuepilot");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rejects reading when an existing file has world-readable mode", async () => {
    if (process.platform === "win32") return;
    const dir = path.join(tmpHome, ".issuepilot");
    fs.mkdirSync(dir, { mode: 0o700 });
    const file = path.join(dir, "credentials");
    fs.writeFileSync(file, "[]", { mode: 0o644 });
    const store = createCredentialsStore({ homeDir: tmpHome });
    await expect(store.read("gitlab.example.com")).rejects.toBeInstanceOf(
      CredentialsPermissionError,
    );
  });

  it("rejects credentials with the wrong version", async () => {
    const dir = path.join(tmpHome, ".issuepilot");
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, "credentials"),
      JSON.stringify([{ version: 2, hostname: "x", accessToken: "y" }]),
      { mode: 0o600 },
    );
    const store = createCredentialsStore({ homeDir: tmpHome });
    await expect(store.read("x")).rejects.toThrow(/version/);
  });
});
