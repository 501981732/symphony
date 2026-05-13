/**
 * SSE helpers for E2E tests.
 *
 * `waitForEvent` opens a streaming `fetch` against the orchestrator's
 * `/api/events/stream` SSE endpoint, parses `data: ` frames, and resolves
 * once the predicate matches. It is intentionally minimal — there are no
 * reconnection semantics — because tests are short-lived and we always
 * abort before the daemon shuts down.
 */

interface WaitForEventOptions {
  timeoutMs?: number;
  /**
   * Optional `runId` filter to forward as a query string. The orchestrator's
   * SSE endpoint only emits events whose `runId === filter`.
   */
  runId?: string;
}

export async function waitForEvent(
  daemonUrl: string,
  predicate: (event: unknown) => boolean,
  opts: WaitForEventOptions = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const url = new URL(`${daemonUrl}/api/events/stream`);
  if (opts.runId) url.searchParams.set("runId", opts.runId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || !res.body) {
      throw new Error(
        `waitForEvent: SSE handshake failed with status ${res.status}`,
      );
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error("waitForEvent: stream ended before predicate matched");
      }
      buffer += decoder.decode(value, { stream: true });
      let frameEnd = buffer.indexOf("\n\n");
      while (frameEnd !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice("data: ".length).trim();
          if (!payload) continue;
          try {
            const parsed = JSON.parse(payload) as unknown;
            if (predicate(parsed)) {
              controller.abort();
              return parsed;
            }
          } catch {
            // Ignore malformed frames — the SSE channel may also send
            // keepalive comments, which we filter out via the `data: `
            // prefix check above.
          }
        }
        frameEnd = buffer.indexOf("\n\n");
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        `waitForEvent: timed out after ${timeoutMs}ms waiting for matching event`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
