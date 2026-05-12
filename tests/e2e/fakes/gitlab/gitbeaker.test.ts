/**
 * Sanity test: drive the fake GitLab server through `@gitbeaker/rest`. Catches
 * wire-protocol mismatches (encoding, headers, status codes) before they
 * surface as ECONNRESET-style failures in the full E2E.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Gitlab } from "@gitbeaker/rest";

import { createGitLabState, seedGitLabState } from "./data.js";
import { startGitLabFakeServer, type GitLabFakeServer } from "./server.js";

const PROJECT_ID = "demo/repo";
const TOKEN = "glpat-test-token";

describe("fake GitLab server vs @gitbeaker/rest", () => {
  let server: GitLabFakeServer;

  beforeEach(async () => {
    const state = createGitLabState({ projectId: PROJECT_ID });
    seedGitLabState(state, {
      issues: [
        { iid: 7, title: "demo", labels: ["ai-ready"] },
        { iid: 8, title: "skipme", labels: ["wontfix"] },
      ],
    });
    server = await startGitLabFakeServer({ state, token: TOKEN });
  });

  afterEach(async () => {
    await server.close();
  });

  it("lists open issues by label", async () => {
    const gl = new Gitlab({ host: server.baseUrl, token: TOKEN });
    const issues = await gl.Issues.all({
      projectId: PROJECT_ID,
      state: "opened",
      labels: "ai-ready",
      perPage: 10,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.iid).toBe(7);
  });

  it("updates issue labels", async () => {
    const gl = new Gitlab({ host: server.baseUrl, token: TOKEN });
    const updated = await gl.Issues.edit(PROJECT_ID, 7, {
      labels: "ai-running",
    });
    expect(updated.labels).toContain("ai-running");
  });
});
