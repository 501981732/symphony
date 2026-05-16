import { notFound } from "next/navigation";

import { RunDetailPage } from "../../../components/detail/run-detail-page";
import { ApiError, getRunDetail } from "../../../lib/api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProps {
  params: { runId: string };
}

export default async function RunDetail({ params }: PageProps) {
  const { runId } = params;
  try {
    const { run, events, logsTail, report } = await getRunDetail(runId);
    return (
      <RunDetailPage
        run={run}
        initialEvents={events}
        logsTail={logsTail}
        {...(report ? { report } : {})}
      />
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound();
    }
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-12">
        <h1 className="text-xl font-semibold text-slate-900">
          Failed to load run {runId}
        </h1>
        <p className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {(err as Error).message}
        </p>
      </main>
    );
  }
}
