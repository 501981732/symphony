import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { redact } from "@issuepilot/observability";
import {
  buildRunReportSummary,
  type RunReportArtifact,
  type RunReportSummary,
} from "@issuepilot/shared-contracts";

export interface ReportStore {
  save(report: RunReportArtifact): Promise<void>;
  get(runId: string): Promise<RunReportArtifact | undefined>;
  summary(runId: string): RunReportSummary | undefined;
  allSummaries(): RunReportSummary[];
}

export function createReportStore(opts: { rootDir: string }): ReportStore {
  const reports = new Map<string, RunReportArtifact>();
  const dir = join(opts.rootDir, "reports");

  async function save(report: RunReportArtifact): Promise<void> {
    reports.set(report.runId, report);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${report.runId}.json`),
      `${JSON.stringify(redact(report), null, 2)}\n`,
      "utf8",
    );
  }

  return {
    async save(report) {
      await save(report);
    },
    async get(runId) {
      const current = reports.get(runId);
      if (current) return current;
      try {
        const body = await readFile(join(dir, `${runId}.json`), "utf8");
        const parsed = JSON.parse(body) as RunReportArtifact;
        reports.set(runId, parsed);
        return parsed;
      } catch {
        return undefined;
      }
    },
    summary(runId) {
      const current = reports.get(runId);
      return current ? buildRunReportSummary(current) : undefined;
    },
    allSummaries() {
      return [...reports.values()].map(buildRunReportSummary);
    },
  };
}
