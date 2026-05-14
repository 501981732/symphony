import { describe, expect, it } from "vitest";

import { hostnameFromBaseUrl, splitCommand } from "../daemon.js";

describe("hostnameFromBaseUrl", () => {
  it("returns the bare hostname for an https URL", () => {
    expect(hostnameFromBaseUrl("https://gitlab.example.com")).toBe(
      "gitlab.example.com",
    );
  });

  it("strips a trailing path", () => {
    expect(hostnameFromBaseUrl("https://gitlab.example.com/")).toBe(
      "gitlab.example.com",
    );
    expect(hostnameFromBaseUrl("http://gitlab.local:8080/api/v4")).toBe(
      "gitlab.local",
    );
  });

  it("returns the input verbatim when it is not a URL", () => {
    expect(hostnameFromBaseUrl("gitlab.example.com")).toBe(
      "gitlab.example.com",
    );
  });
});

describe("splitCommand", () => {
  it("splits a simple command on whitespace", () => {
    expect(splitCommand("codex app-server")).toEqual({
      command: "codex",
      args: ["app-server"],
    });
  });

  it("preserves spaces inside double quotes", () => {
    expect(
      splitCommand('"/Users/User Name/.local/bin/codex" app-server'),
    ).toEqual({
      command: "/Users/User Name/.local/bin/codex",
      args: ["app-server"],
    });
  });

  it("preserves spaces inside single quotes", () => {
    expect(
      splitCommand("'/var/data with space/codex' app-server --foo bar"),
    ).toEqual({
      command: "/var/data with space/codex",
      args: ["app-server", "--foo", "bar"],
    });
  });

  it("supports mixed quoted + unquoted arguments", () => {
    expect(
      splitCommand("tsx '/tmp/My Folder/main.ts' /tmp/script.json"),
    ).toEqual({
      command: "tsx",
      args: ["/tmp/My Folder/main.ts", "/tmp/script.json"],
    });
  });

  it("collapses adjacent whitespace", () => {
    expect(splitCommand("  codex   app-server   ")).toEqual({
      command: "codex",
      args: ["app-server"],
    });
  });

  it("rejects an empty string", () => {
    expect(() => splitCommand("   ")).toThrow(/must not be empty/);
  });

  it("rejects an unbalanced quote", () => {
    expect(() => splitCommand('codex "app-server')).toThrow(/unbalanced/);
  });
});
