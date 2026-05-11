import { describe, it, expect, vi } from "vitest";
import { createGitLabTools } from "./gitlab.js";

function fakeAdapter() {
  return {
    getIssue: vi.fn(async () => ({
      id: "gid://gitlab/Issue/1",
      iid: 1,
      title: "Test Issue",
      url: "https://gitlab.example.com/issues/1",
      projectId: "group/project",
      labels: ["ai-running"],
      description: "Fix the thing",
    })),
    transitionLabels: vi.fn(async () => ({
      labels: ["ai-blocked"],
    })),
    createIssueNote: vi.fn(async () => ({ id: 100 })),
    updateIssueNote: vi.fn(async () => {}),
    createMergeRequest: vi.fn(async () => ({
      id: 10,
      iid: 5,
      webUrl: "https://gitlab.example.com/merge_requests/5",
    })),
    updateMergeRequest: vi.fn(async () => {}),
    getMergeRequest: vi.fn(async () => ({
      iid: 5,
      webUrl: "https://gitlab.example.com/merge_requests/5",
      state: "opened",
    })),
    listMergeRequestNotes: vi.fn(async () => [
      { id: 1, body: "LGTM", author: "reviewer" },
    ]),
    getPipelineStatus: vi.fn(async () => "success" as const),
    listCandidateIssues: vi.fn(async () => []),
    findWorkpadNote: vi.fn(async () => null),
  };
}

describe("createGitLabTools", () => {
  const issueRef = {
    id: "gid://gitlab/Issue/1",
    iid: 1,
    title: "Test",
    url: "https://gitlab.example.com/issues/1",
    projectId: "group/project",
    labels: ["ai-running"],
  };

  it("creates 9 tool definitions", () => {
    const adapter = fakeAdapter();
    const tools = createGitLabTools(adapter, issueRef);
    expect(tools).toHaveLength(9);
    const names = tools.map((t) => t.name);
    expect(names).toContain("gitlab_get_issue");
    expect(names).toContain("gitlab_update_issue_labels");
    expect(names).toContain("gitlab_create_issue_note");
    expect(names).toContain("gitlab_update_issue_note");
    expect(names).toContain("gitlab_create_merge_request");
    expect(names).toContain("gitlab_update_merge_request");
    expect(names).toContain("gitlab_get_merge_request");
    expect(names).toContain("gitlab_list_merge_request_notes");
    expect(names).toContain("gitlab_get_pipeline_status");
  });

  it("gitlab_get_issue returns ok: true with data", async () => {
    const adapter = fakeAdapter();
    const tools = createGitLabTools(adapter, issueRef);
    const tool = tools.find((t) => t.name === "gitlab_get_issue")!;
    const result = await tool.handler({});
    expect(result).toMatchObject({ ok: true });
  });

  it("gitlab_create_issue_note calls adapter and returns ok: true", async () => {
    const adapter = fakeAdapter();
    const tools = createGitLabTools(adapter, issueRef);
    const tool = tools.find((t) => t.name === "gitlab_create_issue_note")!;
    const result = await tool.handler({ body: "Hello from agent" });
    expect(result).toMatchObject({ ok: true, data: { id: 100 } });
    expect(adapter.createIssueNote).toHaveBeenCalledWith(1, "Hello from agent");
  });

  it("returns ok: false on adapter error", async () => {
    const adapter = fakeAdapter();
    adapter.getIssue.mockRejectedValueOnce(new Error("network timeout"));
    const tools = createGitLabTools(adapter, issueRef);
    const tool = tools.find((t) => t.name === "gitlab_get_issue")!;
    const result = await tool.handler({});
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: { message: string } }).error.message).toContain(
      "network timeout",
    );
  });

  it("does not leak token in tool definitions or results", () => {
    const adapter = fakeAdapter();
    const tools = createGitLabTools(adapter, issueRef);
    const json = JSON.stringify(tools);
    expect(json).not.toContain("token");
    expect(json).not.toContain("GITLAB_TOKEN");
  });
});
