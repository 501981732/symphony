import { describe, expect, it, vi } from "vitest";

import type { GitLabApi, RawIssue } from "./api-shape.js";
import { createGitLabClient, type GitLabClient } from "./client.js";
import { getIssue, listCandidateIssues, toIssueRef } from "./issues.js";

function makeClient(api: Partial<GitLabApi>): GitLabClient<GitLabApi> {
  return createGitLabClient<GitLabApi>({
    baseUrl: "https://gitlab.example.com",
    tokenEnv: "GL_TOKEN",
    projectId: "group/project",
    env: { get: () => "tok" },
    GitlabCtor: function GitlabStub(this: object) {
      Object.assign(this, api);
    } as never,
  });
}

const issue = (over: Partial<RawIssue>): RawIssue => ({
  id: 1,
  iid: 1,
  title: "t",
  web_url: "https://gitlab.example.com/g/p/-/issues/1",
  project_id: 7,
  labels: [],
  ...over,
});

describe("listCandidateIssues", () => {
  it("filters issues that carry any excluded label", async () => {
    const all = vi.fn(async () => [
      issue({ id: 1, iid: 10, labels: ["ai-ready"] }),
      issue({ id: 2, iid: 11, labels: ["ai-ready", "ai-running"] }),
      issue({ id: 3, iid: 12, labels: ["ai-rework"] }),
      issue({ id: 4, iid: 13, labels: ["ai-ready", "ai-failed"] }),
      issue({ id: 5, iid: 14, labels: ["ai-rework", "human-review"] }),
      issue({ id: 6, iid: 15, labels: ["ai-ready"] }),
    ]);
    const client = makeClient({
      Issues: { all, show: vi.fn(), edit: vi.fn() },
    });
    const result = await listCandidateIssues(client, {
      activeLabels: ["ai-ready", "ai-rework"],
      excludeLabels: ["ai-running", "ai-failed", "human-review", "ai-blocked"],
    });
    expect(result.map((i) => i.iid)).toEqual([10, 12, 15]);
  });

  it("maps the first row into an IssueRef projection", async () => {
    const all = vi.fn(async () => [
      issue({
        id: 42,
        iid: 7,
        title: "Add feature X",
        web_url: "https://gitlab.example.com/g/p/-/issues/7",
        project_id: 7,
        labels: ["ai-ready"],
      }),
    ]);
    const client = makeClient({
      Issues: { all, show: vi.fn(), edit: vi.fn() },
    });
    const [ref] = await listCandidateIssues(client, {
      activeLabels: ["ai-ready"],
      excludeLabels: [],
    });
    expect(ref).toEqual({
      id: "gid://gitlab/Issue/42",
      iid: 7,
      title: "Add feature X",
      url: "https://gitlab.example.com/g/p/-/issues/7",
      projectId: "7",
      labels: ["ai-ready"],
    });
  });

  it("forwards projectId/state/labels/perPage/orderBy/sort to Issues.all", async () => {
    const all = vi.fn(async () => []);
    const client = makeClient({
      Issues: { all, show: vi.fn(), edit: vi.fn() },
    });
    await listCandidateIssues(client, {
      activeLabels: ["ai-ready", "ai-rework"],
      excludeLabels: ["ai-running"],
      perPage: 25,
    });
    expect(all).toHaveBeenCalledWith({
      projectId: "group/project",
      state: "opened",
      labels: "ai-ready,ai-rework",
      perPage: 25,
      orderBy: "updated_at",
      sort: "asc",
    });
  });

  it("defaults perPage to 50 when omitted", async () => {
    const all = vi.fn(async () => []);
    const client = makeClient({
      Issues: { all, show: vi.fn(), edit: vi.fn() },
    });
    await listCandidateIssues(client, {
      activeLabels: ["ai-ready"],
      excludeLabels: [],
    });
    expect(all.mock.calls[0]?.[0]?.perPage).toBe(50);
  });

  it("treats issues with missing labels as empty (no exclusion match)", async () => {
    const all = vi.fn(async () => [
      issue({ id: 1, iid: 1, labels: undefined as unknown as readonly string[] }),
    ]);
    const client = makeClient({
      Issues: { all, show: vi.fn(), edit: vi.fn() },
    });
    const result = await listCandidateIssues(client, {
      activeLabels: ["ai-ready"],
      excludeLabels: ["ai-failed"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.labels).toEqual([]);
  });

  it("wraps API errors via the client.request error classifier", async () => {
    const all = vi.fn(async () => {
      throw Object.assign(new Error("nope"), {
        cause: { response: { status: 401 } },
      });
    });
    const client = makeClient({
      Issues: { all, show: vi.fn(), edit: vi.fn() },
    });
    await expect(
      listCandidateIssues(client, {
        activeLabels: ["ai-ready"],
        excludeLabels: [],
      }),
    ).rejects.toMatchObject({ name: "GitLabError", category: "auth" });
  });
});

describe("toIssueRef", () => {
  it("freezes the labels array so consumers cannot mutate adapter state", () => {
    const ref = toIssueRef(issue({ id: 1, iid: 1, labels: ["a", "b"] }));
    expect(Object.isFrozen(ref.labels)).toBe(true);
  });
});

describe("getIssue", () => {
  it("projects the raw issue and inlines the description", async () => {
    const show = vi.fn(async () =>
      issue({
        id: 5,
        iid: 50,
        title: "Add validation",
        web_url: "https://gitlab.example.com/g/p/-/issues/50",
        project_id: 7,
        labels: ["ai-ready"],
        description: "## Context\nplease",
      }),
    );
    const client = makeClient({
      Issues: { all: vi.fn(), show, edit: vi.fn() },
    });
    const r = await getIssue(client, 50);
    expect(show).toHaveBeenCalledWith("group/project", 50);
    expect(r).toEqual({
      id: "gid://gitlab/Issue/5",
      iid: 50,
      title: "Add validation",
      url: "https://gitlab.example.com/g/p/-/issues/50",
      projectId: "7",
      labels: ["ai-ready"],
      description: "## Context\nplease",
    });
  });

  it("defaults description to empty string when null/undefined", async () => {
    const show = vi.fn(async () =>
      issue({ id: 6, iid: 51, description: null }),
    );
    const client = makeClient({
      Issues: { all: vi.fn(), show, edit: vi.fn() },
    });
    expect((await getIssue(client, 51)).description).toBe("");
  });
});
