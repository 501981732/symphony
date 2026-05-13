import { describe, expect, it } from "vitest";

import { createGitLabState, seedGitLabState } from "./data.js";
import type { GitLabFakeState } from "./data.js";

describe("createGitLabState", () => {
  it("starts empty for a given project and exposes maps", () => {
    const state: GitLabFakeState = createGitLabState({ projectId: "g/p" });
    expect(state.projectId).toBe("g/p");
    expect(state.issues.size).toBe(0);
    expect(state.notes.size).toBe(0);
    expect(state.mergeRequests.size).toBe(0);
    expect(state.pipelines.length).toBe(0);
    expect(typeof state.nextId).toBe("function");
  });

  it("nextId is monotonically increasing across resources", () => {
    const state = createGitLabState({ projectId: "g/p" });
    const a = state.nextId();
    const b = state.nextId();
    expect(b).toBe(a + 1);
  });
});

describe("seedGitLabState", () => {
  it("inserts an ai-ready issue with the requested fields", () => {
    const state = createGitLabState({ projectId: "demo/repo" });
    seedGitLabState(state, {
      issues: [
        {
          iid: 42,
          title: "Add changelog entry",
          description: "Please add a changelog entry.",
          labels: ["ai-ready"],
        },
      ],
    });

    const issue = state.issues.get(42);
    expect(issue).toBeDefined();
    expect(issue?.title).toBe("Add changelog entry");
    expect(issue?.labels).toEqual(["ai-ready"]);
    expect(issue?.web_url).toMatch(/\/-\/issues\/42$/);
    expect(state.notes.get(42)).toEqual([]);
  });

  it("supports multiple issues and dedupes IIDs", () => {
    const state = createGitLabState({ projectId: "demo/repo" });
    seedGitLabState(state, {
      issues: [
        { iid: 1, title: "first", labels: ["ai-ready"] },
        { iid: 2, title: "second", labels: ["ai-rework"] },
      ],
    });
    expect(state.issues.size).toBe(2);
    expect(state.issues.get(2)?.labels).toEqual(["ai-rework"]);

    expect(() =>
      seedGitLabState(state, {
        issues: [{ iid: 1, title: "dup", labels: [] }],
      }),
    ).toThrow(/duplicate iid/i);
  });
});
