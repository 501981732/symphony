"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { cn } from "../../lib/cn";

type Theme = "light" | "dark";
const STORAGE_KEY = "issuepilot-theme";
const THEMES: Theme[] = ["light", "dark"];

function readInitial(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.dataset.theme = theme;
}

function persist(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage disabled — fall through */
  }
}

export function ThemeToggle() {
  const t = useTranslations("theme");
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const initial = readInitial();
    setTheme(initial);
    setMounted(true);
  }, []);

  function pick(next: Theme) {
    if (!mounted || next === theme) return;
    setTheme(next);
    apply(next);
    persist(next);
  }

  return (
    <div
      role="group"
      aria-label={t("toggle")}
      className="flex h-9 items-center gap-0.5 rounded-md border border-border bg-surface p-0.5 shadow-1"
    >
      {THEMES.map((value) => {
        const active = mounted && theme === value;
        const label = value === "dark" ? t("dark") : t("light");
        const Icon = value === "dark" ? MoonIcon : SunIcon;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            aria-label={label}
            onClick={() => pick(value)}
            className={cn(
              "inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2 text-[11px] font-semibold tracking-tight transition-colors duration-150 ease-swiss-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-primary text-primary-fg shadow-1"
                : "text-fg-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            <Icon />
            <span className="hidden lg:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={12}
      height={12}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={12}
      height={12}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    </svg>
  );
}
