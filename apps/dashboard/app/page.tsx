import { Badge } from "../components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          IssuePilot Dashboard
        </h1>
        <p className="text-sm text-slate-500">
          Phase 7 skeleton — Service header, summary cards, runs table and
          live SSE timeline come online in the next tasks.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Phase 7 status</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
          <Badge tone="info">Task 7.1</Badge>
          <span>Tailwind + shadcn-style primitives ready.</span>
        </CardContent>
      </Card>
    </main>
  );
}
