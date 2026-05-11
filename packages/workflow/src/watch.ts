import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { parseWorkflowFile, WorkflowConfigError } from "./parse.js";
import type { WorkflowConfig } from "./types.js";

export { WorkflowConfigError } from "./parse.js";

export interface WatchWorkflowOptions {
  /** Called whenever the file is re-parsed successfully into a *new* config. */
  onReload: (cfg: WorkflowConfig) => void;
  /** Called when re-parsing fails. The previous `current()` value is kept. */
  onError: (err: WorkflowConfigError) => void;
  /** Debounce window for filesystem events. Defaults to 250 ms. */
  debounceMs?: number;
}

export interface WorkflowWatcher {
  /** The last successfully-loaded config (last-known-good). */
  current(): WorkflowConfig;
  /** Stop watching. Idempotent; safe to call multiple times. */
  stop(): Promise<void>;
}

/**
 * Start watching `filePath` for changes and re-parse the workflow on every
 * stable update.
 *
 * Behaviour (spec §6 加载规则):
 *
 * - **Startup parse failure** rejects the returned promise so the caller can
 *   decide to fail-fast.
 * - **Runtime parse failure** does *not* replace the active config; the
 *   previous value remains visible via `current()` and the error is surfaced
 *   through `onError`.
 * - **Duplicate writes** with identical content are deduplicated via the
 *   workflow body's sha256, so editors that "save twice" only trigger one
 *   reload.
 */
export async function watchWorkflow(
  filePath: string,
  options: WatchWorkflowOptions,
): Promise<WorkflowWatcher> {
  const debounceMs = options.debounceMs ?? 250;
  const initial = await parseWorkflowFile(filePath);

  let activeConfig: WorkflowConfig = initial;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Promise<void> | null = null;
  let lastMtimeMs: number | null = null;

  try {
    const s = await stat(filePath);
    lastMtimeMs = s.mtimeMs;
  } catch {
    // File disappeared between parse and stat – ignore; next reload attempt
    // will surface the error through onError.
  }

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const dispatch = async (): Promise<void> => {
    if (stopped) return;
    try {
      const next = await parseWorkflowFile(filePath);
      if (stopped) return;
      if (next.source.sha256 === activeConfig.source.sha256) return;
      activeConfig = next;
      options.onReload(next);
    } catch (cause) {
      if (stopped) return;
      const err =
        cause instanceof WorkflowConfigError
          ? cause
          : new WorkflowConfigError(
              cause instanceof Error ? cause.message : String(cause),
              "<file>",
              { cause },
            );
      options.onError(err);
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      pending = dispatch().finally(() => {
        pending = null;
      });
    }, debounceMs);
  };

  // Watch the *directory* rather than the file itself: many editors save by
  // renaming a temp file over the target, which leaves a stale watcher when
  // we attach to the file path on macOS/Linux.
  const baseName = path.basename(filePath);
  const watcher: FSWatcher = watch(path.dirname(filePath), (_event, name) => {
    if (name === baseName) schedule();
  });

  // Polling fallback: fs.watch occasionally drops events on macOS/Linux
  // under load. A periodic stat()-based mtime check guarantees that a real
  // change is picked up within `pollIntervalMs`, while the sha256 dedup in
  // `dispatch()` keeps spurious wakeups from triggering empty reloads.
  const pollIntervalMs = Math.max(debounceMs * 4, 200);
  const pollTimer: ReturnType<typeof setInterval> = setInterval(() => {
    if (stopped) return;
    stat(filePath).then(
      (s) => {
        if (stopped) return;
        if (lastMtimeMs === null || s.mtimeMs !== lastMtimeMs) {
          lastMtimeMs = s.mtimeMs;
          schedule();
        }
      },
      () => {
        // Missing file – let the next dispatch raise WorkflowConfigError.
        if (!stopped) schedule();
      },
    );
  }, pollIntervalMs);

  return {
    current(): WorkflowConfig {
      return activeConfig;
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearTimer();
      clearInterval(pollTimer);
      watcher.close();
      if (pending !== null) {
        await pending.catch(() => undefined);
      }
    },
  };
}
