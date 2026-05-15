import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A single attempt at running an issue end-to-end. Leases form the V2 team
 * runtime contention primitive: claiming the right to run an issue requires
 * acquiring an active lease, releasing happens at run completion, and stale
 * leases (heartbeat past `expiresAt`) are reclaimed on the next acquire.
 */
export interface RunLease {
  leaseId: string;
  projectId: string;
  issueId: string;
  runId: string;
  branchName: string;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
  owner: string;
  status: "active" | "released" | "expired";
}

export interface AcquireLeaseInput {
  projectId: string;
  issueId: string;
  runId: string;
  branchName: string;
  ttlMs: number;
  maxConcurrentRuns: number;
  maxConcurrentRunsPerProject: number;
}

export interface LeaseStore {
  acquire(input: AcquireLeaseInput): Promise<RunLease | null>;
  release(leaseId: string): Promise<void>;
  heartbeat(leaseId: string, ttlMs: number): Promise<RunLease | null>;
  expireStale(): Promise<RunLease[]>;
  active(): Promise<RunLease[]>;
  /**
   * Cached count of leases in `active` state from the most recent file read.
   * Provided as a synchronous accessor so callers like the server snapshot
   * getter can include it in `/api/state` without re-entering the IO queue.
   * Returns `0` before the first IO operation has completed.
   */
  activeCount(): number;
}

interface CreateLeaseStoreOptions {
  filePath: string;
  owner?: string;
  now?: () => Date;
}

interface LeaseFile {
  leases: RunLease[];
}

function defaultOwner(): string {
  return `${os.hostname()}:${process.pid}`;
}

async function readLeaseFile(filePath: string): Promise<LeaseFile> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (raw.trim().length === 0) return { leases: [] };
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "leases" in parsed &&
      Array.isArray((parsed as { leases: unknown }).leases)
    ) {
      return parsed as LeaseFile;
    }
    return { leases: [] };
  } catch (err) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { leases: [] };
    }
    throw err;
  }
}

async function writeLeaseFile(filePath: string, file: LeaseFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // crypto.randomUUID() avoids tmp-name collisions when two writes land in the
  // same millisecond inside the same pid (e.g. two scheduler passes finishing
  // back-to-back under a shared mutex still serialise tmp creation per write).
  const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(tmpPath, JSON.stringify(file, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
}

function isExpired(lease: RunLease, now: Date): boolean {
  return Date.parse(lease.expiresAt) <= now.getTime();
}

function activeLeases(file: LeaseFile, now: Date): RunLease[] {
  return file.leases.filter(
    (lease) => lease.status === "active" && !isExpired(lease, now),
  );
}

export function createLeaseStore(
  options: CreateLeaseStoreOptions,
): LeaseStore {
  const owner = options.owner ?? defaultOwner();
  const now = options.now ?? (() => new Date());

  // Promise-chain mutex. Every public method appends to `queue` so reads and
  // writes against the JSON file are strictly serialised within this pid. The
  // V2 spec accepts that we do not provide cross-process consistency yet, but
  // intra-process race-free behaviour is required for `Promise.all(...)` style
  // multi-project poll passes (spec §17 #2: "并发 2 没有重复 claim 同一 issue").
  let queue: Promise<unknown> = Promise.resolve();
  function serialise<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  }

  let cachedActiveCount = 0;
  function refreshActiveCount(file: LeaseFile, at: Date): void {
    cachedActiveCount = activeLeases(file, at).length;
  }

  function expireInPlace(file: LeaseFile, currentTime: Date): RunLease[] {
    const expired: RunLease[] = [];
    for (const lease of file.leases) {
      if (lease.status === "active" && isExpired(lease, currentTime)) {
        lease.status = "expired";
        expired.push(lease);
      }
    }
    return expired;
  }

  return {
    activeCount() {
      return cachedActiveCount;
    },

    acquire(input) {
      return serialise(async () => {
        const file = await readLeaseFile(options.filePath);
        const currentTime = now();
        const expired = expireInPlace(file, currentTime);
        const active = activeLeases(file, currentTime);
        cachedActiveCount = active.length;

        // Acquire failure must only rewrite the lease file if expireInPlace
        // actually mutated state. Otherwise repeated unsuccessful acquires
        // would churn the file every poll cycle.
        const denyReason = (() => {
          if (active.length >= input.maxConcurrentRuns) return "global-cap";
          const projectActive = active.filter(
            (lease) => lease.projectId === input.projectId,
          );
          if (projectActive.length >= input.maxConcurrentRunsPerProject) {
            return "project-cap";
          }
          const sameIssue = active.find(
            (lease) =>
              lease.projectId === input.projectId &&
              lease.issueId === input.issueId,
          );
          if (sameIssue) return "issue-conflict";
          return null;
        })();

        if (denyReason !== null) {
          if (expired.length > 0) {
            await writeLeaseFile(options.filePath, file);
          }
          return null;
        }

        const acquiredAt = currentTime.toISOString();
        const expiresAt = new Date(
          currentTime.getTime() + input.ttlMs,
        ).toISOString();
        const lease: RunLease = {
          leaseId: crypto.randomUUID(),
          projectId: input.projectId,
          issueId: input.issueId,
          runId: input.runId,
          branchName: input.branchName,
          acquiredAt,
          expiresAt,
          heartbeatAt: acquiredAt,
          owner,
          status: "active",
        };
        file.leases.push(lease);
        await writeLeaseFile(options.filePath, file);
        refreshActiveCount(file, currentTime);
        return lease;
      });
    },

    release(leaseId) {
      return serialise(async () => {
        const file = await readLeaseFile(options.filePath);
        const lease = file.leases.find((l) => l.leaseId === leaseId);
        if (!lease || lease.status !== "active") return;
        lease.status = "released";
        await writeLeaseFile(options.filePath, file);
        refreshActiveCount(file, now());
      });
    },

    heartbeat(leaseId, ttlMs) {
      return serialise(async () => {
        const file = await readLeaseFile(options.filePath);
        const lease = file.leases.find((l) => l.leaseId === leaseId);
        if (!lease || lease.status !== "active") return null;
        const currentTime = now();
        lease.heartbeatAt = currentTime.toISOString();
        lease.expiresAt = new Date(
          currentTime.getTime() + ttlMs,
        ).toISOString();
        await writeLeaseFile(options.filePath, file);
        refreshActiveCount(file, currentTime);
        return lease;
      });
    },

    expireStale() {
      return serialise(async () => {
        const file = await readLeaseFile(options.filePath);
        const currentTime = now();
        const expired = expireInPlace(file, currentTime);
        if (expired.length > 0) {
          await writeLeaseFile(options.filePath, file);
        }
        refreshActiveCount(file, currentTime);
        return expired;
      });
    },

    active() {
      return serialise(async () => {
        const file = await readLeaseFile(options.filePath);
        const currentTime = now();
        const result = activeLeases(file, currentTime);
        cachedActiveCount = result.length;
        return result;
      });
    },
  };
}
