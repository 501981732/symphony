// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { LogTail } from "./log-tail";

describe("LogTail", () => {
  it("renders each log line in order", () => {
    render(<LogTail lines={["one", "two", "three"]} />);
    const pre = screen.getByTestId("log-tail-pre");
    expect(pre.textContent).toBe("one\ntwo\nthree");
  });

  it("falls back to placeholder when empty", () => {
    render(<LogTail lines={[]} />);
    expect(screen.getByText(/no log tail available/i)).toBeInTheDocument();
  });
});
