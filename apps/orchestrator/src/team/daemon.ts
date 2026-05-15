/**
 * V2 team-mode daemon entrypoint. Phase 1 only exposes a placeholder so the
 * CLI can wire `--config` end-to-end; the real implementation is filled in
 * by the team daemon shell task.
 */
export interface TeamDaemonHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
  wait(): Promise<void>;
}

export interface StartTeamDaemonOptions {
  configPath: string;
  host?: string | undefined;
  port?: number | undefined;
}

export async function startTeamDaemon(
  options: StartTeamDaemonOptions,
): Promise<TeamDaemonHandle> {
  throw new Error(
    `team mode is not implemented yet for config ${options.configPath}`,
  );
}
