import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGitLabState, seedGitLabState } from "./data.js";
import { startGitLabFakeServer } from "./server.js";
import type { GitLabFakeServer } from "./server.js";

const PROJECT_ID = "demo/repo";
const TOKEN = "glpat-test-token";

describe("fake GitLab server", () => {
  let server: GitLabFakeServer;

  beforeEach(async () => {
    const state = createGitLabState({ projectId: PROJECT_ID });
    seedGitLabState(state, {
      issues: [
        {
          iid: 7,
          title: "Add changelog entry",
          description: "Please update CHANGELOG.",
          labels: ["ai-ready"],
        },
      ],
    });
    server = await startGitLabFakeServer({ state, token: TOKEN });
  });

  afterEach(async () => {
    await server.close();
  });

  const auth = { authorization: `Bearer ${TOKEN}` };

  it("rejects requests without a token", async () => {
    const res = await fetch(
      `${server.baseUrl}/api/v4/projects/${encodeURIComponent(PROJECT_ID)}/issues`,
    );
    expect(res.status).toBe(401);
  });

  it("lists candidate issues filtered by labels", async () => {
    const url = new URL(
      `${server.baseUrl}/api/v4/projects/${encodeURIComponent(PROJECT_ID)}/issues`,
    );
    url.searchParams.set("state", "opened");
    url.searchParams.set("labels", "ai-ready");
    const res = await fetch(url, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ iid: number; labels: string[] }>;
    expect(body).toHaveLength(1);
    const first = body[0];
    if (!first) throw new Error("expected at least one row");
    expect(first.iid).toBe(7);
    expect(first.labels).toContain("ai-ready");
  });

  it("returns a single issue via show", async () => {
    const res = await fetch(
      `${server.baseUrl}/api/v4/projects/${encodeURIComponent(PROJECT_ID)}/issues/7`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { iid: number; title: string };
    expect(body.iid).toBe(7);
    expect(body.title).toBe("Add changelog entry");
  });

  it("returns 404 for unknown issue", async () => {
    const res = await fetch(
      `${server.baseUrl}/api/v4/projects/${encodeURIComponent(PROJECT_ID)}/issues/999`,
      { headers: auth },
    );
    expect(res.status).toBe(404);
  });

  it("PUT /issues/:iid updates labels and bumps updated_at", async () => {
    const beforeRow = server.state.issues.get(7);
    if (!beforeRow) throw new Error("seeded issue missing");
    const before = beforeRow.updated_at;
    await new Promise((r) => setTimeout(r, 5));
    const res = await fetch(
      `${server.baseUrl}/api/v4/projects/${encodeURIComponent(PROJECT_ID)}/issues/7`,
      {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ labels: "ai-running" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { labels: string[] };
    expect(body.labels).toEqual(["ai-running"]);
    const afterRow = server.state.issues.get(7);
    if (!afterRow) throw new Error("issue gone after PUT");
    expect(afterRow.updated_at > before).toBe(true);
  });

  it("notes lifecycle: create -> list -> edit", async () => {
    const base = `${server.baseUrl}/api/v4/projects/${encodeURIComponent(PROJECT_ID)}/issues/7/notes`;
    const createRes = await fetch(base, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ body: "first note" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: number; body: string };

    const listRes = await fetch(base, { headers: auth });
    const list = (await listRes.json()) as Array<{ id: number; body: string }>;
    expect(list).toHaveLength(1);
    const firstNote = list[0];
    if (!firstNote) throw new Error("expected first note row");
    expect(firstNote.id).toBe(created.id);

    const editRes = await fetch(`${base}/${created.id}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ body: "second note" }),
    });
    expect(editRes.status).toBe(200);
    const edited = (await editRes.json()) as { body: string };
    expect(edited.body).toBe("second note");
  });

  it("merge_requests CRUD: empty -> create -> list -> show -> edit", async () => {
    const base = `${server.baseUrl}/api/v4/projects/${encodeURIComponent(PROJECT_ID)}/merge_requests`;
    const listEmpty = await fetch(`${base}?source_branch=ai/7-foo`, {
      headers: auth,
    });
    expect((await listEmpty.json()) as unknown[]).toEqual([]);

    const createRes = await fetch(base, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        source_branch: "ai/7-foo",
        target_branch: "main",
        title: "[AI] Add changelog entry",
        description: "Issue link",
      }),
    });
    expect(createRes.status).toBe(201);
    const mr = (await createRes.json()) as {
      iid: number;
      title: string;
      state: string;
    };
    expect(mr.title).toBe("[AI] Add changelog entry");
    expect(mr.state).toBe("opened");

    const listRes = await fetch(`${base}?source_branch=ai/7-foo`, {
      headers: auth,
    });
    expect((await listRes.json()) as unknown[]).toHaveLength(1);

    const editRes = await fetch(`${base}/${mr.iid}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "[AI] Updated" }),
    });
    const edited = (await editRes.json()) as { title: string };
    expect(edited.title).toBe("[AI] Updated");
  });

  it("pipelines list returns most recent updated entries", async () => {
    server.state.pipelines.push({
      id: 1,
      project_id: server.state.projectNumericId,
      ref: "ai/7-foo",
      sha: "abc",
      status: "success",
      created_at: "2026-05-12T00:00:00Z",
      updated_at: "2026-05-12T00:01:00Z",
    });
    const res = await fetch(
      `${server.baseUrl}/api/v4/projects/${encodeURIComponent(PROJECT_ID)}/pipelines?ref=ai/7-foo&per_page=1`,
      { headers: auth },
    );
    const body = (await res.json()) as Array<{ status: string }>;
    expect(body).toHaveLength(1);
    const pipeline = body[0];
    if (!pipeline) throw new Error("expected pipeline row");
    expect(pipeline.status).toBe("success");
  });

  it("waitFor resolves once predicate becomes true", async () => {
    const promise = server.waitFor(
      (s) => s.issues.get(7)?.labels.includes("ai-running") ?? false,
      { timeoutMs: 2_000, intervalMs: 5 },
    );
    setTimeout(() => {
      const issue = server.state.issues.get(7);
      if (!issue) throw new Error("issue missing in waitFor mutation");
      issue.labels = ["ai-running"];
    }, 20);
    await expect(promise).resolves.toBe(true);
  });

  it("waitFor rejects on timeout", async () => {
    await expect(
      server.waitFor(() => false, { timeoutMs: 30, intervalMs: 5 }),
    ).rejects.toThrow(/timed out/i);
  });

  it("fault injection only matches the exact path or path-prefixed children", async () => {
    // Fault at `/issues/7` should NOT collide with `/issues/77` or
    // `/issues/77/notes`; it should only intercept `/issues/7` itself,
    // `/issues/7/notes`, etc.
    const issueUrl = `/api/v4/projects/${encodeURIComponent(PROJECT_ID)}/issues/7`;
    server.injectFault({
      pathPrefix: issueUrl,
      method: "GET",
      status: 503,
      body: { message: "fault" },
      consume: 1,
    });

    // `/issues/77` does not exist in seed data — make sure we don't
    // accidentally trip the fault for it. Without the precise matcher this
    // request would have eaten the consume budget.
    const sibling = await fetch(`${server.baseUrl}${issueUrl.replace(/7$/, "77")}`,
      { headers: auth },
    );
    expect(sibling.status).toBe(404);

    // Now the fault should still be armed — the next GET on /issues/7
    // (not its sibling) is the one that gets a 503.
    const intercepted = await fetch(`${server.baseUrl}${issueUrl}`, {
      headers: auth,
    });
    expect(intercepted.status).toBe(503);
  });
});
