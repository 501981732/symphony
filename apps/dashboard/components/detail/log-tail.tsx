interface LogTailProps {
  lines: string[];
}

export function LogTail({ lines }: LogTailProps) {
  if (lines.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-3 text-xs text-slate-500">
        No log tail available — tail{" "}
        <code className="font-mono">~/.issuepilot/state/logs/issuepilot.log</code>{" "}
        on the host for full output.
      </p>
    );
  }

  return (
    <pre
      data-testid="log-tail-pre"
      className="max-h-72 overflow-auto rounded-md border border-slate-200 bg-slate-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-100"
    >
      {lines.join("\n")}
    </pre>
  );
}
