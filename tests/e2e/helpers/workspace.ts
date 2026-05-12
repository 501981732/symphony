/**
 * Shared E2E workspace setup: bare repo + fake GitLab + workflow file +
 * fake-codex script. Keeps the test files focused on assertions.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createGitLabState,
  seedGitLabState,
  type GitLabFakeState,
  type SeedIssueInput,
} from "../fakes/gitlab/data.js";
import {
  startGitLabFakeServer,
  type GitLabFakeServer,
} from "../fakes/gitlab/server.js";
import { createFakeBareRepo, type FakeBareRepo } from "../fakes/git/repo.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "..", "fixtures");
const TSX_BIN = resolve(HERE, "..", "node_modules", ".bin", "tsx");
const FAKE_CODEX_MAIN = resolve(HERE, "..", "fakes", "codex", "main.ts");

export const E2E_TOKEN = "glpat-fake-e2e-token";

export interface E2EWorkspace {
  tmpRoot: string;
  workspaceRoot: string;
  repoCacheRoot: string;
  workflowPath: string;
  codexScriptPath: string;
  bareRepo: FakeBareRepo;
  gitlabServer: GitLabFakeServer;
  gitlabState: GitLabFakeState;
  projectId: string;
  cleanup: () => Promise<void>;
}

export interface CreateE2EWorkspaceOptions {
  projectId?: string;
  issues?: SeedIssueInput[];
  codexScriptFixture: string;
  workflowTemplate?: string;
}

export async function createE2EWorkspace(
  opts: CreateE2EWorkspaceOptions,
): Promise<E2EWorkspace> {
  const projectId = opts.projectId ?? "demo/repo";
  const tmpRoot = mkdtempSync(join(tmpdir(), "issuepilot-e2e-"));
  const workspaceRoot = join(tmpRoot, "workspaces");
  const repoCacheRoot = join(tmpRoot, "repos");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(repoCacheRoot, { recursive: true });

  const bareRepo = await createFakeBareRepo();
  const gitlabState = createGitLabState({ projectId });
  seedGitLabState(gitlabState, { issues: opts.issues ?? [] });
  const gitlabServer = await startGitLabFakeServer({
    state: gitlabState,
    token: E2E_TOKEN,
  });

  const codexScriptPath = join(tmpRoot, "codex-script.json");
  const fixtureScript = readFileSync(
    join(FIXTURES, opts.codexScriptFixture),
    "utf8",
  );
  writeFileSync(codexScriptPath, fixtureScript);

  const workflowPath = join(tmpRoot, "workflow.fake.md");
  const tplName = opts.workflowTemplate ?? "workflow.fake.md.tpl";
  const tpl = readFileSync(join(FIXTURES, tplName), "utf8");
  // The codex command must run `tsx <fake-main> <script>` as a single command
  // line; we quote each piece so spaces in paths are tolerated.
  const codexCmd = `${quote(TSX_BIN)} ${quote(FAKE_CODEX_MAIN)} ${quote(codexScriptPath)}`;
  const rendered = tpl
    .replaceAll("__GITLAB_URL__", gitlabServer.baseUrl)
    .replaceAll("__PROJECT_ID__", projectId)
    .replaceAll("__WORKSPACE_ROOT__", workspaceRoot)
    .replaceAll("__REPO_CACHE_ROOT__", repoCacheRoot)
    .replaceAll("__REPO_URL__", bareRepo.bareDir)
    .replaceAll("__CODEX_CMD__", codexCmd);
  writeFileSync(workflowPath, rendered);

  return {
    tmpRoot,
    workspaceRoot,
    repoCacheRoot,
    workflowPath,
    codexScriptPath,
    bareRepo,
    gitlabServer,
    gitlabState,
    projectId,
    async cleanup() {
      await gitlabServer.close();
      bareRepo.cleanup();
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

/** Conservative shell quoting that works for the simple paths we generate. */
function quote(value: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
