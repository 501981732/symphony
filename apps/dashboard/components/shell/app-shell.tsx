import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { TopBar } from "./top-bar";

interface AppShellProps {
  children: ReactNode;
}

/**
 * Top-bar shell.
 *
 * Replaces the v2 left sidebar with a single sticky horizontal nav so
 * the main content gets the full viewport width — the kanban view
 * needs ≥960px to render six columns without x-overflow, and the
 * 232px sidebar previously consumed that budget on 1280–1440px
 * laptops.
 *
 * Per-page modules continue to own their own container width (most
 * cap themselves at 1280–1440px and stick a 12-col grid on top).
 *
 * A skip link is rendered as the first focusable element so keyboard
 * users can jump past the topbar straight into the main region —
 * required by ux rule §1 `skip-links`.
 */
export async function AppShell({ children }: AppShellProps) {
  const t = await getTranslations("nav");
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-fg focus:shadow-2 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {t("skipToMain")}
      </a>
      <TopBar />
      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  );
}
