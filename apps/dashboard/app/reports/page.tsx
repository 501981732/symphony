import { ReportsPage } from "../../components/reports/reports-page";
import { listReports } from "../../lib/api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function ReportsRoute() {
  try {
    const { reports } = await listReports();
    return <ReportsPage reports={reports} />;
  } catch (err) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-12">
        <h1 className="text-xl font-semibold text-slate-900">
          IssuePilot reports unavailable
        </h1>
        <p className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {(err as Error).message}
        </p>
      </main>
    );
  }
}
