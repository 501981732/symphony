import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRunStore } from "../run-store.js";

describe("RunStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runstore-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads a run record", async () => {
    const store = createRunStore(tmpDir);
    const record = { runId: "r1", status: "running", attempt: 1 };
    await store.write("proj", 10, record);
    const loaded = await store.read("proj", 10);
    expect(loaded).toMatchObject(record);
  });

  it("overwrites atomically", async () => {
    const store = createRunStore(tmpDir);
    await store.write("proj", 10, { runId: "r1", status: "running" });
    await store.write("proj", 10, { runId: "r1", status: "completed" });
    const loaded = await store.read("proj", 10);
    expect(loaded!.status).toBe("completed");
  });

  it("returns null for nonexistent record", async () => {
    const store = createRunStore(tmpDir);
    const loaded = await store.read("proj", 999);
    expect(loaded).toBeNull();
  });

  it("file path follows <projectSlug>-<issueIid>.json", async () => {
    const store = createRunStore(tmpDir);
    await store.write("myproj", 5, { runId: "r1" });
    expect(fs.existsSync(path.join(tmpDir, "myproj-5.json"))).toBe(true);
  });

  it("no .tmp file remains after write", async () => {
    const store = createRunStore(tmpDir);
    await store.write("proj", 1, { runId: "r1" });
    const files = fs.readdirSync(tmpDir);
    expect(files.every((f) => !f.endsWith(".tmp"))).toBe(true);
  });

  it("redacts secrets before persisting run records", async () => {
    const store = createRunStore(tmpDir);
    await store.write("proj", 1, {
      runId: "r1",
      status: "failed",
      error: "Authorization: Bearer secret-token",
      token: "glpat-12345678901234567890",
    });

    const raw = fs.readFileSync(path.join(tmpDir, "proj-1.json"), "utf-8");
    expect(raw).toContain("[REDACTED]");
    expect(raw).not.toContain("secret-token");
    expect(raw).not.toContain("glpat-12345678901234567890");
  });
});
