import { describe, expect, it, vi } from "vitest";

import type { GitLabApi, RawIssue } from "./api-shape.js";
import { createGitLabClient, type GitLabClient } from "./client.js";
import { transitionLabels } from "./labels.js";

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

const baseIssue = (labels: readonly string[]): RawIssue => ({
  id: 1,
  iid: 42,
  title: "t",
  web_url: "u",
  project_id: 7,
  labels,
});

describe("transitionLabels", () => {
  it("transitions ai-ready → ai-running and returns the verified labels", async () => {
    const show = vi
      .fn()
      .mockResolvedValueOnce(baseIssue(["ai-ready"]))
      .mockResolvedValueOnce(baseIssue(["ai-running"]));
    const edit = vi.fn(async () => baseIssue(["ai-running"]));
    const client = makeClient({ Issues: { all: vi.fn(), show, edit } });

    const r = await transitionLabels(client, 42, {
      add: ["ai-running"],
      remove: ["ai-ready", "ai-rework"],
      requireCurrent: ["ai-ready"],
    });
    expect(r.labels).toEqual(["ai-running"]);
    expect(edit).toHaveBeenCalledWith("group/project", 42, {
      labels: "ai-running",
    });
    expect(show).toHaveBeenNthCalledWith(1, 42, { projectId: "group/project" });
    expect(show).toHaveBeenNthCalledWith(2, 42, { projectId: "group/project" });
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("throws claim_conflict when requireCurrent label is absent on show", async () => {
    const show = vi.fn().mockResolvedValueOnce(baseIssue(["ai-running"]));
    const edit = vi.fn();
    const client = makeClient({ Issues: { all: vi.fn(), show, edit } });

    await expect(
      transitionLabels(client, 42, {
        add: ["ai-running"],
        remove: ["ai-ready"],
        requireCurrent: ["ai-ready"],
      }),
    ).rejects.toMatchObject({
      name: "GitLabError",
      category: "validation",
      status: 409,
      retriable: false,
      message: expect.stringContaining("claim_conflict") as unknown as string,
    });
    expect(edit).not.toHaveBeenCalled();
  });

  it("preserves unrelated labels and only removes the ones listed", async () => {
    const show = vi
      .fn()
      .mockResolvedValueOnce(baseIssue(["ai-ready", "p:high", "frontend"]))
      .mockResolvedValueOnce(baseIssue(["p:high", "frontend", "ai-running"]));
    const edit = vi.fn(async () =>
      baseIssue(["p:high", "frontend", "ai-running"]),
    );
    const client = makeClient({ Issues: { all: vi.fn(), show, edit } });

    const r = await transitionLabels(client, 42, {
      add: ["ai-running"],
      remove: ["ai-ready"],
      requireCurrent: ["ai-ready"],
    });
    expect(r.labels).toEqual(["p:high", "frontend", "ai-running"]);
    expect(edit).toHaveBeenCalledWith("group/project", 42, {
      labels: "p:high,frontend,ai-running",
    });
  });

  it("skips edit when the computed next labels equal the current state", async () => {
    const show = vi
      .fn()
      .mockResolvedValueOnce(baseIssue(["human-review"]))
      .mockResolvedValueOnce(baseIssue(["human-review"]));
    const edit = vi.fn();
    const client = makeClient({ Issues: { all: vi.fn(), show, edit } });

    const r = await transitionLabels(client, 42, {
      add: ["human-review"],
      remove: [],
      requireCurrent: ["human-review"],
    });
    expect(edit).not.toHaveBeenCalled();
    expect(r.labels).toEqual(["human-review"]);
  });

  it("throws claim_conflict when post-edit verification still shows the removed label", async () => {
    const show = vi
      .fn()
      .mockResolvedValueOnce(baseIssue(["ai-ready"]))
      .mockResolvedValueOnce(baseIssue(["ai-ready"]));
    const edit = vi.fn(async () => baseIssue(["ai-ready"]));
    const client = makeClient({ Issues: { all: vi.fn(), show, edit } });

    await expect(
      transitionLabels(client, 42, {
        add: ["ai-running"],
        remove: ["ai-ready"],
        requireCurrent: ["ai-ready"],
      }),
    ).rejects.toMatchObject({
      name: "GitLabError",
      category: "validation",
      status: 409,
      retriable: false,
      message: expect.stringContaining("claim_conflict") as unknown as string,
    });
  });

  it("propagates transient 5xx as retriable via request() classifier", async () => {
    const show = vi.fn(async () => {
      throw Object.assign(new Error("boom"), {
        cause: { response: { status: 503 } },
      });
    });
    const client = makeClient({
      Issues: { all: vi.fn(), show, edit: vi.fn() },
    });

    await expect(
      transitionLabels(client, 42, {
        add: ["ai-running"],
        remove: ["ai-ready"],
        requireCurrent: ["ai-ready"],
      }),
    ).rejects.toMatchObject({
      name: "GitLabError",
      category: "transient",
      retriable: true,
    });
  });

  it("allows transitions with an empty requireCurrent", async () => {
    const show = vi
      .fn()
      .mockResolvedValueOnce(baseIssue(["something"]))
      .mockResolvedValueOnce(baseIssue(["something", "ai-blocked"]));
    const edit = vi.fn(async () => baseIssue(["something", "ai-blocked"]));
    const client = makeClient({ Issues: { all: vi.fn(), show, edit } });

    const r = await transitionLabels(client, 42, {
      add: ["ai-blocked"],
      remove: [],
    });
    expect(r.labels).toEqual(["something", "ai-blocked"]);
  });
});
