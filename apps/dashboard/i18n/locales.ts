/**
 * Static locale registry for the dashboard. Adding a new locale is a
 * three-step change:
 *   1. Add it here (slug + label + html lang attribute).
 *   2. Add the corresponding `messages/<slug>.json` catalog.
 *   3. Register it in `i18n/request.ts`.
 *
 * Keeping a single source of truth here means LocaleToggle, the cookie
 * helper, and the request-side config never drift out of sync.
 */

export const LOCALES = ["en", "zh"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_COOKIE = "issuepilot-locale";
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export interface LocaleMeta {
  slug: Locale;
  /** `<html lang>` attribute. */
  htmlLang: string;
  /** Short label rendered in LocaleToggle (e.g. "EN", "中"). */
  shortLabel: string;
  /** Long label rendered as button tooltip / aria-label. */
  longLabel: string;
}

export const LOCALE_META: Record<Locale, LocaleMeta> = {
  en: {
    slug: "en",
    htmlLang: "en",
    shortLabel: "EN",
    longLabel: "English",
  },
  zh: {
    slug: "zh",
    htmlLang: "zh-CN",
    shortLabel: "中",
    longLabel: "简体中文",
  },
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
