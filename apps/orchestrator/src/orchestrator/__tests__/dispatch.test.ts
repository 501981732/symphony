import { describe, it, expect, vi, afterEach } from "vitest";
import { dispatch } from "../dispatch.js";
import { createRuntimeState } from "../../runtime/state.js";
import type { DispatchDeps, DispatchInput } from "../dispatch.js";

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
    retryBackoffMs: 5_000,
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
  runningLabel: "ai-running",
  handoffLabel: "human-review",
  reworkLabel: "ai-rework",
  promptTemplate: "Fix {{ issue.title }}",
  hooks: {
    afterCreate: "echo afterCreate",
    beforeRun: "echo beforeRun",
    afterRun: "echo afterRun",
  },
};

describe("dispatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("passes no-code-change reason from agent outcome to reconcile", async () => {
    const deps = createFakeDeps({
      runAgent: vi.fn(async () => ({
        status: "completed",
        summary: "No edits needed",
        noCodeChangeReason: "The requested behavior already exists.",
      })),
    });

    await dispatch(baseInput, deps);

    expect(deps.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSummary: "No edits needed",
        noCodeChangeReason: "The requested behavior already exists.",
      }),
    );
  });

  it("renders prompt with spec-shaped dotted context", async () => {
    const deps = createFakeDeps();
    await dispatch(baseInput, deps);

    expect(deps.renderPrompt).toHaveBeenCalledWith({
      template: baseInput.promptTemplate,
      vars: expect.objectContaining({
        issue: expect.objectContaining({
          iid: 1,
          identifier: "group/project#1",
          title: "Fix bug",
          url: "https://gitlab.example.com/issues/1",
        }),
        attempt: 1,
        workspace: { path: "/tmp/wt" },
        git: { branch: "ai/1-fix" },
      }),
    });
  });

  it("does not reconcile when afterRun validation hook fails", async () => {
    const deps = createFakeDeps({
      runHook: vi.fn(async (opts: { script?: string }) => {
        if (opts.script === "echo afterRun") {
          throw Object.assign(new Error("validation failed"), {
            name: "HookFailedError",
          });
        }
        return { stdout: "", stderr: "" };
      }),
    });

    await dispatch(baseInput, deps);

    expect(deps.reconcile).not.toHaveBeenCalled();
    expect(deps.state.getRun("run-1")?.status).toBe("failed");
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T03:00:00.000Z"));
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
    expect(run?.nextRetryAt).toBe("2026-05-11T03:00:05.000Z");

    const retryEvent = deps.events.find((e) => e.type === "retry_scheduled");
    expect(retryEvent).toMatchObject({
      detail: {
        attempt: 2,
        nextRetryAt: "2026-05-11T03:00:05.000Z",
        reason: "503",
      },
    });
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
