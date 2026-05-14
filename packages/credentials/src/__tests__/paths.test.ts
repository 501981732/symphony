import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertSecureFileMode,
  CredentialsPermissionError,
  credentialsPath,
  ensureCredentialsDir,
} from "../paths.js";

describe("credentialsPath", () => {
  it("defaults to <home>/.issuepilot/credentials", () => {
    const home = "/tmp/example-home";
    const result = credentialsPath({ homeDir: home });
    expect(result.dir).toBe(path.join(home, ".issuepilot"));
    expect(result.file).toBe(path.join(home, ".issuepilot", "credentials"));
  });

  it("honors configDirOverride (IPILOT_HOME)", () => {
    const result = credentialsPath({
      homeDir: "/ignored",
      configDirOverride: "/srv/issuepilot",
    });
    expect(result.dir).toBe("/srv/issuepilot");
    expect(result.file).toBe(path.join("/srv/issuepilot", "credentials"));
  });
});

describe("ensureCredentialsDir + assertSecureFileMode", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ipilot-paths-"));
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("creates the dir with mode 0700", async () => {
    const target = path.join(tmpHome, ".issuepilot");
    await ensureCredentialsDir(target);
    const stat = fs.statSync(target);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o700);
    }
  });

  it("repairs an existing dir whose mode is too permissive", async () => {
    const target = path.join(tmpHome, ".issuepilot");
    fs.mkdirSync(target, { mode: 0o755 });
    await ensureCredentialsDir(target);
    if (process.platform !== "win32") {
      expect(fs.statSync(target).mode & 0o777).toBe(0o700);
    }
  });

  it("rejects a credentials file whose mode allows group/world read", async () => {
    const file = path.join(tmpHome, "credentials");
    fs.writeFileSync(file, "[]", { mode: 0o644 });
    if (process.platform === "win32") {
      await expect(assertSecureFileMode(file)).resolves.toBeUndefined();
      return;
    }
    await expect(assertSecureFileMode(file)).rejects.toBeInstanceOf(
      CredentialsPermissionError,
    );
  });

  it("accepts a credentials file with mode 0600", async () => {
    const file = path.join(tmpHome, "credentials");
    fs.writeFileSync(file, "[]", { mode: 0o600 });
    await expect(assertSecureFileMode(file)).resolves.toBeUndefined();
  });
});
