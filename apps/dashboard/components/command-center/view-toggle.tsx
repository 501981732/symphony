"use client";

import { useTranslations } from "next-intl";

import { cn } from "../../lib/cn";

export type CommandCenterView = "list" | "board";

const ITEMS: { id: CommandCenterView; icon: React.ReactNode }[] = [
  { id: "list", icon: <ListIcon /> },
  { id: "board", icon: <BoardIcon /> },
];

export function ViewToggle({
  value,
  onChange,
}: {
  value: CommandCenterView;
  onChange: (value: CommandCenterView) => void;
}) {
  const t = useTranslations("viewToggle");
  return (
    <div
      role="group"
      aria-label={t("aria")}
      className="inline-flex h-9 items-center gap-0.5 rounded-md border border-border bg-surface p-0.5 shadow-1"
    >
      {ITEMS.map((item) => {
        const active = value === item.id;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(item.id)}
            className={cn(
              "inline-flex h-7 items-center gap-2 rounded-[5px] px-3 text-xs font-medium transition-colors duration-150 ease-swiss-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-primary text-primary-fg shadow-1"
                : "text-fg-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            <span aria-hidden="true">{item.icon}</span>
            {t(item.id)}
          </button>
        );
      })}
    </div>
  );
}

function ListIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 6h14M5 12h14M5 18h14" />
    </svg>
  );
}

function BoardIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="4" width="5" height="16" rx="1.5" />
      <rect x="11" y="4" width="5" height="10" rx="1.5" />
      <rect x="18" y="4" width="2.5" height="13" rx="1.2" />
    </svg>
  );
}
