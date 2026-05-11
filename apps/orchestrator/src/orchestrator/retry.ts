export interface RetryInput {
  kind: "blocked" | "failed" | "retryable";
  attempt: number;
  maxAttempts: number;
}

export interface RetryDecision {
  retry: boolean;
  finalStatus?: "failed" | "blocked" | undefined;
}

export function shouldRetry(input: RetryInput): RetryDecision {
  if (input.kind === "blocked") {
    return { retry: false, finalStatus: "blocked" };
  }

  if (input.kind === "failed") {
    return { retry: false, finalStatus: "failed" };
  }

  if (input.kind === "retryable" && input.attempt < input.maxAttempts) {
    return { retry: true };
  }

  return { retry: false, finalStatus: "failed" };
}
