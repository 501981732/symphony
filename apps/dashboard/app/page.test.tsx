// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import enMessages from "../i18n/messages/en.json";
import { renderWithIntl as render } from "../test/intl";

import HomePage from "./page";
import { getState, listRuns } from "../lib/api";

vi.mock("../lib/api", () => ({
  getState: vi.fn(),
  listRuns: vi.fn(),
}));

// Server components reach for the request-scoped intl context that next-intl
// wires up at runtime; in vitest there's no Next.js request to bind against,
// so we stub `next-intl/server` to translate against the English catalog.
// `t.rich` must preserve React children (e.g. <code>...</code>) so element
// selectors in tests still find the embedded nodes, not flattened strings.
vi.mock("next-intl/server", async () => {
  const { Fragment, createElement } = await import("react");
  function lookup(key: string): string {
    const parts = key.split(".");
    let cur: unknown = enMessages;
    for (const part of parts) {
      if (cur && typeof cur === "object" && part in cur) {
        cur = (cur as Record<string, unknown>)[part];
      } else {
        return key;
      }
    }
    return typeof cur === "string" ? cur : key;
  }
  function interpolate(template: string, values?: Record<string, unknown>) {
    if (!values) return template;
    let out = template;
    for (const [name, value] of Object.entries(values)) {
      if (typeof value !== "function") {
        out = out.replace(`{${name}}`, String(value));
      }
    }
    return out;
  }
  function richSplit(template: string, values?: Record<string, unknown>) {
    if (!values) return template;
    // next-intl's rich format wraps inner text in `<name>...</name>` tags
    // and passes the matched chunks to a callback in `values`. We also keep
    // support for the simpler `{name}` value form used in a few catalog
    // entries (e.g. ICU number placeholders).
    const parts: unknown[] = [];
    let cursor = 0;
    const regex = /<(\w+)>([\s\S]*?)<\/\1>|\{(\w+)\}/g;
    let match: RegExpExecArray | null;
    let keyCounter = 0;
    while ((match = regex.exec(template)) !== null) {
      if (match.index > cursor) {
        parts.push(template.slice(cursor, match.index));
      }
      const tagName = match[1];
      const inner = match[2];
      const valueName = match[3];
      if (tagName !== undefined) {
        const handler = values[tagName];
        if (typeof handler === "function") {
          parts.push((handler as (chunks: string) => unknown)(inner ?? ""));
        } else {
          parts.push(inner ?? "");
        }
      } else if (valueName !== undefined && valueName in values) {
        const value = values[valueName];
        parts.push(typeof value === "function" ? (value as () => unknown)() : String(value));
      }
      cursor = match.index + match[0].length;
    }
    if (cursor < template.length) {
      parts.push(template.slice(cursor));
    }
    return createElement(
      Fragment,
      null,
      ...parts.map((p) => {
        if (typeof p === "string") return p;
        keyCounter += 1;
        return createElement(Fragment, { key: keyCounter }, p as React.ReactNode);
      }),
    );
  }
  function makeTranslator(namespace?: string) {
    const t = (key: string, values?: Record<string, unknown>) =>
      interpolate(lookup(namespace ? `${namespace}.${key}` : key), values);
    (t as unknown as { rich: typeof t }).rich = ((
      key: string,
      values?: Record<string, unknown>,
    ) => richSplit(lookup(namespace ? `${namespace}.${key}` : key), values)) as typeof t;
    return t as typeof t & { rich: typeof t };
  }
  return {
    getTranslations: async (namespace?: string) => makeTranslator(namespace),
    getLocale: async () => "en",
    getMessages: async () => enMessages,
  };
});

describe("HomePage", () => {
  beforeEach(() => {
    vi.mocked(getState).mockReset();
    vi.mocked(listRuns).mockReset();
  });

  it("points users at workflow- and team-aware orchestrator startup commands when the API is unreachable", async () => {
    vi.mocked(getState).mockRejectedValue(new Error("fetch failed"));
    vi.mocked(listRuns).mockResolvedValue([]);

    render(await HomePage());

    expect(
      screen.getByText("IssuePilot orchestrator unreachable"),
    ).toBeInTheDocument();
    expect(screen.getByText("fetch failed")).toBeInTheDocument();
    expect(
      screen.getByText(
        "issuepilot run --workflow /path/to/target-project/WORKFLOW.md",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "issuepilot run --config /path/to/issuepilot.team.yaml",
      ),
    ).toBeInTheDocument();
  });

  it("fetches archived runs so the Show archived toggle has something to reveal", async () => {
    // RunsTable's `Show archived` toggle is gated on `runs.some(r =>
    // r.archivedAt)`, and the orchestrator default-hides archived runs.
    // Without `includeArchived: true` the toggle would never render even
    // when archived runs exist server-side. Lock the contract in place.
    vi.mocked(getState).mockResolvedValue({
      service: {
        status: "ready",
        workflowPath: "/tmp/workflow.md",
        gitlabProject: "group/project",
        pollIntervalMs: 5000,
        concurrency: 1,
        lastConfigReloadAt: null,
        lastPollAt: null,
      },
      summary: {
        running: 0,
        retrying: 0,
        "human-review": 0,
        failed: 0,
        blocked: 0,
      },
    });
    vi.mocked(listRuns).mockResolvedValue([]);

    await HomePage();

    expect(vi.mocked(listRuns)).toHaveBeenCalledWith({ includeArchived: true });
  });
});
