import { execa } from "execa";

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB

export class HookFailedError extends Error {
  override name = "HookFailedError" as const;
  constructor(
    hookName: string,
    public readonly exitCode: number | undefined,
    public readonly timedOut: boolean,
  ) {
    super(
      timedOut
        ? `Hook '${hookName}' timed out`
        : `Hook '${hookName}' exited with code ${exitCode}`,
    );
  }
}

export interface RunHookInput {
  cwd: string;
  name: "after_create" | "before_run" | "after_run";
  script: string | undefined;
  env: Record<string, string>;
  timeoutMs?: number;
}

export interface RunHookResult {
  skipped: boolean;
  exitCode?: number | undefined;
  stdout: string;
  stderr: string;
}

function truncate(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s) <= maxBytes) return s;
  const buf = Buffer.from(s);
  return buf.subarray(0, maxBytes).toString("utf-8") + "\n[truncated]";
}

export async function runHook(input: RunHookInput): Promise<RunHookResult> {
  if (!input.script || input.script.trim() === "") {
    return { skipped: true, stdout: "", stderr: "" };
  }

  const timeout = input.timeoutMs ?? 600_000;

  try {
    const result = await execa("bash", ["-lc", input.script], {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      timeout,
    });

    return {
      skipped: false,
      exitCode: result.exitCode,
      stdout: truncate(result.stdout, MAX_OUTPUT_BYTES),
      stderr: truncate(result.stderr, MAX_OUTPUT_BYTES),
    };
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "timedOut" in err &&
      (err as { timedOut: boolean }).timedOut
    ) {
      throw new HookFailedError(input.name, undefined, true);
    }
    if (
      err &&
      typeof err === "object" &&
      "exitCode" in err
    ) {
      throw new HookFailedError(
        input.name,
        (err as { exitCode: number }).exitCode,
        false,
      );
    }
    throw err;
  }
}
