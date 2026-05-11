import { createInterface } from "node:readline";

import { execa, type ResultPromise } from "execa";

type NotificationHandler = (method: string, params: unknown) => void;
type MalformedHandler = (line: string) => void;
type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;
type RequestId = number | string | null;

export interface RpcClient {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  notify(method: string, params: unknown): void;
  onNotification(handler: NotificationHandler): void;
  onMalformed(handler: MalformedHandler): void;
  onRequest(handler: RequestHandler): void;
  close(): Promise<void>;
  waitExit(): Promise<{ code: number | undefined; signal: string | null }>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export function spawnRpc(opts: {
  command: string;
  args?: string[];
  cwd?: string;
}): RpcClient {
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  let notificationHandler: NotificationHandler = () => {};
  let malformedHandler: MalformedHandler = () => {};
  let requestHandler: RequestHandler = () => {
    throw new Error("No JSON-RPC request handler registered");
  };

  const execOpts = {
    stdin: "pipe" as const,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    buffer: false as const,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  };

  const proc = execa(opts.command, opts.args ?? [], execOpts) as ResultPromise;

  const exitPromise = proc.then(
    (r) => ({ code: r.exitCode as number | undefined, signal: null }),
    (err: { exitCode?: number; signal?: string }) => ({
      code: err.exitCode,
      signal: err.signal ?? null,
    }),
  );

  exitPromise.then(() => {
    for (const [, p] of pending) {
      p.reject(new Error("Process exited with pending requests"));
    }
    pending.clear();
  });

  if (proc.stdout) {
    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line: string) => {
      let msg: { jsonrpc?: string; id?: RequestId; method?: string; result?: unknown; error?: unknown; params?: unknown };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        malformedHandler(line);
        return;
      }

      if (msg.method && msg.id !== undefined) {
        void handleServerRequest(msg.id, msg.method, msg.params);
      } else if (
        typeof msg.id === "number" &&
        pending.has(msg.id)
      ) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(JSON.stringify(msg.error)));
        } else {
          p.resolve(msg.result);
        }
      } else if (msg.method && msg.id == null) {
        notificationHandler(msg.method, msg.params);
      }
    });
  }

  function write(obj: object): void {
    if (proc.stdin && !proc.stdin.destroyed) {
      proc.stdin.write(JSON.stringify(obj) + "\n");
    }
  }

  async function handleServerRequest(
    id: RequestId,
    method: string,
    params: unknown,
  ): Promise<void> {
    try {
      const result = await requestHandler(method, params);
      write({ jsonrpc: "2.0", id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      write({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message },
      });
    }
  }

  return {
    request<T = unknown>(method: string, params: unknown): Promise<T> {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        write({ jsonrpc: "2.0", id, method, params });
      });
    },

    notify(method: string, params: unknown): void {
      write({ jsonrpc: "2.0", method, params });
    },

    onNotification(handler: NotificationHandler): void {
      notificationHandler = handler;
    },

    onMalformed(handler: MalformedHandler): void {
      malformedHandler = handler;
    },

    onRequest(handler: RequestHandler): void {
      requestHandler = handler;
    },

    async close(): Promise<void> {
      try {
        if (proc.stdin && !proc.stdin.destroyed) {
          proc.stdin.end();
        }
        proc.kill();
      } catch {
        // already exited
      }
      await exitPromise;
    },

    waitExit() {
      return exitPromise;
    },
  };
}
