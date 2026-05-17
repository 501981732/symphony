import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { TeamConfigError, loadTeamConfig, parseTeamConfig } from "../config.js";

describe("team config", () => {
  it("parses central team config project and profile paths", () => {
    const config = parseTeamConfig(
      [
        "version: 1",
        "defaults:",
        "  labels: ./policies/labels.gitlab.yaml",
        "  codex: ./policies/codex.default.yaml",
        "  workspace_root: ~/.issuepilot/workspaces",
        "  repo_cache_root: ~/.issuepilot/repos",
        "projects:",
        "  - id: platform-web",
        "    name: Platform Web",
        "    project: ./projects/platform-web.yaml",
        "    workflow_profile: ./workflows/default-web.md",
        "    enabled: true",
        "  - id: infra-tools",
        "    name: Infra Tools",
        "    project: /srv/issuepilot-config/projects/infra-tools.yaml",
        "    workflow_profile: ./workflows/default-node-lib.md",
        "    enabled: false",
      ].join("\n"),
      "/srv/issuepilot-config/issuepilot.team.yaml",
    );

    expect(config.defaults.labelsPath).toBe(
      "/srv/issuepilot-config/policies/labels.gitlab.yaml",
    );
    expect(config.defaults.codexPath).toBe(
      "/srv/issuepilot-config/policies/codex.default.yaml",
    );
    expect(config.defaults.workspaceRoot).toBe("~/.issuepilot/workspaces");
    expect(config.defaults.repoCacheRoot).toBe("~/.issuepilot/repos");

    expect(config.projects[0]).toMatchObject({
      id: "platform-web",
      projectPath: "/srv/issuepilot-config/projects/platform-web.yaml",
      workflowProfilePath: "/srv/issuepilot-config/workflows/default-web.md",
      enabled: true,
      ci: null,
    });
    expect(config.projects[1]).toMatchObject({
      id: "infra-tools",
      projectPath: "/srv/issuepilot-config/projects/infra-tools.yaml",
      workflowProfilePath:
        "/srv/issuepilot-config/workflows/default-node-lib.md",
      enabled: false,
    });
  });

  it("applies default workspace/repo roots when defaults block is omitted", () => {
    const config = parseTeamConfig(
      [
        "version: 1",
        "projects:",
        "  - id: platform-web",
        "    name: Platform Web",
        "    project: ./projects/platform-web.yaml",
        "    workflow_profile: ./workflows/default-web.md",
      ].join("\n"),
      "/srv/issuepilot-config/issuepilot.team.yaml",
    );

    expect(config.defaults.labelsPath).toBeNull();
    expect(config.defaults.codexPath).toBeNull();
    expect(config.defaults.workspaceRoot).toBe("~/.issuepilot/workspaces");
    expect(config.defaults.repoCacheRoot).toBe("~/.issuepilot/repos");
  });

  it("rejects legacy projects[].workflow in team mode with an actionable message", () => {
    let caught: unknown;
    try {
      parseTeamConfig(
        [
          "version: 1",
          "projects:",
          "  - id: platform-web",
          "    name: Platform Web",
          "    workflow: /srv/repos/platform-web/WORKFLOW.md",
        ].join("\n"),
        "/srv/issuepilot-config/issuepilot.team.yaml",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TeamConfigError);
    const err = caught as TeamConfigError;
    expect(err.path).toBe("projects.0.workflow");
    expect(err.message).toMatch(/projects\.0\.workflow/);
    expect(err.message).toMatch(/no longer supported/);
    expect(err.message).toMatch(/workflow_profile/);
  });

  it("rejects duplicate project ids", () => {
    expect(() =>
      parseTeamConfig(
        [
          "version: 1",
          "projects:",
          "  - id: platform-web",
          "    name: One",
          "    project: ./projects/one.yaml",
          "    workflow_profile: ./workflows/default-web.md",
          "  - id: platform-web",
          "    name: Two",
          "    project: ./projects/two.yaml",
          "    workflow_profile: ./workflows/default-web.md",
        ].join("\n"),
        "/srv/issuepilot-config/issuepilot.team.yaml",
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
          "    project: ./projects/platform-web.yaml",
          "    workflow_profile: ./workflows/default-web.md",
        ].join("\n"),
        "/srv/issuepilot-config/issuepilot.team.yaml",
      ),
    ).toThrow(/scheduler.max_concurrent_runs/);
  });

  it("surfaces malformed YAML with the (yaml) path placeholder", () => {
    let caught: unknown;
    try {
      parseTeamConfig(
        "version: 1\nprojects:\n  - id: : bad\n",
        "/srv/issuepilot-config/issuepilot.team.yaml",
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
          "    project: ./projects/platform-web.yaml",
          "    workflow_profile: ./workflows/default-web.md",
        ].join("\n"),
        "/srv/issuepilot-config/issuepilot.team.yaml",
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
        "    project: ./projects/platform-web.yaml",
        "    workflow_profile: ./workflows/default-web.md",
      ].join("\n"),
      "/srv/issuepilot-config/issuepilot.team.yaml",
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
        "    project: ./projects/platform-web.yaml",
        "    workflow_profile: ./workflows/default-web.md",
      ].join("\n"),
      "/srv/issuepilot-config/issuepilot.team.yaml",
    );

    expect(config.ci).toEqual({
      enabled: true,
      onFailure: "ai-rework",
      waitForPipeline: true,
    });
  });

  it("omits projects[].ci by default", () => {
    const config = parseTeamConfig(
      [
        "version: 1",
        "projects:",
        "  - id: platform-web",
        "    name: Platform Web",
        "    project: ./projects/platform-web.yaml",
        "    workflow_profile: ./workflows/default-web.md",
      ].join("\n"),
      "/srv/issuepilot-config/issuepilot.team.yaml",
    );

    expect(config.projects[0]?.ci).toBeNull();
  });

  it("parses projects[].ci and fills missing keys with defaults", () => {
    const config = parseTeamConfig(
      [
        "version: 1",
        "projects:",
        "  - id: platform-web",
        "    name: Platform Web",
        "    project: ./projects/platform-web.yaml",
        "    workflow_profile: ./workflows/default-web.md",
        "    ci:",
        "      enabled: true",
        "      on_failure: human-review",
      ].join("\n"),
      "/srv/issuepilot-config/issuepilot.team.yaml",
    );

    expect(config.projects[0]?.ci).toEqual({
      enabled: true,
      onFailure: "human-review",
      waitForPipeline: true,
    });
  });

  it("rejects unsupported projects[].ci.on_failure values with snake_case zod path", () => {
    let caught: unknown;
    try {
      parseTeamConfig(
        [
          "version: 1",
          "projects:",
          "  - id: platform-web",
          "    name: Platform Web",
          "    project: ./projects/platform-web.yaml",
          "    workflow_profile: ./workflows/default-web.md",
          "    ci:",
          "      on_failure: ai-failed",
        ].join("\n"),
        "/srv/issuepilot-config/issuepilot.team.yaml",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TeamConfigError);
    expect((caught as TeamConfigError).path).toBe("projects.0.ci.on_failure");
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
          "    project: ./projects/platform-web.yaml",
          "    workflow_profile: ./workflows/default-web.md",
        ].join("\n"),
        "/srv/issuepilot-config/issuepilot.team.yaml",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TeamConfigError);
    expect((caught as TeamConfigError).path).toBe("ci.on_failure");
  });

  it("defaults retention policy to spec §11 (7d successful, 30d failed, 50GB, 1h interval)", () => {
    const config = parseTeamConfig(
      [
        "version: 1",
        "projects:",
        "  - id: platform-web",
        "    name: Platform Web",
        "    project: ./projects/platform-web.yaml",
        "    workflow_profile: ./workflows/default-web.md",
      ].join("\n"),
      "/srv/issuepilot-config/issuepilot.team.yaml",
    );

    expect(config.retention).toEqual({
      successfulRunDays: 7,
      failedRunDays: 30,
      maxWorkspaceGb: 50,
      cleanupIntervalMs: 3_600_000,
    });
  });

  it("reads retention overrides and accepts cleanup_interval_ms", () => {
    const config = parseTeamConfig(
      [
        "version: 1",
        "retention:",
        "  successful_run_days: 3",
        "  failed_run_days: 14",
        "  max_workspace_gb: 20",
        "  cleanup_interval_ms: 600000",
        "projects:",
        "  - id: platform-web",
        "    name: Platform Web",
        "    project: ./projects/platform-web.yaml",
        "    workflow_profile: ./workflows/default-web.md",
      ].join("\n"),
      "/srv/issuepilot-config/issuepilot.team.yaml",
    );

    expect(config.retention).toEqual({
      successfulRunDays: 3,
      failedRunDays: 14,
      maxWorkspaceGb: 20,
      cleanupIntervalMs: 600_000,
    });
  });

  it("rejects retention.cleanup_interval_ms below the 60s floor with snake_case path", () => {
    let caught: unknown;
    try {
      parseTeamConfig(
        [
          "version: 1",
          "retention:",
          "  cleanup_interval_ms: 30000",
          "projects:",
          "  - id: platform-web",
          "    name: Platform Web",
          "    project: ./projects/platform-web.yaml",
          "    workflow_profile: ./workflows/default-web.md",
        ].join("\n"),
        "/srv/issuepilot-config/issuepilot.team.yaml",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TeamConfigError);
    expect((caught as TeamConfigError).path).toBe(
      "retention.cleanup_interval_ms",
    );
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
        "    project: ./projects/platform-web.yaml",
        "    workflow_profile: ./workflows/default-web.md",
      ].join("\n"),
    );

    const config = await loadTeamConfig(configPath);

    expect(config.source.path).toBe(configPath);
    expect(config.projects[0]?.projectPath).toBe(
      path.join(tmpDir, "projects", "platform-web.yaml"),
    );
    expect(config.projects[0]?.workflowProfilePath).toBe(
      path.join(tmpDir, "workflows", "default-web.md"),
    );
  });
});
