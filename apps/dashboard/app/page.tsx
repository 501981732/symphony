import type { OrchestratorStateSnapshot } from "@issuepilot/shared-contracts";
import { getTranslations } from "next-intl/server";

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
    const t = await getTranslations("home");
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-12">
        <h1 className="text-xl font-semibold tracking-tight text-fg">
          {t("errorTitle")}
        </h1>
        <p className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger-fg">
          {(err as Error).message}
        </p>
        <p className="text-sm text-fg-muted">
          {t.rich("errorHint", {
            cmd: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
      </div>
    );
  }
}
