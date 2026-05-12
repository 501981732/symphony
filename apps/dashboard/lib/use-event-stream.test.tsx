// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __setEventSourceFactory,
  useEventStream,
  type AppEventLike,
} from "./use-event-stream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  public url: string;
  public closed = false;
  public onmessage: ((ev: { data: string }) => void) | null = null;
  public onerror: ((ev: unknown) => void) | null = null;
  public onopen: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(event: AppEventLike) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  triggerError() {
    this.onerror?.({});
  }

  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  process.env.NEXT_PUBLIC_API_BASE = "http://api.test";
  vi.useFakeTimers();
  __setEventSourceFactory((url) => new FakeEventSource(url) as never);
});

afterEach(() => {
  vi.useRealTimers();
  __setEventSourceFactory(null);
  delete process.env.NEXT_PUBLIC_API_BASE;
});

describe("useEventStream", () => {
  it("opens stream against /api/events/stream with runId filter", () => {
    const { result } = renderHook(() => useEventStream({ runId: "r1" }));

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe(
      "http://api.test/api/events/stream?runId=r1",
    );
    expect(result.current.status).toBe("connecting");
  });

  it("appends events on message and respects buffer cap", () => {
    const { result } = renderHook(() => useEventStream({ bufferSize: 3 }));
    const es = FakeEventSource.instances[0]!;

    act(() => {
      for (let i = 0; i < 5; i++) {
        es.emit({
          id: `e${i}`,
          runId: "r1",
          type: "notification",
          message: `msg-${i}`,
        });
      }
    });

    expect(result.current.events.map((e) => e.id)).toEqual(["e2", "e3", "e4"]);
  });

  it("invokes onEvent callback for each delivered event", () => {
    const handler = vi.fn();
    renderHook(() => useEventStream({ onEvent: handler }));

    act(() => {
      FakeEventSource.instances[0]!.emit({
        id: "e1",
        runId: "r1",
        type: "run_started",
        message: "hi",
      });
    });

    expect(handler).toHaveBeenCalledWith({
      id: "e1",
      runId: "r1",
      type: "run_started",
      message: "hi",
    });
  });

  it("reconnects with exponential backoff on error", async () => {
    renderHook(() => useEventStream({}));
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => FakeEventSource.instances[0]!.triggerError());
    expect(FakeEventSource.instances[0]!.closed).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(FakeEventSource.instances).toHaveLength(2);

    act(() => FakeEventSource.instances[1]!.triggerError());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("closes EventSource on unmount", () => {
    const { unmount } = renderHook(() => useEventStream({}));
    const es = FakeEventSource.instances[0]!;

    unmount();

    expect(es.closed).toBe(true);
  });

  it("ignores malformed payloads but keeps stream open", () => {
    const { result } = renderHook(() => useEventStream({}));
    const es = FakeEventSource.instances[0]!;

    act(() => {
      es.onmessage?.({ data: "not-json" });
      es.emit({
        id: "ok",
        runId: "r",
        type: "notification",
        message: "ok",
      });
    });

    expect(result.current.events.map((e) => e.id)).toEqual(["ok"]);
    expect(es.closed).toBe(false);
  });
});
