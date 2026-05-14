import { describe, expect, it, vi } from "vitest";

import type {
  GitLabApi,
  RawIssue,
  RawIssueNote,
  RawMergeRequest,
  RawPipeline,
} from "../api-shape.js";
import { createGitLabAdapter, type GitLabAdapterHandle } from "../adapter.js";

function makeAdapter(api: Partial<GitLabApi>): GitLabAdapterHandle {
  return createGitLabAdapter({
    baseUrl: "https://gitlab.example.com",
    tokenEnv: "GL_TOKEN",
    projectId: "group/project",
    env: { get: () => "tok" },
    GitlabCtor: function GitlabStub(this: object) {
      Object.assign(this, api);
    } as never,
  });
}

const issueRow = (over: Partial<RawIssue> = {}): RawIssue => ({
  id: 1,
  iid: 10,
  title: "t",
  web_url: "https://gitlab.example.com/g/p/-/issues/10",
  project_id: 7,
  labels: ["ai-ready"],
  description: "desc",
  ...over,
});

const mrRow = (over: Partial<RawMergeRequest> = {}): RawMergeRequest => ({
  id: 1,
  iid: 1,
  web_url: "https://gitlab.example.com/g/p/-/merge_requests/1",
  state: "opened",
  source_branch: "ai/10-add-x",
  target_branch: "main",
  title: "t",
  description: null,
  ...over,
});

const noteRow = (over: Partial<RawIssueNote> = {}): RawIssueNote => ({
  id: 1,
  body: "",
  author: null,
  system: false,
  ...over,
});

const pipelineRow = (status: string): RawPipeline => ({
  id: 1,
  ref: "ai/10-add-x",
  status,
  updated_at: "2026-05-11T00:00:00Z",
});

describe("createGitLabAdapter", () => {
  it("exposes the GitLabAdapter surface and the underlying client", () => {
    const adapter = makeAdapter({});
    const methods: Array<keyof typeof adapter> = [
      "listCandidateIssues",
      "getIssue",
      "closeIssue",
      "transitionLabels",
      "createIssueNote",
      "updateIssueNote",
      "findLatestIssuePilotWorkpadNote",
      "findWorkpadNote",
      "createMergeRequest",
      "updateMergeRequest",
      "getMergeRequest",
      "listMergeRequestsBySourceBranch",
      "listMergeRequestNotes",
      "getPipelineStatus",
    ];
    for (const m of methods) {
      expect(typeof adapter[m]).toBe("function");
    }
    expect(adapter.client.projectId).toBe("group/project");
  });

  it("does not expose the bearer token via JSON.stringify", () => {
    const adapter = makeAdapter({});
    const json = JSON.stringify(adapter.client);
    expect(json).not.toContain("tok");
  });

  it("listCandidateIssues delegates to Issues.all and filters excluded", async () => {
    const all = vi.fn(async () => [
      issueRow({ id: 1, iid: 1, labels: ["ai-ready"] }),
      issueRow({ id: 2, iid: 2, labels: ["ai-ready", "ai-running"] }),
    ]);
    const adapter = makeAdapter({
      Issues: { all, show: vi.fn(), edit: vi.fn() },
    });
    const r = await adapter.listCandidateIssues({
      activeLabels: ["ai-ready"],
      excludeLabels: ["ai-running"],
    });
    expect(r.map((i) => i.iid)).toEqual([1]);
  });

  it("getIssue returns the projection including description", async () => {
    const show = vi.fn(async () =>
      issueRow({ id: 1, iid: 10, description: "long body" }),
    );
    const adapter = makeAdapter({
      Issues: { all: vi.fn(), show, edit: vi.fn() },
    });
    const r = await adapter.getIssue(10);
    expect(r.description).toBe("long body");
    expect(r.iid).toBe(10);
  });

  it("transitionLabels routes through Issues.show/edit", async () => {
    const show = vi
      .fn()
      .mockResolvedValueOnce(issueRow({ labels: ["ai-ready"] }))
      .mockResolvedValueOnce(issueRow({ labels: ["ai-running"] }));
    const edit = vi.fn(async () => issueRow({ labels: ["ai-running"] }));
    const adapter = makeAdapter({
      Issues: { all: vi.fn(), show, edit },
    });
    const r = await adapter.transitionLabels(10, {
      add: ["ai-running"],
      remove: ["ai-ready"],
      requireCurrent: ["ai-ready"],
    });
    expect(r.labels).toEqual(["ai-running"]);
  });

  it("issue note trio (create / update / find) delegate to IssueNotes", async () => {
    const all = vi.fn(async () => [
      noteRow({
        id: 99,
        body: "<!-- issuepilot:run=run-x -->\nbody",
      }),
    ]);
    const create = vi.fn(async () => noteRow({ id: 100, body: "new" }));
    const edit = vi.fn(async () => noteRow({ id: 100, body: "updated" }));
    const adapter = makeAdapter({
      IssueNotes: { all, create, edit },
    });
    expect(await adapter.createIssueNote(10, "new")).toEqual({ id: 100 });
    await adapter.updateIssueNote(10, 100, "updated");
    expect(edit).toHaveBeenCalledWith("group/project", 10, 100, {
      body: "updated",
    });
    expect(
      await adapter.findWorkpadNote(10, "<!-- issuepilot:run=run-x -->"),
    ).toEqual({ id: 99, body: "<!-- issuepilot:run=run-x -->\nbody" });
    expect(await adapter.findLatestIssuePilotWorkpadNote(10)).toEqual({
      id: 99,
      body: "<!-- issuepilot:run=run-x -->\nbody",
    });
  });

  it("merge request methods delegate to MergeRequests + MergeRequestNotes", async () => {
    const all = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        mrRow({
          iid: 4,
          state: "merged",
          source_branch: "ai/10-add-x",
          updated_at: "2026-05-14T01:02:03Z",
        }),
      ]);
    const create = vi.fn(async () =>
      mrRow({
        id: 5,
        iid: 3,
        web_url: "https://gitlab.example.com/g/p/-/merge_requests/3",
      }),
    );
    const edit = vi.fn(async () => mrRow());
    const show = vi.fn(async () =>
      mrRow({
        iid: 3,
        web_url: "https://gitlab.example.com/g/p/-/merge_requests/3",
        state: "opened",
      }),
    );
    const notesAll = vi.fn(async () => [
      { id: 1, body: "hi", author: { username: "alice" }, system: false },
    ]);
    const adapter = makeAdapter({
      MergeRequests: { all, create, edit, show },
      MergeRequestNotes: { all: notesAll },
    });
    const created = await adapter.createMergeRequest({
      sourceBranch: "ai/10-add-x",
      targetBranch: "main",
      title: "t",
      description: "d",
      issueIid: 10,
    });
    expect(created.iid).toBe(3);
    await adapter.updateMergeRequest(3, { title: "new" });
    expect(edit).toHaveBeenCalledWith("group/project", 3, { title: "new" });
    expect(await adapter.getMergeRequest(3)).toEqual({
      iid: 3,
      webUrl: "https://gitlab.example.com/g/p/-/merge_requests/3",
      state: "opened",
    });
    expect(
      await adapter.listMergeRequestsBySourceBranch("ai/10-add-x"),
    ).toEqual([
      {
        iid: 4,
        webUrl: "https://gitlab.example.com/g/p/-/merge_requests/1",
        state: "merged",
        sourceBranch: "ai/10-add-x",
        updatedAt: "2026-05-14T01:02:03Z",
      },
    ]);
    const notes = await adapter.listMergeRequestNotes(3);
    expect(notes).toEqual([{ id: 1, body: "hi", author: "alice" }]);
  });

  it("closeIssue delegates to Issues.edit with stateEvent close", async () => {
    const show = vi
      .fn()
      .mockResolvedValueOnce(
        issueRow({ labels: ["human-review"], state: "opened" }),
      )
      .mockResolvedValueOnce(issueRow({ labels: [], state: "closed" }));
    const edit = vi.fn(async () => issueRow({ labels: [], state: "closed" }));
    const adapter = makeAdapter({
      Issues: { all: vi.fn(), show, edit },
    });

    await expect(
      adapter.closeIssue(10, {
        requireCurrent: ["human-review"],
        removeLabels: ["human-review"],
      }),
    ).resolves.toEqual({ labels: [], state: "closed" });
    expect(edit).toHaveBeenCalledWith("group/project", 10, {
      removeLabels: "human-review",
      stateEvent: "close",
    });
  });

  it("getPipelineStatus delegates to Pipelines.all and classifies", async () => {
    const all = vi.fn(async () => [pipelineRow("success")]);
    const adapter = makeAdapter({ Pipelines: { all } });
    expect(await adapter.getPipelineStatus("ai/10-add-x")).toBe("success");
  });
});
