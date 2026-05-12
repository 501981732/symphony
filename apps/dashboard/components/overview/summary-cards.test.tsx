// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SummaryCards } from "./summary-cards";

describe("SummaryCards", () => {
  it("renders one card per RunStatus and displays the count", () => {
    render(
      <SummaryCards
        summary={{
          claimed: 0,
          running: 3,
          retrying: 1,
          completed: 7,
          failed: 2,
          blocked: 1,
        }}
      />,
    );

    expect(screen.getByText("running").closest("div")).toHaveTextContent("3");
    expect(screen.getByText("retrying").closest("div")).toHaveTextContent("1");
    expect(screen.getByText("completed").closest("div")).toHaveTextContent("7");
    expect(screen.getByText("failed").closest("div")).toHaveTextContent("2");
    expect(screen.getByText("blocked").closest("div")).toHaveTextContent("1");
  });
});
