import { describe, it, expect } from "vitest";
import { redact } from "../redact.js";

describe("redact", () => {
  it("redacts GitLab personal access tokens (glpat-...)", () => {
    const input = { token: "glpat-abc123def456ghi789" };
    const result = redact(input);
    expect(JSON.stringify(result)).not.toContain("glpat-");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("redacts GitLab group access tokens (glpat- pattern)", () => {
    const input = { key: "glpat-xxxxxxxxxxxxxxxxxxxx" };
    const result = redact(input);
    expect(JSON.stringify(result)).not.toContain("glpat-");
  });

  it("redacts strings containing common secret field names", () => {
    const input = {
      password: "my-secret-pass",
      api_key: "sk-123456",
      token_env: "GITLAB_TOKEN",
      normal: "keep this",
    };
    const result = redact(input) as Record<string, unknown>;
    expect(result["password"]).toBe("[REDACTED]");
    expect(result["api_key"]).toBe("[REDACTED]");
    expect(result["token_env"]).toBe("GITLAB_TOKEN");
    expect(result["normal"]).toBe("keep this");
  });

  it("redacts token-like field names except token_env", () => {
    const input = {
      token_env: "GITLAB_TOKEN",
      refresh_token: "plain-refresh-value",
      id_token: "plain-id-value",
      gitlab_token: "plain-gitlab-value",
    };

    const result = redact(input) as Record<string, unknown>;

    expect(result["token_env"]).toBe("GITLAB_TOKEN");
    expect(result["refresh_token"]).toBe("[REDACTED]");
    expect(result["id_token"]).toBe("[REDACTED]");
    expect(result["gitlab_token"]).toBe("[REDACTED]");
  });

  it("redacts nested objects", () => {
    const input = { outer: { inner: { secret: "hidden" } } };
    const result = redact(input) as { outer: { inner: { secret: string } } };
    expect(result.outer.inner.secret).toBe("[REDACTED]");
  });

  it("handles arrays", () => {
    const input = [{ password: "x" }, { name: "keep" }];
    const result = redact(input) as Array<Record<string, unknown>>;
    expect(result[0]!["password"]).toBe("[REDACTED]");
    expect(result[1]!["name"]).toBe("keep");
  });

  it("redacts Bearer tokens in string values", () => {
    const input = { header: "Bearer glpat-secrettoken123" };
    const result = redact(input) as { header: string };
    expect(result.header).not.toContain("glpat-");
  });

  it("returns primitives unchanged", () => {
    expect(redact("hello")).toBe("hello");
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
  });
});
