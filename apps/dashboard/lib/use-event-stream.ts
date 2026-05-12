"use client";

import { useEffect, useRef, useState } from "react";

import { eventStreamUrl } from "./api";

/**
 * Anything the dashboard treats as an SSE payload. We keep this generic
 * (not pinned to `IssuePilotEvent`) so unit tests can publish minimal stubs
 * and consumers can opt-in to stricter typing via the generic parameter.
 */
export interface AppEventLike {
  id: string;
  runId: string;
  type: string;
  message?: string;
  [key: string]: unknown;
}

export type StreamStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface UseEventStreamOptions<T extends AppEventLike> {
  /** Restricts the SSE subscription to a single run. */
  runId?: string;
  /**
   * Maximum number of events kept in the in-memory buffer. Older events get
   * dropped FIFO when this is exceeded. Defaults to 200 — enough for a Run
   * detail view without leaking memory on long-lived dashboards.
   */
  bufferSize?: number;
  /** Side-effect callback invoked for every event (post-parse). */
  onEvent?: (event: T) => void;
  /** Disable the hook (e.g. while data is still loading). */
  enabled?: boolean;
}

export interface UseEventStreamResult<T extends AppEventLike> {
  events: T[];
  status: StreamStatus;
}

type EventSourceFactory = (url: string) => EventSourceLike;

interface EventSourceLike {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onopen: ((event: unknown) => void) | null;
  close(): void;
}

let factoryOverride: EventSourceFactory | null = null;

/**
 * Test-only seam used by `use-event-stream.test.tsx` to inject a fake
 * EventSource implementation. Pass `null` to restore the real EventSource.
 */
export function __setEventSourceFactory(
  factory: EventSourceFactory | null,
): void {
  factoryOverride = factory;
}

function defaultFactory(url: string): EventSourceLike {
  return new EventSource(url) as EventSourceLike;
}

const DEFAULT_BUFFER_SIZE = 200;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export function useEventStream<T extends AppEventLike = AppEventLike>(
  options: UseEventStreamOptions<T> = {},
): UseEventStreamResult<T> {
  const {
    runId,
    bufferSize = DEFAULT_BUFFER_SIZE,
    onEvent,
    enabled = true,
  } = options;

  const [events, setEvents] = useState<T[]>([]);
  const [status, setStatus] = useState<StreamStatus>("idle");
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      return;
    }

    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let source: EventSourceLike | null = null;

    const cleanup = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      source?.close();
      source = null;
    };

    const connect = () => {
      if (cancelled) return;
      const factory = factoryOverride ?? defaultFactory;
      const url = eventStreamUrl(runId);
      const es = factory(url);
      source = es;
      setStatus(attempt === 0 ? "connecting" : "reconnecting");

      es.onopen = () => {
        if (cancelled) return;
        attempt = 0;
        setStatus("open");
      };

      es.onmessage = (event) => {
        if (cancelled) return;
        let parsed: T;
        try {
          parsed = JSON.parse(event.data) as T;
        } catch {
          return;
        }
        setEvents((prev) => {
          const next = [...prev, parsed];
          if (next.length > bufferSize) {
            return next.slice(next.length - bufferSize);
          }
          return next;
        });
        onEventRef.current?.(parsed);
      };

      es.onerror = () => {
        if (cancelled) return;
        es.close();
        source = null;
        attempt += 1;
        const backoff = Math.min(
          INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
          MAX_BACKOFF_MS,
        );
        setStatus("reconnecting");
        retryTimer = setTimeout(connect, backoff);
      };
    };

    connect();

    return () => {
      cancelled = true;
      cleanup();
      setStatus("closed");
    };
  }, [enabled, runId, bufferSize]);

  return { events, status };
}
