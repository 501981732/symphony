import pino from "pino";

export interface LoggerOptions {
  name: string;
  level?: string | undefined;
  logFile?: string | undefined;
}

export function createLogger(opts: LoggerOptions): pino.Logger {
  const targets: pino.TransportTargetOptions[] = [
    {
      target: "pino/file",
      options: { destination: 1 }, // stdout
      level: opts.level ?? "info",
    },
  ];

  if (opts.logFile) {
    targets.push({
      target: "pino/file",
      options: { destination: opts.logFile, mkdir: true },
      level: opts.level ?? "info",
    });
  }

  return pino({
    name: opts.name,
    level: opts.level ?? "info",
    transport: { targets },
  });
}
