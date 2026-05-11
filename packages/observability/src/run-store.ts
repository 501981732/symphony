import * as fs from "node:fs/promises";
import * as path from "node:path";

import { redact } from "./redact.js";

export interface RunStore {
  write(
    projectSlug: string,
    issueIid: number,
    record: Record<string, unknown>,
  ): Promise<void>;
  read(
    projectSlug: string,
    issueIid: number,
  ): Promise<Record<string, unknown> | null>;
}

export function createRunStore(storeDir: string): RunStore {
  function filePath(projectSlug: string, issueIid: number): string {
    return path.join(storeDir, `${projectSlug}-${issueIid}.json`);
  }

  return {
    async write(projectSlug, issueIid, record) {
      const fp = filePath(projectSlug, issueIid);
      await fs.mkdir(path.dirname(fp), { recursive: true });

      const tmpFile = fp + ".tmp";
      await fs.writeFile(
        tmpFile,
        JSON.stringify(redact(record), null, 2),
        "utf-8",
      );
      await fs.rename(tmpFile, fp);
    },

    async read(projectSlug, issueIid) {
      const fp = filePath(projectSlug, issueIid);
      try {
        const content = await fs.readFile(fp, "utf-8");
        return JSON.parse(content) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
  };
}
