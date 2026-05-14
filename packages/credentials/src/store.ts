import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";

import { z } from "zod";

import {
  assertSecureFileMode,
  credentialsPath,
  ensureCredentialsDir,
  type CredentialsPathOptions,
} from "./paths.js";
import type { StoredCredential } from "./types.js";

const StoredCredentialSchema = z
  .object({
    version: z.literal(1),
    hostname: z.string().min(1),
    clientId: z.string().min(1),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
    tokenType: z.string().min(1),
    scope: z.string().optional(),
    obtainedAt: z.string().min(1),
    expiresAt: z.string().min(1),
  })
  .loose();

const FileSchema = z.array(StoredCredentialSchema);

export interface CredentialsStore {
  read(hostname: string): Promise<StoredCredential | null>;
  write(cred: StoredCredential): Promise<void>;
  delete(hostname: string): Promise<void>;
  list(): Promise<StoredCredential[]>;
}

export function createCredentialsStore(
  opts: CredentialsPathOptions = {},
): CredentialsStore {
  const { dir, file } = credentialsPath(opts);

  async function readAll(): Promise<StoredCredential[]> {
    let raw: string;
    try {
      await assertSecureFileMode(file);
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw err;
    }
    if (raw.trim().length === 0) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Credentials file is not valid JSON: ${message}`);
    }
    const result = FileSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Credentials file schema mismatch (version or shape): ${result.error.message}`,
      );
    }
    return result.data.map<StoredCredential>((entry) => ({
      version: entry.version,
      hostname: entry.hostname,
      clientId: entry.clientId,
      accessToken: entry.accessToken,
      ...(entry.refreshToken ? { refreshToken: entry.refreshToken } : {}),
      tokenType: entry.tokenType,
      ...(entry.scope ? { scope: entry.scope } : {}),
      obtainedAt: entry.obtainedAt,
      expiresAt: entry.expiresAt,
    }));
  }

  async function writeAll(entries: StoredCredential[]): Promise<void> {
    await ensureCredentialsDir(dir);
    const payload = `${JSON.stringify(entries, null, 2)}\n`;
    // Random suffix to avoid collisions if two writers ever overlap.
    const tmpFile = `${file}.tmp-${randomBytes(6).toString("hex")}`;
    await fs.writeFile(tmpFile, payload, { mode: 0o600 });
    if (process.platform !== "win32") {
      await fs.chmod(tmpFile, 0o600);
    }
    await fs.rename(tmpFile, file);
  }

  return {
    async read(hostname) {
      const all = await readAll();
      return all.find((c) => c.hostname === hostname) ?? null;
    },
    async write(cred) {
      const all = await readAll();
      const filtered = all.filter((c) => c.hostname !== cred.hostname);
      filtered.push(cred);
      await writeAll(filtered);
    },
    async delete(hostname) {
      const all = await readAll();
      const filtered = all.filter((c) => c.hostname !== hostname);
      if (filtered.length === all.length) return;
      await writeAll(filtered);
    },
    async list() {
      return readAll();
    },
  };
}
