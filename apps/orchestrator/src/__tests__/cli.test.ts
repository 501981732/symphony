import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildCli } from "../cli.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("CLI", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
    process.exitCode = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("validate fails for missing workflow", async () => {
    const cli = buildCli();
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

    await cli.parseAsync(["validate", "--workflow", "/nonexistent/wf.md"], {
      from: "user",
    });

    expect(process.exitCode).toBe(1);
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
    );
    mockError.mockRestore();
    process.exitCode = 0;
  });

  it("validate succeeds for existing workflow", async () => {
    const wfPath = path.join(tmpDir, "wf.md");
    fs.writeFileSync(wfPath, "---\ntitle: test\n---\n");

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const cli = buildCli({
      validateWorkflow: async () => ({
        tracker: {
          kind: "gitlab",
          baseUrl: "https://gitlab.example.com",
          projectId: "group/project",
          tokenEnv: "GITLAB_TOKEN",
          activeLabels: ["ai-ready"],
          runningLabel: "ai-running",
          handoffLabel: "human-review",
          failedLabel: "ai-failed",
          blockedLabel: "ai-blocked",
          reworkLabel: "ai-rework",
          mergingLabel: "ai-merging",
        },
        workspace: {
          root: "/tmp/issuepilot",
          strategy: "worktree",
          repoCacheRoot: "/tmp/issuepilot/cache",
        },
        git: {
          repoUrl: "git@example.com:group/project.git",
          baseBranch: "main",
          branchPrefix: "issuepilot",
        },
        agent: {
          runner: "codex-app-server",
          maxConcurrentAgents: 1,
          maxTurns: 3,
          maxAttempts: 2,
          retryBackoffMs: 1000,
        },
        codex: {
          command: "codex app-server",
          approvalPolicy: "never",
          threadSandbox: "workspace-write",
          turnTimeoutMs: 60_000,
          turnSandboxPolicy: { type: "workspaceWrite" },
        },
        hooks: {},
        promptTemplate: "Fix {{ issue.title }}",
        source: {
          path: wfPath,
          sha256: "sha",
          loadedAt: new Date(0).toISOString(),
        },
      }),
    });

    await cli.parseAsync(["validate", "--workflow", wfPath], {
      from: "user",
    });

    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("Validation passed"),
    );
    mockLog.mockRestore();
  });

  it("doctor runs checks", async () => {
    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const cli = buildCli({
      checkCodexAppServer: async () => "0.0.0",
      execaCommand: async () => ({ stdout: "git version 2.0.0" }) as never,
    });

    await cli.parseAsync(["doctor"], { from: "user" });

    const output = mockLog.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Node.js");
    expect(output).toContain("git");
    expect(output).toContain("state dir");
    mockLog.mockRestore();
  });

  it("run fails for missing workflow", async () => {
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});
    const cli = buildCli();

    await cli.parseAsync(["run", "--workflow", "/nonexistent/wf.md"], {
      from: "user",
    });

    expect(process.exitCode).toBe(1);
    mockError.mockRestore();
    process.exitCode = 0;
  });

  it("run starts for valid workflow", async () => {
    const wfPath = path.join(tmpDir, "wf.md");
    fs.writeFileSync(wfPath, "---\ntitle: test\n---\n");

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const startDaemon = vi.fn(async () => ({
      host: "127.0.0.1",
      port: 4738,
      url: "http://127.0.0.1:4738",
      state: {} as never,
      stop: async () => undefined,
      wait: async () => undefined,
    }));
    const cli = buildCli({ startDaemon });

    await cli.parseAsync(["run", "--workflow", wfPath], { from: "user" });

    expect(startDaemon).toHaveBeenCalledWith({
      workflowPath: wfPath,
      port: 4738,
      host: "127.0.0.1",
    });
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("daemon ready"),
    );
    mockLog.mockRestore();
  });

  describe("auth subcommands", () => {
    it("auth login forwards hostname/scope/client-id to authLogin", async () => {
      const authLogin = vi.fn(async () => ({}));
      const cli = buildCli({ authLogin });
      await cli.parseAsync(
        [
          "auth",
          "login",
          "--hostname",
          "gitlab.example.com",
          "--scope",
          "api read_repository",
          "--client-id",
          "test-client",
        ],
        { from: "user" },
      );
      expect(authLogin).toHaveBeenCalledWith({
        hostname: "gitlab.example.com",
        scope: ["api", "read_repository"],
        clientId: "test-client",
      });
    });

    it("auth status forwards hostname filter to authStatus", async () => {
      const authStatus = vi.fn(async () => ({}));
      const cli = buildCli({ authStatus });
      await cli.parseAsync(
        ["auth", "status", "--hostname", "gitlab.example.com"],
        { from: "user" },
      );
      expect(authStatus).toHaveBeenCalledWith({
        hostname: "gitlab.example.com",
      });
    });

    it("auth logout forwards hostname or --all", async () => {
      const authLogout = vi.fn(async () => ({}));
      const cli = buildCli({ authLogout });
      await cli.parseAsync(
        ["auth", "logout", "--hostname", "gitlab.example.com"],
        { from: "user" },
      );
      expect(authLogout).toHaveBeenCalledWith({
        hostname: "gitlab.example.com",
      });

      authLogout.mockClear();
      const cli2 = buildCli({ authLogout });
      await cli2.parseAsync(["auth", "logout", "--all"], { from: "user" });
      expect(authLogout).toHaveBeenCalledWith({ all: true });
    });

    it("auth login surfaces non-zero exit code on failure", async () => {
      const authLogin = vi.fn(async () => {
        throw new Error("boom");
      });
      const mockError = vi.spyOn(console, "error").mockImplementation(() => {});
      const cli = buildCli({ authLogin });
      await cli.parseAsync(
        ["auth", "login", "--hostname", "gitlab.example.com"],
        { from: "user" },
      );
      expect(process.exitCode).toBe(1);
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining("auth login failed"),
      );
      mockError.mockRestore();
      process.exitCode = 0;
    });
  });
});
