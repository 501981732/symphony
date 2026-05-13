import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventStore } from "../event-store.js";

describe("EventStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evstore-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends events as JSONL", async () => {
    const store = createEventStore(tmpDir);
    await store.append("myproject", 1, {
      id: "e1",
      runId: "r1",
      type: "run_started",
      message: "started",
    });
    await store.append("myproject", 1, {
      id: "e2",
      runId: "r1",
      type: "turn_started",
      message: "turn 1",
    });

    const events = await store.read("myproject", 1);
    expect(events).toHaveLength(2);
    expect(events[0]!.id).toBe("e1");
    expect(events[1]!.id).toBe("e2");
  });

  it("reads with limit and offset", async () => {
    const store = createEventStore(tmpDir);
    for (let i = 0; i < 10; i++) {
      await store.append("proj", 5, {
        id: `e${i}`,
        runId: "r1",
        type: "notification",
        message: `msg ${i}`,
      });
    }

    const page = await store.read("proj", 5, { limit: 3, offset: 2 });
    expect(page).toHaveLength(3);
    expect(page[0]!.id).toBe("e2");
    expect(page[2]!.id).toBe("e4");
  });

  it("returns empty array for nonexistent file", async () => {
    const store = createEventStore(tmpDir);
    const events = await store.read("nonexistent", 999);
    expect(events).toEqual([]);
  });

  it("file path follows <projectSlug>-<issueIid>.jsonl pattern", async () => {
    const store = createEventStore(tmpDir);
    await store.append("myproj", 42, {
      id: "e1",
      runId: "r1",
      type: "test",
      message: "test",
    });
    expect(fs.existsSync(path.join(tmpDir, "myproj-42.jsonl"))).toBe(true);
  });

  it("redacts secrets before persisting events", async () => {
    const store = createEventStore(tmpDir);
    await store.append("proj", 1, {
      id: "e1",
      runId: "r1",
      type: "tool_output",
      message: "Bearer secret-token",
      token: "glpat-12345678901234567890",
    });

    const raw = fs.readFileSync(path.join(tmpDir, "proj-1.jsonl"), "utf-8");
    expect(raw).toContain("[REDACTED]");
    expect(raw).not.toContain("secret-token");
    expect(raw).not.toContain("glpat-12345678901234567890");
  });
});
