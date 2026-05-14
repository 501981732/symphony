import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Default config directory layout. We avoid pulling `XDG_CONFIG_HOME` into
 * the contract for now: spec §17 explicitly names `~/.issuepilot/`, and any
 * relocation must be opt-in to keep the security guarantees obvious.
 */
const DEFAULT_DIR_NAME = ".issuepilot";
const CREDENTIALS_FILE_NAME = "credentials";

export interface CredentialsPathOptions {
  /** Override `os.homedir()` (mostly for tests). */
  homeDir?: string;
  /**
   * Hard override of the credentials directory itself. Wired up in callers
   * via `IPILOT_HOME` so internal users can relocate state for sandboxes
   * without changing $HOME.
   */
  configDirOverride?: string;
}

export interface CredentialsLocation {
  dir: string;
  file: string;
}

export class CredentialsPermissionError extends Error {
  override name = "CredentialsPermissionError";
  constructor(
    message: string,
    public readonly file: string,
    public readonly mode: number,
  ) {
    super(message);
  }
}

export function credentialsPath(
  opts: CredentialsPathOptions = {},
): CredentialsLocation {
  const home = opts.homeDir ?? os.homedir();
  const dir = opts.configDirOverride ?? path.join(home, DEFAULT_DIR_NAME);
  return { dir, file: path.join(dir, CREDENTIALS_FILE_NAME) };
}

/**
 * Make sure the credentials directory exists with `0700` permissions, and
 * normalize an over-permissive existing directory back down. POSIX-only
 * enforcement; Windows is left as a known soft spot (P0 targets macOS/Linux
 * dev workstations per spec §17).
 */
export async function ensureCredentialsDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  // mkdir's `mode` is honored only when creating the dir; an existing dir
  // keeps whatever mode it had. Always force-correct so a manual chmod
  // mistake gets self-healed.
  await fs.chmod(dir, 0o700);
}

export async function assertSecureFileMode(file: string): Promise<void> {
  if (process.platform === "win32") return;
  const stat = await fs.stat(file);
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new CredentialsPermissionError(
      `Credentials file ${file} has insecure mode ${mode.toString(8)}; run: chmod 600 ${file}`,
      file,
      mode,
    );
  }
}
