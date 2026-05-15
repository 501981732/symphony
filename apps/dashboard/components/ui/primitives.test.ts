import { describe, expect, it } from "vitest";

import { Badge } from "./badge";
import { Button } from "./button";
import { Card, CardContent, CardHeader, CardTitle } from "./card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

function isRenderable(value: unknown): boolean {
  if (typeof value === "function") return true;
  if (typeof value === "object" && value !== null) {
    return "$$typeof" in (value as Record<string, unknown>);
  }
  return false;
}

describe("ui primitives", () => {
  it("exports Button (forwardRef component)", () => {
    expect(isRenderable(Button)).toBe(true);
  });

  it("exports Card family components", () => {
    for (const part of [Card, CardHeader, CardTitle, CardContent]) {
      expect(isRenderable(part)).toBe(true);
    }
  });

  it("exports Table family components", () => {
    for (const part of [
      Table,
      TableHeader,
      TableBody,
      TableRow,
      TableHead,
      TableCell,
    ]) {
      expect(isRenderable(part)).toBe(true);
    }
  });

  it("exports Badge", () => {
    expect(isRenderable(Badge)).toBe(true);
  });
});
