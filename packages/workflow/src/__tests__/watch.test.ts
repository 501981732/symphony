import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseWorkflowFile, WorkflowConfigError } from "../parse.js";
import type { WorkflowConfig } from "../types.js";
import { watchWorkflow, type WorkflowWatcher } from "../watch.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "..", "..", "tests", "fixtures");

const VALID = readFileSync(path.join(FIXTURES, "workflow.valid.md"), "utf8");
const MINIMAL = readFileSync(
  path.join(FIXTURES, "workflow.minimal.md"),
  "utf8",
);
const MISSING_TRACKER = readFileSync(
  path.join(FIXTURES, "workflow.missing-tracker.md"),
  "utf8",
);

const tmpDirs: string[] = [];
const watchers: WorkflowWatcher[] = [];

afterEach(async () => {
  for (const watcher of watchers.splice(0)) {
    await watcher.stop();
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpFile(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "issuepilot-watch-"));
  tmpDirs.push(dir);
  const filePath = path.join(dir, "workflow.md");
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

async function waitUntil(
  check: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`waitUntil timeout (${timeoutMs}ms)`);
}

describe("watchWorkflow", () => {
  it("启动时加载成功 → current() 返回解析结果", async () => {
    const file = makeTmpFile(VALID);
    const onReload = vi.fn();
    const onError = vi.fn();

    const watcher = await watchWorkflow(file, {
      onReload,
      onError,
      debounceMs: 30,
    });
    watchers.push(watcher);

    expect(watcher.current().tracker.projectId).toBe("group/project");
    expect(onReload).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("启动时解析失败 → watchWorkflow reject", async () => {
    const file = makeTmpFile(MISSING_TRACKER);
    const onReload = vi.fn();
    const onError = vi.fn();

    await expect(
      watchWorkflow(file, { onReload, onError, debounceMs: 30 }),
    ).rejects.toBeInstanceOf(WorkflowConfigError);
  });

  it("修改文件 → 触发 onReload 并切换 current()", async () => {
    const file = makeTmpFile(VALID);
    const onReload = vi.fn<(cfg: WorkflowConfig) => void>();
    const onError = vi.fn();
    const watcher = await watchWorkflow(file, {
      onReload,
      onError,
      debounceMs: 30,
    });
    watchers.push(watcher);

    expect(watcher.current().tracker.projectId).toBe("group/project");

    writeFileSync(file, MINIMAL, "utf8");
    await waitUntil(() => onReload.mock.calls.length > 0);

    expect(onReload).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(watcher.current().tracker.projectId).toBe("minimal/project");
    const last = onReload.mock.calls.at(-1)?.[0] as WorkflowConfig;
    expect(last.tracker.projectId).toBe("minimal/project");
  });

  it("运行期解析失败 → 触发 onError，保留 last-known-good current()", async () => {
    const file = makeTmpFile(VALID);
    const onReload = vi.fn();
    const onError = vi.fn<(err: WorkflowConfigError) => void>();
    const watcher = await watchWorkflow(file, {
      onReload,
      onError,
      debounceMs: 30,
    });
    watchers.push(watcher);

    writeFileSync(file, MISSING_TRACKER, "utf8");
    await waitUntil(() => onError.mock.calls.length > 0);

    expect(onError).toHaveBeenCalled();
    const err = onError.mock.calls.at(-1)?.[0];
    expect(err).toBeInstanceOf(WorkflowConfigError);
    expect(err?.path).toBe("tracker");
    expect(onReload).not.toHaveBeenCalled();
    expect(watcher.current().tracker.projectId).toBe("group/project");
  });

  it("stop() 后不再触发任何回调", async () => {
    const file = makeTmpFile(VALID);
    const onReload = vi.fn();
    const onError = vi.fn();
    const watcher = await watchWorkflow(file, {
      onReload,
      onError,
      debounceMs: 30,
    });

    await watcher.stop();

    writeFileSync(file, MINIMAL, "utf8");
    await sleep(120);

    expect(onReload).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    // stop() is idempotent.
    await watcher.stop();
  });

  it("同一内容写入不会重复触发 onReload（sha256 去重）", async () => {
    const file = makeTmpFile(VALID);
    const onReload = vi.fn();
    const onError = vi.fn();
    const watcher = await watchWorkflow(file, {
      onReload,
      onError,
      debounceMs: 30,
    });
    watchers.push(watcher);

    writeFileSync(file, VALID, "utf8");
    await sleep(120);

    expect(onReload).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("快速连续修改最终只保留最新 workflow", async () => {
    const file = makeTmpFile(VALID);
    const onReload = vi.fn<(cfg: WorkflowConfig) => void>();
    const onError = vi.fn();
    const watcher = await watchWorkflow(file, {
      onReload,
      onError,
      debounceMs: 1,
    });
    watchers.push(watcher);

    const first = MINIMAL.replace("minimal/project", "first/project");
    const second = MINIMAL.replace("minimal/project", "second/project");

    writeFileSync(file, first, "utf8");
    await sleep(5);
    writeFileSync(file, second, "utf8");

    await waitUntil(
      () => watcher.current().tracker.projectId === "second/project",
    );

    expect(onError).not.toHaveBeenCalled();
    expect(watcher.current().tracker.projectId).toBe("second/project");
  });

  it("忽略较晚完成的过期 reload 结果", async () => {
    const file = makeTmpFile(VALID);
    const onReload = vi.fn<(cfg: WorkflowConfig) => void>();
    const onError = vi.fn();
    const startedProjects: string[] = [];

    const watcher = await watchWorkflow(file, {
      onReload,
      onError,
      debounceMs: 1,
      loadWorkflow: async (filePath) => {
        const cfg = await parseWorkflowFile(filePath);
        startedProjects.push(cfg.tracker.projectId);
        if (cfg.tracker.projectId === "first/project") {
          await sleep(80);
        }
        return cfg;
      },
    });
    watchers.push(watcher);

    const first = MINIMAL.replace("minimal/project", "first/project");
    const second = MINIMAL.replace("minimal/project", "second/project");

    writeFileSync(file, first, "utf8");
    await waitUntil(() => startedProjects.includes("first/project"));

    writeFileSync(file, second, "utf8");
    await waitUntil(
      () => watcher.current().tracker.projectId === "second/project",
    );

    await sleep(120);
    expect(onError).not.toHaveBeenCalled();
    expect(watcher.current().tracker.projectId).toBe("second/project");
  });
});
