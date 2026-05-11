import os from "node:os";

import { WorkflowConfigError } from "./parse.js";
import type { WorkflowConfig } from "./types.js";

export { WorkflowConfigError } from "./parse.js";

export type EnvLike = Record<string, string | undefined>;

/**
 * Expand a path-shaped string by substituting `~` and the literal token
 * `$HOME` with `os.homedir()`.
 *
 * Behaviour (spec §6 "环境变量中的 secret 只在运行时解析"):
 *
 * - `~` 或 `~/<rest>` 展开为 homedir。`~user/...` 这类用户引用不展开。
 * - 字面量 `$HOME` 仅当后面紧跟边界字符（`/`、`\`、路径分隔符、字符串末尾）
 *   时展开；`$HOMEX` 这类不展开，`${HOME}` 与 `$OTHERVAR` 也不展开。
 * - 其余字符串原样返回，**不会**触发任意 shell expansion。
 */
export function expandHomePath(input: string): string {
  if (typeof input !== "string") {
    throw new WorkflowConfigError(
      `expected path string, got ${typeof input}`,
      "<path>",
    );
  }

  const home = os.homedir();
  let result = input;

  if (result === "~") {
    return home;
  }
  if (result.startsWith("~/") || result.startsWith("~\\")) {
    result = home + result.slice(1);
  }

  result = result.replace(/\$HOME(?=$|[/\\])/g, home);

  return result;
}

/**
 * Return a clone of `cfg` with all home-relative paths expanded. Currently
 * touches `workspace.root` and `workspace.repoCacheRoot`; other path-shaped
 * fields (git/codex command) are deliberately left as-is so they remain
 * transparent for downstream consumers.
 */
export function expandWorkflowPaths(cfg: WorkflowConfig): WorkflowConfig {
  return {
    ...cfg,
    workspace: {
      ...cfg.workspace,
      root: expandHomePath(cfg.workspace.root),
      repoCacheRoot: expandHomePath(cfg.workspace.repoCacheRoot),
    },
  };
}

/**
 * Confirm that the environment variable named by `tracker.tokenEnv` is set
 * to a non-empty value. Throws {@link WorkflowConfigError} with
 * `path = "tracker.token_env"` when the env var is missing or empty so the
 * orchestrator can surface a precise diagnostic.
 *
 * `env` defaults to `process.env`. Callers in tests should pass an explicit
 * shape to keep the global process env clean.
 */
export function validateWorkflowEnv(
  cfg: WorkflowConfig,
  env: EnvLike = process.env,
): void {
  const value = env[cfg.tracker.tokenEnv];
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkflowConfigError(
      "environment variable configured by tracker.token_env is not set",
      "tracker.token_env",
    );
  }
}

export interface TrackerSecret {
  /** Raw token loaded from `env[tracker.tokenEnv]`; never persisted in cfg. */
  token: string;
}

/**
 * Look up the tracker token at runtime without mutating the config. Used by
 * the GitLab adapter when it actually needs to authenticate; every other
 * layer should keep operating on the secret-free {@link WorkflowConfig}.
 */
export function resolveTrackerSecret(
  cfg: WorkflowConfig,
  env: EnvLike = process.env,
): TrackerSecret {
  const value = env[cfg.tracker.tokenEnv];
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkflowConfigError(
      "environment variable configured by tracker.token_env is not set",
      "tracker.token_env",
    );
  }
  return { token: value };
}
