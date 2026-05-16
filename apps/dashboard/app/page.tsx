import type { OrchestratorStateSnapshot } from "@issuepilot/shared-contracts";

import { CommandCenterPage } from "../components/command-center/command-center-page";
import { getState, listRuns, type RunWithReport } from "../lib/api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function fetchOverview(): Promise<{
  snapshot: OrchestratorStateSnapshot;
  runs: RunWithReport[];
}> {
  const [snapshot, runs] = await Promise.all([
    getState(),
    listRuns({ includeArchived: true }),
  ]);
  return { snapshot, runs };
}

async function refreshAction(): Promise<{
  snapshot: OrchestratorStateSnapshot;
  runs: RunWithReport[];
}> {
  "use server";
  return fetchOverview();
}

export default async function HomePage() {
  try {
    const { snapshot, runs } = await fetchOverview();
    return (
      <CommandCenterPage
        initialSnapshot={snapshot}
        initialRuns={runs}
        refetch={refreshAction}
      />
    );
  } catch (err) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-12">
        <h1 className="text-xl font-semibold text-slate-900">
          IssuePilot orchestrator unreachable
        </h1>
        <p className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {(err as Error).message}
        </p>
        <p className="text-sm text-slate-500">
          Start the orchestrator with{" "}
          <code className="font-mono">
            issuepilot run --workflow /path/to/target-project/WORKFLOW.md
          </code>{" "}
          or team mode with{" "}
          <code className="font-mono">
            issuepilot run --config /path/to/issuepilot.team.yaml
          </code>
          , then reload this page.
        </p>
      </main>
    );
  }
}
