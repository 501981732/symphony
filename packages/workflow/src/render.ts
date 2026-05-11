import { Liquid } from "liquidjs";

import type { PromptContext } from "./types.js";

export type { PromptContext } from "./types.js";

export interface PromptRenderLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface PromptRenderOptions {
  /** Optional structured logger (typically pino). When supplied, the
   *  renderer reports any template variable that resolves to undefined. */
  logger?: PromptRenderLogger;
}

/**
 * Build a Liquid `fs` adapter whose every read call rejects, neutralising
 * `{% include %}` / `{% render %}` so untrusted workflow files can not pull
 * in files from the host (spec §6 "禁用文件系统加载").
 */
const DISABLED_MESSAGE = "liquidjs filesystem access is disabled by IssuePilot";

const disabledFs = {
  readFileSync: (): string => {
    throw new Error(DISABLED_MESSAGE);
  },
  readFile: (): Promise<string> => Promise.reject(new Error(DISABLED_MESSAGE)),
  existsSync: (): boolean => false,
  exists: (): Promise<boolean> => Promise.resolve(false),
  contains: (): Promise<boolean> => Promise.resolve(false),
  containsSync: (): boolean => false,
  resolve: (): string => "/issuepilot-disabled",
  dirname: (): string => "/issuepilot-disabled",
  sep: "/",
  fallback: (): string | undefined => undefined,
};

const liquidEngine = new Liquid({
  strictVariables: false,
  strictFilters: true,
  cache: false,
  greedy: false,
  jsTruthy: false,
  root: [],
  fs: disabledFs,
});

/**
 * Render a prompt template against a {@link PromptContext}. Behaviour
 * follows spec §6:
 *
 * - missing variables resolve to the empty string (`strictVariables: false`);
 * - unknown filters fail loudly (`strictFilters: true`) so template typos
 *   are caught early;
 * - filesystem-touching tags are blocked.
 *
 * Whenever a top-level dotted reference (`{{ issue.foo }}`,
 * `{{ workspace.path }}`, etc.) resolves to `undefined`, a warning is
 * emitted via `options.logger.warn` with `{ path: "<dotted.path>" }`.
 */
export async function renderPrompt(
  template: string,
  context: PromptContext,
  options: PromptRenderOptions = {},
): Promise<string> {
  const output = await liquidEngine.parseAndRender(template, { ...context });

  if (options.logger) {
    for (const path of detectMissingVariables(template, context)) {
      options.logger.warn("prompt variable not found", { path });
    }
  }

  return output;
}

/**
 * Identify dotted variable references in `template` (e.g.
 * `{{ issue.unknown }}`, `{{ workspace.who_knows | upcase }}`) that do not
 * have a corresponding entry in `context`. Returns a stable, de-duplicated
 * list.
 */
export function detectMissingVariables(
  template: string,
  context: PromptContext,
): string[] {
  const missing = new Set<string>();
  for (const path of extractVariablePaths(template)) {
    if (!hasPath(context, path)) {
      missing.add(path);
    }
  }
  return [...missing];
}

const OUTPUT_TAG_REGEX = /\{\{-?\s*([\s\S]+?)\s*-?\}\}/g;
const VAR_PATH_REGEX = /^[a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)*$/;

function extractVariablePaths(template: string): string[] {
  const paths: string[] = [];
  for (const match of template.matchAll(OUTPUT_TAG_REGEX)) {
    const raw = match[1] ?? "";
    const head = raw.split("|")[0]?.trim() ?? "";
    if (head && VAR_PATH_REGEX.test(head)) {
      paths.push(head);
    }
  }
  return paths;
}

function hasPath(root: unknown, path: string): boolean {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return false;
    if (typeof cur !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) {
      return false;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur !== undefined;
}
