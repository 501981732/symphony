import pino from "pino";

import { redact } from "./redact.js";

export interface LoggerOptions {
  name: string;
  level?: string | undefined;
  logFile?: string | undefined;
  destination?: pino.DestinationStream | undefined;
}

export function createLogger(opts: LoggerOptions): pino.Logger {
  const loggerOptions: pino.LoggerOptions = {
    name: opts.name,
    level: opts.level ?? "info",
    hooks: {
      streamWrite(line) {
        try {
          return `${JSON.stringify(redact(JSON.parse(line)))}\n`;
        } catch {
          return line;
        }
      },
    },
  };

  if (opts.destination) {
    return pino(loggerOptions, opts.destination);
  }

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
    ...loggerOptions,
    transport: { targets },
  });
}
