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

import { createWorkflowLoader } from "./loader.js";
import type { WorkflowWatcher } from "./watch.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "..", "tests", "fixtures");

const VALID_PATH = path.join(FIXTURES, "workflow.valid.md");
const MINIMAL_PATH = path.join(FIXTURES, "workflow.minimal.md");
const VALID = readFileSync(VALID_PATH, "utf8");
const MINIMAL = readFileSync(MINIMAL_PATH, "utf8");

const tmpDirs: string[] = [];
const watchers: WorkflowWatcher[] = [];

afterEach(async () => {
  for (const w of watchers.splice(0)) await w.stop();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpFile(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "issuepilot-loader-"));
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
  throw new Error("waitUntil timeout");
}

describe("createWorkflowLoader", () => {
  it("loadOnce 解析 fixture 文件", async () => {
    const loader = createWorkflowLoader();
    const cfg = await loader.loadOnce(VALID_PATH);
    expect(cfg.tracker.projectId).toBe("group/project");
    expect(cfg.promptTemplate).toMatch(/You are the AI engineer/);
  });

  it("start → 改文件 → current() 反映更新 → stop", async () => {
    const file = makeTmpFile(VALID);
    const loader = createWorkflowLoader();
    const watcher = await loader.start(file, { debounceMs: 30 });
    watchers.push(watcher);

    expect(watcher.current().tracker.projectId).toBe("group/project");

    writeFileSync(file, MINIMAL, "utf8");
    await waitUntil(
      () => watcher.current().tracker.projectId === "minimal/project",
    );

    expect(watcher.current().tracker.projectId).toBe("minimal/project");

    await watcher.stop();
    // After stop, further changes must not move current() further.
    writeFileSync(file, VALID, "utf8");
    await sleep(120);
    expect(watcher.current().tracker.projectId).toBe("minimal/project");
  });

  it("render 用 loader 默认 logger 输出 warn", async () => {
    const warn = vi.fn();
    const loader = createWorkflowLoader({ logger: { warn } });
    const out = await loader.render(
      "title={{ issue.title }} bogus={{ issue.bogus }}",
      {
        issue: {
          id: "g1",
          iid: 1,
          identifier: "g/p#1",
          title: "Hello",
          description: "d",
          labels: [],
          url: "https://example.com",
          author: "a",
          assignees: [],
        },
        attempt: 1,
        workspace: { path: "/tmp" },
        git: { branch: "ai/1" },
      },
    );
    expect(out).toBe("title=Hello bogus=");
    expect(warn).toHaveBeenCalledWith(
      "prompt variable not found",
      expect.objectContaining({ path: "issue.bogus" }),
    );
  });

  it("render 可以被调用时覆盖 logger", async () => {
    const defaultWarn = vi.fn();
    const overrideWarn = vi.fn();
    const loader = createWorkflowLoader({ logger: { warn: defaultWarn } });
    await loader.render("{{ issue.bogus }}", {
      issue: {
        id: "g1",
        iid: 1,
        identifier: "g/p#1",
        title: "t",
        description: "d",
        labels: [],
        url: "https://example.com",
        author: "a",
        assignees: [],
      },
      attempt: 1,
      workspace: { path: "/tmp" },
      git: { branch: "ai/1" },
    }, { logger: { warn: overrideWarn } });

    expect(overrideWarn).toHaveBeenCalled();
    expect(defaultWarn).not.toHaveBeenCalled();
  });
});
