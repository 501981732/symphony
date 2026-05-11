import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatch } from "./dispatch.js";
import { createRuntimeState } from "../runtime/state.js";
import type { DispatchDeps, DispatchInput } from "./dispatch.js";

function createFakeDeps(
  overrides: Partial<DispatchDeps> = {},
): DispatchDeps & { events: Array<{ type: string; [k: string]: unknown }> } {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const state = createRuntimeState();

  state.setRun("run-1", {
    runId: "run-1",
    status: "claimed",
    attempt: 1,
    branch: "ai/1-fix",
  });

  return {
    state,
    maxAttempts: 2,
    ensureMirror: vi.fn(async () => ({ mirrorPath: "/tmp/mirror" })),
    ensureWorktree: vi.fn(async () => ({
      worktreePath: "/tmp/wt",
      created: true,
    })),
    runHook: vi.fn(async () => ({ stdout: "", stderr: "" })),
    renderPrompt: vi.fn(() => "Fix issue #1"),
    runAgent: vi.fn(async () => ({
      status: "completed",
      summary: "Fixed it",
    })),
    reconcile: vi.fn(async () => {}),
    onEvent: vi.fn((e) => events.push(e)),
    onFailure: vi.fn(async () => {}),
    events,
    ...overrides,
  };
}

const baseInput: DispatchInput = {
  runId: "run-1",
  issue: {
    iid: 1,
    title: "Fix bug",
    url: "https://gitlab.example.com/issues/1",
    projectId: "group/project",
  },
  remoteUrl: "git@gitlab.example.com:group/project.git",
  repoCacheRoot: "/tmp/cache",
  worktreeRoot: "/tmp/worktrees",
  branch: "ai/1-fix",
  baseBranch: "main",
  promptTemplate: "Fix {{issue_title}}",
  hooks: {
    afterCreate: "echo afterCreate",
    beforeRun: "echo beforeRun",
    afterRun: "echo afterRun",
  },
};

describe("dispatch", () => {
  it("runs full happy path", async () => {
    const deps = createFakeDeps();
    await dispatch(baseInput, deps);

    expect(deps.ensureMirror).toHaveBeenCalled();
    expect(deps.ensureWorktree).toHaveBeenCalled();
    expect(deps.runHook).toHaveBeenCalledTimes(3);
    expect(deps.renderPrompt).toHaveBeenCalled();
    expect(deps.runAgent).toHaveBeenCalled();
    expect(deps.reconcile).toHaveBeenCalled();

    const run = deps.state.getRun("run-1");
    expect(run?.status).toBe("completed");

    const types = deps.events.map((e) => e.type);
    expect(types).toContain("dispatch_start");
    expect(types).toContain("dispatch_completed");
  });

  it("handles afterCreate hook failure → run_failed", async () => {
    const failHook = vi.fn(async (opts: { script?: string }) => {
      if (opts.script === "echo afterCreate") {
        throw Object.assign(new Error("hook exit 1"), {
          name: "HookFailedError",
        });
      }
      return { stdout: "", stderr: "" };
    });

    const deps = createFakeDeps({ runHook: failHook });
    await dispatch(baseInput, deps);

    const run = deps.state.getRun("run-1");
    expect(run?.status).toBe("failed");
    expect(deps.onFailure).toHaveBeenCalled();
  });

  it("retries on retryable error", async () => {
    const deps = createFakeDeps({
      ensureMirror: vi.fn(async () => {
        throw Object.assign(new Error("503"), {
          name: "GitLabError",
          category: "transient",
        });
      }),
    });
    await dispatch(baseInput, deps);

    const run = deps.state.getRun("run-1");
    expect(run?.status).toBe("retrying");
    expect(run?.attempt).toBe(2);

    const types = deps.events.map((e) => e.type);
    expect(types).toContain("retry_scheduled");
  });

  it("marks blocked on auth error", async () => {
    const deps = createFakeDeps({
      ensureMirror: vi.fn(async () => {
        throw Object.assign(new Error("unauthorized"), {
          name: "GitLabError",
          category: "auth",
        });
      }),
    });
    await dispatch(baseInput, deps);

    const run = deps.state.getRun("run-1");
    expect(run?.status).toBe("blocked");
    expect(deps.onFailure).toHaveBeenCalled();
  });

  it("skips afterCreate hook when worktree reused", async () => {
    const deps = createFakeDeps({
      ensureWorktree: vi.fn(async () => ({
        worktreePath: "/tmp/wt",
        created: false,
      })),
    });
    await dispatch(baseInput, deps);

    const hookCalls = (deps.runHook as ReturnType<typeof vi.fn>).mock.calls;
    const scripts = hookCalls.map(
      (c: [{ script?: string }]) => c[0].script,
    );
    expect(scripts).not.toContain("echo afterCreate");
    expect(scripts).toContain("echo beforeRun");
  });

  it("still runs afterRun hook even if agent fails but does not retry", async () => {
    const deps = createFakeDeps({
      runAgent: vi.fn(async () => ({ status: "failed", reason: "bad" })),
    });
    deps.state.setRun("run-1", {
      runId: "run-1",
      status: "claimed",
      attempt: 2,
      branch: "ai/1-fix",
    });
    (deps as DispatchDeps).maxAttempts = 2;
    await dispatch(baseInput, deps);

    const hookCalls = (deps.runHook as ReturnType<typeof vi.fn>).mock.calls;
    const scripts = hookCalls.map(
      (c: [{ script?: string }]) => c[0].script,
    );
    expect(scripts).toContain("echo afterRun");
  });
});
