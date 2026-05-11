import { describe, expect, it, vi } from "vitest";

import type { GitLabApi, RawPipeline } from "./api-shape.js";
import { createGitLabClient, type GitLabClient } from "./client.js";
import { getPipelineStatus } from "./pipelines.js";

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

const pipeline = (status: string): RawPipeline => ({
  id: 1,
  ref: "ai/42-add-x",
  status,
  updated_at: "2026-05-11T00:00:00Z",
});

describe("getPipelineStatus", () => {
  it("queries the most recent pipeline for the ref", async () => {
    const all = vi.fn(async () => [pipeline("success")]);
    const client = makeClient({ Pipelines: { all } });
    await getPipelineStatus(client, "ai/42-add-x");
    expect(all).toHaveBeenCalledWith("group/project", {
      ref: "ai/42-add-x",
      perPage: 1,
      orderBy: "updated_at",
      sort: "desc",
    });
  });

  it("maps canonical statuses straight through", async () => {
    for (const s of [
      "running",
      "success",
      "failed",
      "pending",
      "canceled",
    ] as const) {
      const all = vi.fn(async () => [pipeline(s)]);
      const client = makeClient({ Pipelines: { all } });
      expect(await getPipelineStatus(client, "ai/x")).toBe(s);
    }
  });

  it("collapses created/manual/scheduled/preparing/waiting_for_resource to pending", async () => {
    for (const s of [
      "created",
      "manual",
      "scheduled",
      "preparing",
      "waiting_for_resource",
    ]) {
      const all = vi.fn(async () => [pipeline(s)]);
      const client = makeClient({ Pipelines: { all } });
      expect(await getPipelineStatus(client, "ai/x")).toBe("pending");
    }
  });

  it("treats skipped as canceled (no work happened)", async () => {
    const all = vi.fn(async () => [pipeline("skipped")]);
    const client = makeClient({ Pipelines: { all } });
    expect(await getPipelineStatus(client, "ai/x")).toBe("canceled");
  });

  it("falls back to unknown for empty pipeline list", async () => {
    const all = vi.fn(async () => []);
    const client = makeClient({ Pipelines: { all } });
    expect(await getPipelineStatus(client, "ai/x")).toBe("unknown");
  });

  it("falls back to unknown for unrecognized status strings", async () => {
    const all = vi.fn(async () => [pipeline("something_new")]);
    const client = makeClient({ Pipelines: { all } });
    expect(await getPipelineStatus(client, "ai/x")).toBe("unknown");
  });
});
