import { NextIntlClientProvider } from "next-intl";
import { render as rtlRender, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import messages from "../i18n/messages/en.json";
import { DEFAULT_LOCALE, type Locale } from "../i18n/locales";

interface IntlWrapperOptions {
  locale?: Locale;
  catalog?: Record<string, unknown>;
}

export function IntlWrapper({
  children,
  locale = DEFAULT_LOCALE,
  catalog,
}: IntlWrapperOptions & { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale={locale} messages={catalog ?? messages}>
      {children}
    </NextIntlClientProvider>
  );
}

/**
 * Test render helper that wraps the unit under test in a
 * NextIntlClientProvider so any `useTranslations()` hook resolves against
 * the English catalog by default. Keeps `screen.getByText(...)` assertions
 * working without per-test wiring.
 */
export function renderWithIntl(
  ui: ReactElement,
  options: IntlWrapperOptions & Omit<RenderOptions, "wrapper"> = {},
) {
  const { locale, catalog, ...rest } = options;
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <IntlWrapper locale={locale} catalog={catalog}>
        {children}
      </IntlWrapper>
    ),
    ...rest,
  });
}

export { messages as enMessages };
