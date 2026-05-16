"use client";

import { useTranslations } from "next-intl";

interface LogTailProps {
  lines: string[];
}

export function LogTail({ lines }: LogTailProps) {
  const t = useTranslations("logTail");
  if (lines.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border bg-surface px-4 py-3 text-xs text-fg-subtle">
        {t.rich("empty", {
          code: (chunks) => <code className="font-mono">{chunks}</code>,
        })}
      </p>
    );
  }

  return (
    <pre
      data-testid="log-tail-pre"
      className="max-h-72 overflow-auto rounded-md border border-border bg-[hsl(222_47%_6%)] px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-100 shadow-1"
    >
      {lines.join("\n")}
    </pre>
  );
}
