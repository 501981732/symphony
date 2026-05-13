import { describe, it, expect } from "vitest";
import { shouldRetry } from "../retry.js";

describe("shouldRetry", () => {
  it("retries when retryable and under max attempts", () => {
    const result = shouldRetry({
      kind: "retryable",
      attempt: 1,
      maxAttempts: 2,
    });
    expect(result.retry).toBe(true);
  });

  it("does not retry when attempt >= maxAttempts", () => {
    const result = shouldRetry({
      kind: "retryable",
      attempt: 2,
      maxAttempts: 2,
    });
    expect(result.retry).toBe(false);
    expect(result.finalStatus).toBe("failed");
  });

  it("does not retry blocked errors", () => {
    const result = shouldRetry({
      kind: "blocked",
      attempt: 1,
      maxAttempts: 5,
    });
    expect(result.retry).toBe(false);
    expect(result.finalStatus).toBe("blocked");
  });

  it("does not retry failed errors", () => {
    const result = shouldRetry({
      kind: "failed",
      attempt: 1,
      maxAttempts: 5,
    });
    expect(result.retry).toBe(false);
    expect(result.finalStatus).toBe("failed");
  });
});
