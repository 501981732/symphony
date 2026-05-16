"use client";

export type CommandCenterView = "list" | "board";

export function ViewToggle({
  value,
  onChange,
}: {
  value: CommandCenterView;
  onChange: (value: CommandCenterView) => void;
}) {
  return (
    <div
      className="inline-flex rounded-md border border-slate-200 bg-white p-0.5"
      role="group"
      aria-label="Command center view toggle"
    >
      {(["list", "board"] as const).map((view) => (
        <button
          key={view}
          type="button"
          className={
            value === view
              ? "rounded px-3 py-1.5 text-sm font-medium text-white bg-slate-900"
              : "rounded px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-900"
          }
          aria-pressed={value === view}
          onClick={() => onChange(view)}
        >
          {view === "list" ? "List" : "Board"}
        </button>
      ))}
    </div>
  );
}
