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
});
