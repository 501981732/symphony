import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLeaseStore, type LeaseStore } from "../leases.js";

let tmpDir: string;

async function createStore(opts: { now?: () => Date } = {}): Promise<LeaseStore> {
  return createLeaseStore({
    filePath: path.join(tmpDir, "leases.json"),
    owner: "test-host",
    ...(opts.now ? { now: opts.now } : {}),
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "leases-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("file backed lease store", () => {
  it("acquires and releases a lease", async () => {
    const store = await createStore();
    const lease = await store.acquire({
      projectId: "platform-web",
      issueId: "1",
      runId: "run-1",
      branchName: "ai/1-fix",
      ttlMs: 60_000,
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerProject: 1,
    });

    expect(lease?.status).toBe("active");
    expect(await store.active()).toHaveLength(1);
    await store.release(lease!.leaseId);
    expect(await store.active()).toHaveLength(0);
  });

  it("refuses a second active lease for the same project + issue", async () => {
    const store = await createStore();
    const first = await store.acquire({
      projectId: "platform-web",
      issueId: "1",
      runId: "run-1",
      branchName: "ai/1-fix",
      ttlMs: 60_000,
      maxConcurrentRuns: 5,
      maxConcurrentRunsPerProject: 5,
    });
    expect(first).not.toBeNull();

    const second = await store.acquire({
      projectId: "platform-web",
      issueId: "1",
      runId: "run-2",
      branchName: "ai/1-fix-2",
      ttlMs: 60_000,
      maxConcurrentRuns: 5,
      maxConcurrentRunsPerProject: 5,
    });
    expect(second).toBeNull();
  });

  it("refuses leases past the global or per-project concurrency cap", async () => {
    const store = await createStore();
    const a = await store.acquire({
      projectId: "platform-web",
      issueId: "1",
      runId: "run-1",
      branchName: "ai/1",
      ttlMs: 60_000,
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerProject: 1,
    });
    expect(a).not.toBeNull();

    const sameProject = await store.acquire({
      projectId: "platform-web",
      issueId: "2",
      runId: "run-2",
      branchName: "ai/2",
      ttlMs: 60_000,
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerProject: 1,
    });
    expect(sameProject).toBeNull();

    const otherProject = await store.acquire({
      projectId: "infra-tools",
      issueId: "10",
      runId: "run-3",
      branchName: "ai/10",
      ttlMs: 60_000,
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerProject: 1,
    });
    expect(otherProject).not.toBeNull();

    const overGlobal = await store.acquire({
      projectId: "infra-tools",
      issueId: "11",
      runId: "run-4",
      branchName: "ai/11",
      ttlMs: 60_000,
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerProject: 5,
    });
    expect(overGlobal).toBeNull();
  });

  it("expireStale flips expired leases out of active()", async () => {
    let now = new Date("2026-05-15T00:00:00.000Z");
    const store = await createStore({ now: () => now });

    const lease = await store.acquire({
      projectId: "platform-web",
      issueId: "1",
      runId: "run-1",
      branchName: "ai/1",
      ttlMs: 60_000,
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerProject: 1,
    });
    expect(lease).not.toBeNull();

    now = new Date("2026-05-15T00:05:00.000Z");
    const expired = await store.expireStale();
    expect(expired.map((l) => l.leaseId)).toEqual([lease!.leaseId]);
    expect(await store.active()).toHaveLength(0);
  });

  it("allows a fresh acquire for the same project + issue after the prior lease expires", async () => {
    let now = new Date("2026-05-15T00:00:00.000Z");
    const store = await createStore({ now: () => now });

    const first = await store.acquire({
      projectId: "platform-web",
      issueId: "1",
      runId: "run-1",
      branchName: "ai/1",
      ttlMs: 60_000,
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerProject: 1,
    });
    expect(first).not.toBeNull();

    now = new Date("2026-05-15T00:05:00.000Z");
    const second = await store.acquire({
      projectId: "platform-web",
      issueId: "1",
      runId: "run-2",
      branchName: "ai/1-retry",
      ttlMs: 60_000,
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerProject: 1,
    });
    expect(second).not.toBeNull();
    expect(second!.leaseId).not.toBe(first!.leaseId);
    expect(await store.active()).toHaveLength(1);
  });

  it("serialises concurrent acquires to enforce the global cap", async () => {
    const store = await createStore();

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.acquire({
          projectId: `project-${i}`,
          issueId: String(i),
          runId: `run-${i}`,
          branchName: `ai/${i}`,
          ttlMs: 60_000,
          maxConcurrentRuns: 2,
          maxConcurrentRunsPerProject: 1,
        }),
      ),
    );

    const granted = results.filter((lease) => lease !== null);
    expect(granted).toHaveLength(2);
    const active = await store.active();
    expect(active).toHaveLength(2);
    expect(new Set(active.map((l) => l.leaseId))).toEqual(
      new Set(granted.map((l) => l!.leaseId)),
    );
  });

  it("rejects non-positive ttlMs on acquire and heartbeat", async () => {
    const store = await createStore();
    await expect(
      store.acquire({
        projectId: "platform-web",
        issueId: "1",
        runId: "run-1",
        branchName: "ai/1",
        ttlMs: 0,
        maxConcurrentRuns: 2,
        maxConcurrentRunsPerProject: 1,
      }),
    ).rejects.toThrow(/ttlMs/);
    await expect(
      store.acquire({
        projectId: "platform-web",
        issueId: "1",
        runId: "run-1",
        branchName: "ai/1",
        ttlMs: -10,
        maxConcurrentRuns: 2,
        maxConcurrentRunsPerProject: 1,
      }),
    ).rejects.toThrow(/ttlMs/);

    const ok = await store.acquire({
      projectId: "platform-web",
      issueId: "1",
      runId: "run-1",
      branchName: "ai/1",
      ttlMs: 60_000,
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerProject: 1,
    });
    await expect(store.heartbeat(ok!.leaseId, 0)).rejects.toThrow(/ttlMs/);
  });

  it("quarantines a corrupt lease file and recovers with an empty store", async () => {
    const filePath = path.join(tmpDir, "leases.json");
    await fs.writeFile(filePath, "{not valid json");
    const store = await createStore();

    const lease = await store.acquire({
      projectId: "platform-web",
      issueId: "1",
      runId: "run-1",
      branchName: "ai/1",
      ttlMs: 60_000,
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerProject: 1,
    });
    expect(lease).not.toBeNull();

    const entries = await fs.readdir(tmpDir);
    expect(
      entries.find((name) => name.startsWith("leases.json.corrupt-")),
    ).toBeDefined();
  });

  it("does not rewrite the lease file when acquire fails without expiring leases", async () => {
    const store = await createStore();

    const first = await store.acquire({
      projectId: "platform-web",
      issueId: "1",
      runId: "run-1",
      branchName: "ai/1",
      ttlMs: 60_000,
      maxConcurrentRuns: 1,
      maxConcurrentRunsPerProject: 1,
    });
    expect(first).not.toBeNull();

    const before = await fs.stat(path.join(tmpDir, "leases.json"));

    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await store.acquire({
      projectId: "infra-tools",
      issueId: "9",
      runId: "run-2",
      branchName: "ai/9",
      ttlMs: 60_000,
      maxConcurrentRuns: 1,
      maxConcurrentRunsPerProject: 1,
    });
    expect(second).toBeNull();

    const after = await fs.stat(path.join(tmpDir, "leases.json"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
