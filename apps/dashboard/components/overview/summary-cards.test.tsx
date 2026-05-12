// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SummaryCards } from "./summary-cards";

describe("SummaryCards", () => {
  it("renders the spec section 14 dashboard counters", () => {
    render(
      <SummaryCards
        summary={{
          running: 3,
          retrying: 1,
          "human-review": 4,
          failed: 2,
          blocked: 1,
        }}
      />,
    );

    expect(screen.getByText("running").closest("div")).toHaveTextContent("3");
    expect(screen.getByText("retrying").closest("div")).toHaveTextContent("1");
    expect(screen.getByText("human-review").closest("div")).toHaveTextContent(
      "4",
    );
    expect(screen.getByText("failed").closest("div")).toHaveTextContent("2");
    expect(screen.getByText("blocked").closest("div")).toHaveTextContent("1");
    expect(screen.queryByText("claimed")).not.toBeInTheDocument();
    expect(screen.queryByText("completed")).not.toBeInTheDocument();
  });
});
