import { describe, it, expect } from "vitest";
import { classifyError } from "./classify.js";

describe("classifyError", () => {
  it("classifies GitLabError auth as blocked", () => {
    const err = Object.assign(new Error("token missing"), {
      name: "GitLabError",
      category: "auth",
    });
    const c = classifyError(err);
    expect(c.kind).toBe("blocked");
    expect(c.code).toBe("auth");
  });

  it("classifies GitLabError permission as blocked", () => {
    const err = Object.assign(new Error("403"), {
      name: "GitLabError",
      category: "permission",
    });
    const c = classifyError(err);
    expect(c.kind).toBe("blocked");
  });

  it("classifies GitLabError transient as retryable", () => {
    const err = Object.assign(new Error("503"), {
      name: "GitLabError",
      category: "transient",
    });
    const c = classifyError(err);
    expect(c.kind).toBe("retryable");
  });

  it("classifies GitLabError rate_limit as retryable", () => {
    const err = Object.assign(new Error("429"), {
      name: "GitLabError",
      category: "rate_limit",
    });
    const c = classifyError(err);
    expect(c.kind).toBe("retryable");
  });

  it("classifies WorkspaceDirtyError as failed", () => {
    const err = Object.assign(new Error("dirty"), {
      name: "WorkspaceDirtyError",
    });
    const c = classifyError(err);
    expect(c.kind).toBe("failed");
  });

  it("classifies HookFailedError as failed", () => {
    const err = Object.assign(new Error("hook exit 1"), {
      name: "HookFailedError",
    });
    const c = classifyError(err);
    expect(c.kind).toBe("failed");
  });

  it("classifies WorkspacePathError as blocked", () => {
    const err = Object.assign(new Error("escape"), {
      name: "WorkspacePathError",
    });
    const c = classifyError(err);
    expect(c.kind).toBe("blocked");
  });

  it("classifies unknown errors as failed", () => {
    const err = new Error("something unexpected");
    const c = classifyError(err);
    expect(c.kind).toBe("failed");
    expect(c.code).toBe("unknown");
  });

  it("classifies runner outcome failed as failed", () => {
    const c = classifyError({ status: "failed", reason: "turn failed" });
    expect(c.kind).toBe("failed");
  });

  it("classifies runner outcome timeout as retryable", () => {
    const c = classifyError({ status: "timeout", reason: "turn timed out" });
    expect(c.kind).toBe("retryable");
  });

  // Regression: GitLabError carries a numeric `.status` (HTTP status code)
  // alongside `.category`. The old classifier read `.status` first and
  // routed every HTTP error into the runner-outcome branch as
  // `kind: "failed"`, which silently demoted permission denials from
  // blocked → failed and broke the spec §21.12 escalation path.
  it("routes GitLabError by category even when it carries an HTTP status", () => {
    const err = Object.assign(new Error("403 Forbidden"), {
      name: "GitLabError",
      category: "permission",
      status: 403,
    });
    const c = classifyError(err);
    expect(c.kind).toBe("blocked");
    expect(c.code).toBe("permission");
  });

  it("routes GitLabError 401/auth as blocked even with status set", () => {
    const err = Object.assign(new Error("401 Unauthorized"), {
      name: "GitLabError",
      category: "auth",
      status: 401,
    });
    const c = classifyError(err);
    expect(c.kind).toBe("blocked");
    expect(c.code).toBe("auth");
  });
});
