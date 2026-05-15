import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  TeamConfigError,
  loadTeamConfig,
  parseTeamConfig,
} from "../config.js";

describe("team config", () => {
  it("parses defaults and resolves workflow paths relative to the config file", () => {
    const config = parseTeamConfig(
      [
        "version: 1",
        "projects:",
        "  - id: platform-web",
        "    name: Platform Web",
        "    workflow: ./platform-web/WORKFLOW.md",
        "  - id: infra-tools",
        "    name: Infra Tools",
        "    workflow: /srv/infra-tools/WORKFLOW.md",
        "    enabled: false",
      ].join("\n"),
      "/srv/issuepilot/issuepilot.team.yaml",
    );

    expect(config.server).toEqual({ host: "127.0.0.1", port: 4738 });
    expect(config.scheduler).toEqual({
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerProject: 1,
      leaseTtlMs: 900000,
      pollIntervalMs: 10000,
    });
    expect(config.projects[0]?.workflowPath).toBe(
      "/srv/issuepilot/platform-web/WORKFLOW.md",
    );
    expect(config.projects[1]?.enabled).toBe(false);
  });

  it("rejects duplicate project ids", () => {
    expect(() =>
      parseTeamConfig(
        [
          "version: 1",
          "projects:",
          "  - id: platform-web",
          "    name: One",
          "    workflow: ./one/WORKFLOW.md",
          "  - id: platform-web",
          "    name: Two",
          "    workflow: ./two/WORKFLOW.md",
        ].join("\n"),
        "/srv/issuepilot/issuepilot.team.yaml",
      ),
    ).toThrow(
      new TeamConfigError("duplicate project id: platform-web", "projects"),
    );
  });

  it("rejects unsupported max concurrency", () => {
    expect(() =>
      parseTeamConfig(
        [
          "version: 1",
          "scheduler:",
          "  max_concurrent_runs: 6",
          "projects:",
          "  - id: platform-web",
          "    name: Platform Web",
          "    workflow: ./platform-web/WORKFLOW.md",
        ].join("\n"),
        "/srv/issuepilot/issuepilot.team.yaml",
      ),
    ).toThrow(/scheduler.max_concurrent_runs/);
  });

  it("surfaces malformed YAML with the (yaml) path placeholder", () => {
    let caught: unknown;
    try {
      parseTeamConfig(
        "version: 1\nprojects:\n  - id: : bad\n",
        "/srv/issuepilot/issuepilot.team.yaml",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TeamConfigError);
    expect((caught as TeamConfigError).path).toBe("(yaml)");
  });

  it("converts camelCase zod paths back to snake_case for YAML readability", () => {
    let caught: unknown;
    try {
      parseTeamConfig(
        [
          "version: 1",
          "scheduler:",
          "  lease_ttl_ms: 500",
          "projects:",
          "  - id: platform-web",
          "    name: Platform Web",
          "    workflow: ./platform-web/WORKFLOW.md",
        ].join("\n"),
        "/srv/issuepilot/issuepilot.team.yaml",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TeamConfigError);
    expect((caught as TeamConfigError).path).toBe("scheduler.lease_ttl_ms");
    expect((caught as TeamConfigError).message).toMatch(
      /scheduler\.lease_ttl_ms/,
    );
  });

  it("omits the ci section by default so workflow defaults win", () => {
    const config = parseTeamConfig(
      [
        "version: 1",
        "projects:",
        "  - id: platform-web",
        "    name: Platform Web",
        "    workflow: ./WORKFLOW.md",
      ].join("\n"),
      "/srv/issuepilot/issuepilot.team.yaml",
    );

    expect(config.ci).toBeNull();
  });

  it("reads team-wide ci overrides and fills missing keys with defaults", () => {
    const config = parseTeamConfig(
      [
        "version: 1",
        "ci:",
        "  enabled: true",
        "projects:",
        "  - id: platform-web",
        "    name: Platform Web",
        "    workflow: ./WORKFLOW.md",
      ].join("\n"),
      "/srv/issuepilot/issuepilot.team.yaml",
    );

    expect(config.ci).toEqual({
      enabled: true,
      onFailure: "ai-rework",
      waitForPipeline: true,
    });
  });

  it("rejects unsupported ci.on_failure values with snake_case zod path", () => {
    let caught: unknown;
    try {
      parseTeamConfig(
        [
          "version: 1",
          "ci:",
          "  on_failure: ai-failed",
          "projects:",
          "  - id: platform-web",
          "    name: Platform Web",
          "    workflow: ./WORKFLOW.md",
        ].join("\n"),
        "/srv/issuepilot/issuepilot.team.yaml",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TeamConfigError);
    expect((caught as TeamConfigError).path).toBe("ci.on_failure");
  });

  it("loads a config file from disk", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "team-config-"));
    const configPath = path.join(tmpDir, "issuepilot.team.yaml");
    await fs.writeFile(
      configPath,
      [
        "version: 1",
        "projects:",
        "  - id: platform-web",
        "    name: Platform Web",
        "    workflow: ./WORKFLOW.md",
      ].join("\n"),
    );

    const config = await loadTeamConfig(configPath);

    expect(config.source.path).toBe(configPath);
    expect(config.projects[0]?.workflowPath).toBe(
      path.join(tmpDir, "WORKFLOW.md"),
    );
  });
});
