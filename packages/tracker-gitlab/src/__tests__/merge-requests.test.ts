import { describe, expect, it, vi } from "vitest";

import type { GitLabApi, RawMergeRequest } from "../api-shape.js";
import { createGitLabClient, type GitLabClient } from "../client.js";
import {
  createMergeRequest,
  getMergeRequest,
  listMergeRequestsBySourceBranch,
  listMergeRequestNotes,
  updateMergeRequest,
} from "../merge-requests.js";

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

const mrRow = (over: Partial<RawMergeRequest> = {}): RawMergeRequest => ({
  id: 1,
  iid: 1,
  web_url: "https://gitlab.example.com/g/p/-/merge_requests/1",
  state: "opened",
  source_branch: "ai/42-add-x",
  target_branch: "main",
  title: "t",
  description: null,
  ...over,
});

describe("createMergeRequest", () => {
  it("returns existing opened MR for the same source branch (idempotent)", async () => {
    const all = vi.fn(async () => [
      mrRow({
        id: 9,
        iid: 5,
        web_url: "https://gitlab.example.com/g/p/-/merge_requests/5",
        state: "opened",
        source_branch: "ai/42-add-x",
      }),
    ]);
    const create = vi.fn();
    const client = makeClient({
      MergeRequests: { all, create, edit: vi.fn(), show: vi.fn() },
    });
    const r = await createMergeRequest(client, {
      sourceBranch: "ai/42-add-x",
      targetBranch: "main",
      title: "feat: x",
      description: "body",
      issueIid: 42,
    });
    expect(r).toEqual({
      id: 9,
      iid: 5,
      webUrl: "https://gitlab.example.com/g/p/-/merge_requests/5",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a new MR when no opened MR exists for the source branch", async () => {
    const all = vi.fn(async () => []);
    const create = vi.fn(async () =>
      mrRow({
        id: 11,
        iid: 6,
        web_url: "https://gitlab.example.com/g/p/-/merge_requests/6",
        state: "opened",
        source_branch: "ai/42-add-x",
        target_branch: "main",
      }),
    );
    const client = makeClient({
      MergeRequests: { all, create, edit: vi.fn(), show: vi.fn() },
    });
    const r = await createMergeRequest(client, {
      sourceBranch: "ai/42-add-x",
      targetBranch: "main",
      title: "feat: x",
      description: "body",
      issueIid: 42,
    });
    expect(all).toHaveBeenCalledWith({
      projectId: "group/project",
      sourceBranch: "ai/42-add-x",
      state: "opened",
      perPage: 5,
    });
    expect(create).toHaveBeenCalledWith(
      "group/project",
      "ai/42-add-x",
      "main",
      "feat: x",
      { description: "body" },
    );
    expect(r.iid).toBe(6);
  });

  it("ignores closed/merged MRs for the same branch and creates fresh", async () => {
    const all = vi.fn(async () => [
      mrRow({ state: "merged", source_branch: "ai/42-add-x" }),
      mrRow({ state: "closed", source_branch: "ai/42-add-x" }),
    ]);
    const create = vi.fn(async () =>
      mrRow({ id: 22, iid: 7, source_branch: "ai/42-add-x" }),
    );
    const client = makeClient({
      MergeRequests: { all, create, edit: vi.fn(), show: vi.fn() },
    });
    const r = await createMergeRequest(client, {
      sourceBranch: "ai/42-add-x",
      targetBranch: "main",
      title: "t",
      description: "d",
      issueIid: 42,
    });
    expect(create).toHaveBeenCalled();
    expect(r.iid).toBe(7);
  });
});

describe("updateMergeRequest", () => {
  it("forwards only the provided fields", async () => {
    const edit = vi.fn(async () => mrRow());
    const client = makeClient({
      MergeRequests: {
        all: vi.fn(),
        create: vi.fn(),
        edit,
        show: vi.fn(),
      },
    });
    await updateMergeRequest(client, 5, { title: "new title" });
    expect(edit).toHaveBeenCalledWith("group/project", 5, {
      title: "new title",
    });
  });

  it("skips the GitLab call entirely when nothing changed", async () => {
    const edit = vi.fn();
    const client = makeClient({
      MergeRequests: {
        all: vi.fn(),
        create: vi.fn(),
        edit,
        show: vi.fn(),
      },
    });
    await updateMergeRequest(client, 5, {});
    expect(edit).not.toHaveBeenCalled();
  });
});

describe("getMergeRequest", () => {
  it("projects state and webUrl from the raw row", async () => {
    const show = vi.fn(async () =>
      mrRow({
        iid: 6,
        web_url: "https://gitlab.example.com/g/p/-/merge_requests/6",
        state: "opened",
      }),
    );
    const client = makeClient({
      MergeRequests: {
        all: vi.fn(),
        create: vi.fn(),
        edit: vi.fn(),
        show,
      },
    });
    expect(await getMergeRequest(client, 6)).toEqual({
      iid: 6,
      webUrl: "https://gitlab.example.com/g/p/-/merge_requests/6",
      state: "opened",
    });
  });
});

describe("listMergeRequestsBySourceBranch", () => {
  it("returns MR summaries for a source branch without filtering state", async () => {
    const all = vi.fn(async () => [
      mrRow({
        iid: 6,
        web_url: "https://gitlab.example.com/g/p/-/merge_requests/6",
        state: "merged",
        source_branch: "ai/42-add-x",
        updated_at: "2026-05-14T01:02:03Z",
      }),
      mrRow({
        iid: 7,
        web_url: "https://gitlab.example.com/g/p/-/merge_requests/7",
        state: "closed",
        source_branch: "ai/42-add-x",
      }),
    ]);
    const client = makeClient({
      MergeRequests: {
        all,
        create: vi.fn(),
        edit: vi.fn(),
        show: vi.fn(),
      },
    });

    expect(
      await listMergeRequestsBySourceBranch(client, "ai/42-add-x"),
    ).toEqual([
      {
        iid: 6,
        webUrl: "https://gitlab.example.com/g/p/-/merge_requests/6",
        state: "merged",
        sourceBranch: "ai/42-add-x",
        updatedAt: "2026-05-14T01:02:03Z",
      },
      {
        iid: 7,
        webUrl: "https://gitlab.example.com/g/p/-/merge_requests/7",
        state: "closed",
        sourceBranch: "ai/42-add-x",
      },
    ]);
    expect(all).toHaveBeenCalledWith({
      projectId: "group/project",
      sourceBranch: "ai/42-add-x",
      perPage: 20,
    });
  });
});

describe("listMergeRequestNotes", () => {
  it("maps the GitLab note rows and falls back to 'unknown' author", async () => {
    const all = vi.fn(async () => [
      {
        id: 1,
        body: "hello",
        author: { username: "alice", name: "Alice" },
        system: false,
      },
      {
        id: 2,
        body: "bot",
        author: { username: null, name: "Bot" },
        system: false,
      },
      { id: 3, body: "anon", author: null, system: false },
    ]);
    const client = makeClient({
      MergeRequestNotes: { all },
    });
    const r = await listMergeRequestNotes(client, 6);
    expect(r).toEqual([
      { id: 1, body: "hello", author: "alice" },
      { id: 2, body: "bot", author: "Bot" },
      { id: 3, body: "anon", author: "unknown" },
    ]);
    expect(all).toHaveBeenCalledWith("group/project", 6, { perPage: 100 });
  });
});
