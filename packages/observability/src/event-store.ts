import * as fs from "node:fs/promises";
import * as path from "node:path";

import { redact } from "./redact.js";

export interface EventRecord {
  id: string;
  runId: string;
  type: string;
  message: string;
  [key: string]: unknown;
}

export interface EventStore {
  append(
    projectSlug: string,
    issueIid: number,
    event: EventRecord,
  ): Promise<void>;
  read(
    projectSlug: string,
    issueIid: number,
    opts?: { limit?: number; offset?: number },
  ): Promise<EventRecord[]>;
}

export function createEventStore(storeDir: string): EventStore {
  function filePath(projectSlug: string, issueIid: number): string {
    return path.join(storeDir, `${projectSlug}-${issueIid}.jsonl`);
  }

  return {
    async append(projectSlug, issueIid, event) {
      const fp = filePath(projectSlug, issueIid);
      await fs.mkdir(path.dirname(fp), { recursive: true });
      await fs.appendFile(fp, JSON.stringify(redact(event)) + "\n", "utf-8");
    },

    async read(projectSlug, issueIid, opts) {
      const fp = filePath(projectSlug, issueIid);
      let content: string;
      try {
        content = await fs.readFile(fp, "utf-8");
      } catch {
        return [];
      }

      const lines = content.trim().split("\n").filter(Boolean);
      let events = lines.map((line) => JSON.parse(line) as EventRecord);

      if (opts?.offset) {
        events = events.slice(opts.offset);
      }
      if (opts?.limit) {
        events = events.slice(0, opts.limit);
      }

      return events;
    },
  };
}
