"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import {
  LOCALES,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE_SECONDS,
  LOCALE_META,
  type Locale,
  resolveLocale,
} from "../../i18n/locales";
import { cn } from "../../lib/cn";

function writeCookie(locale: Locale): void {
  if (typeof document === "undefined") return;
  // Cookie-based locale (instead of route-based) keeps URLs stable so deep
  // links to /runs/<id> work the same in both languages.
  const expires = `Max-Age=${LOCALE_COOKIE_MAX_AGE_SECONDS}`;
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; ${expires}; SameSite=Lax`;
}

export function LocaleToggle() {
  const current = resolveLocale(useLocale());
  const t = useTranslations("locale");
  const [pending, setPending] = useState(false);

  function pick(next: Locale) {
    if (next === current || pending) return;
    writeCookie(next);
    setPending(true);
    // Hard reload is the most reliable way to re-evaluate the server
    // RequestConfig — `router.refresh()` can miss the freshly-set cookie
    // in dev and `useLocale()` is cached until the RSC tree updates.
    // Switching language is infrequent, so a full reload is fine UX-wise.
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  }

  return (
    <div
      role="group"
      aria-label={t("toggle")}
      className={cn(
        "flex h-9 items-center gap-0.5 rounded-md border border-border bg-surface p-0.5 shadow-1",
        pending ? "opacity-75" : undefined,
      )}
    >
      {LOCALES.map((locale) => {
        const meta = LOCALE_META[locale];
        const active = locale === current;
        return (
          <button
            key={locale}
            type="button"
            aria-pressed={active}
            aria-label={meta.longLabel}
            disabled={pending}
            onClick={() => pick(locale)}
            className={cn(
              "inline-flex h-7 flex-1 items-center justify-center rounded-[5px] px-2 text-[11px] font-semibold tracking-tight transition-colors duration-150 ease-swiss-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-primary text-primary-fg shadow-1"
                : "text-fg-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            {meta.shortLabel}
          </button>
        );
      })}
    </div>
  );
}
