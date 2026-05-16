import { Fira_Code, Fira_Sans } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { AppShell } from "../components/shell/app-shell";
import { LOCALE_META, resolveLocale } from "../i18n/locales";

import "./globals.css";

const firaSans = Fira_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
  variable: "--font-sans",
});

const firaCode = Fira_Code({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-mono",
});

export async function generateMetadata() {
  const t = await getTranslations("home");
  return {
    title: `IssuePilot · ${t("title")}`,
    description: t("metaDescription"),
  };
}

const themeBootstrap = `(() => {
  try {
    const stored = localStorage.getItem("issuepilot-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = stored === "light" || stored === "dark" ? stored : (prefersDark ? "dark" : "light");
    if (theme === "dark") document.documentElement.classList.add("dark");
    document.documentElement.dataset.theme = theme;
  } catch (_) {}
})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = resolveLocale(await getLocale());
  const messages = await getMessages();
  const meta = LOCALE_META[locale];

  return (
    <html
      lang={meta.htmlLang}
      className={`${firaSans.variable} ${firaCode.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: themeBootstrap }}
          suppressHydrationWarning
        />
      </head>
      <body className="min-h-screen bg-bg font-sans text-fg antialiased">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <AppShell>{children}</AppShell>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
