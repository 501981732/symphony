import { describe, expect, it, vi } from "vitest";

import type { GitLabApi, RawIssueNote } from "../api-shape.js";
import { createGitLabClient, type GitLabClient } from "../client.js";
import {
  createIssueNote,
  findWorkpadNote,
  updateIssueNote,
} from "../notes.js";

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

const note = (over: Partial<RawIssueNote>): RawIssueNote => ({
  id: 1,
  body: "",
  author: null,
  system: false,
  ...over,
});

const marker = (runId: string) => `<!-- issuepilot:run=${runId} -->`;

describe("createIssueNote", () => {
  it("delegates to IssueNotes.create and returns the new note id", async () => {
    const create = vi.fn(async () => note({ id: 100, body: "x" }));
    const client = makeClient({
      IssueNotes: { all: vi.fn(), create, edit: vi.fn() },
    });
    const r = await createIssueNote(client, 42, "hello");
    expect(create).toHaveBeenCalledWith("group/project", 42, "hello");
    expect(r).toEqual({ id: 100 });
  });
});

describe("updateIssueNote", () => {
  it("delegates to IssueNotes.edit with the new body", async () => {
    const edit = vi.fn(async () => note({ id: 7, body: "new" }));
    const client = makeClient({
      IssueNotes: { all: vi.fn(), create: vi.fn(), edit },
    });
    await updateIssueNote(client, 42, 7, "new");
    expect(edit).toHaveBeenCalledWith("group/project", 42, 7, { body: "new" });
  });
});

describe("findWorkpadNote", () => {
  it("returns the first non-system note whose first line equals the marker", async () => {
    const m = marker("run-abc");
    const all = vi.fn(async () => [
      note({ id: 1, body: "unrelated comment", system: false }),
      note({ id: 2, body: "label change", system: true }),
      note({ id: 3, body: `${m}\n## Run summary\nhello`, system: false }),
      note({ id: 4, body: `${m}\nlater`, system: false }),
    ]);
    const client = makeClient({
      IssueNotes: { all, create: vi.fn(), edit: vi.fn() },
    });
    const r = await findWorkpadNote(client, 42, m);
    expect(r).toEqual({ id: 3, body: `${m}\n## Run summary\nhello` });
    expect(all).toHaveBeenCalledWith("group/project", 42, { perPage: 100 });
  });

  it("ignores system notes even when their first line matches", async () => {
    const m = marker("run-xyz");
    const all = vi.fn(async () => [
      note({ id: 9, body: `${m}\nsystem`, system: true }),
    ]);
    const client = makeClient({
      IssueNotes: { all, create: vi.fn(), edit: vi.fn() },
    });
    expect(await findWorkpadNote(client, 42, m)).toBeNull();
  });

  it("only matches when the marker is on the first line", async () => {
    const m = marker("run-1");
    const all = vi.fn(async () => [
      note({ id: 1, body: `intro\n${m}` }),
      note({ id: 2, body: `  ${m}  ` }),
    ]);
    const client = makeClient({
      IssueNotes: { all, create: vi.fn(), edit: vi.fn() },
    });
    const r = await findWorkpadNote(client, 42, m);
    expect(r?.id).toBe(2);
  });

  it("returns null when no note matches the marker", async () => {
    const all = vi.fn(async () => [
      note({ id: 1, body: "hi" }),
      note({ id: 2, body: "<!-- issuepilot:run=other -->\nbody" }),
    ]);
    const client = makeClient({
      IssueNotes: { all, create: vi.fn(), edit: vi.fn() },
    });
    expect(
      await findWorkpadNote(client, 42, marker("missing")),
    ).toBeNull();
  });

  it("handles empty / undefined body gracefully", async () => {
    const all = vi.fn(async () => [
      note({ id: 1, body: "" }),
      note({ id: 2, body: undefined as unknown as string }),
    ]);
    const client = makeClient({
      IssueNotes: { all, create: vi.fn(), edit: vi.fn() },
    });
    expect(await findWorkpadNote(client, 42, marker("x"))).toBeNull();
  });
});
