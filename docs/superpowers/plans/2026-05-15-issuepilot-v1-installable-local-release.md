# IssuePilot V1 Installable Local Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship V1 as an npm-compatible installable local CLI release that exposes `issuepilot` commands outside the source checkout.

**Architecture:** Keep the P0 single-project local runtime model, but turn the orchestrator CLI into the installable product boundary. Package runtime workspace dependencies in a controlled release package, add an installed dashboard command, and verify the result with a local install smoke before any release tag.

**Tech Stack:** Node.js 22, pnpm 10, Turborepo, TypeScript, commander, Next.js, Vitest, shell-based release smoke scripts.

---

## File Structure

- Modify `package.json`: root version, `release:check`, packaging helper scripts.
- Modify `pnpm-lock.yaml`: dependency and script metadata updates from package changes.
- Modify `apps/orchestrator/package.json`: V1 CLI package metadata, files, bin, publish/package settings.
- Modify `apps/orchestrator/src/cli.ts`: `--version` source and `dashboard` command.
- Modify `apps/orchestrator/src/__tests__/cli.test.ts`: version and dashboard command coverage.
- Modify `apps/dashboard/next.config.mjs`: standalone/static output strategy for packaged dashboard.
- Modify `apps/dashboard/package.json`: build/start metadata needed by packaging.
- Create `scripts/release/package-local.ts`: builds a local npm-compatible package artifact.
- Create `scripts/release/install-smoke.ts`: installs artifact in a temp prefix and validates installed commands.
- Create `scripts/release/fixtures/WORKFLOW.md`: minimal valid workflow fixture for install smoke.
- Create or modify `CHANGELOG.md`: add `0.1.0` V1 entry.
- Modify `README.md`, `README.zh-CN.md`, `docs/getting-started.md`, `docs/getting-started.zh-CN.md`: install-first V1 path.
- Modify `docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`: V1 release evidence template.
- Modify `.gitignore` if release artifacts need a local ignored output directory.

## Packaging Decision

V1 should prefer a local tarball workflow first:

```bash
pnpm release:pack
npm install -g ./dist/release/issuepilot-0.1.0.tgz
issuepilot --version
issuepilot doctor
issuepilot validate --workflow /path/to/WORKFLOW.md
issuepilot run --workflow /path/to/WORKFLOW.md
issuepilot dashboard
```

This still uses npm-compatible package mechanics, proves the install-command experience, and avoids needing public/internal registry credentials in V1. A later task can publish the same package to a registry once credentials and naming are settled.

## Task 1: Version and CLI Metadata

**Files:**
- Modify: `package.json`
- Modify: `apps/orchestrator/package.json`
- Modify: `apps/orchestrator/src/cli.ts`
- Test: `apps/orchestrator/src/__tests__/cli.test.ts`

- [ ] **Step 1: Add a failing CLI version test**

Add a test that expects the CLI to read version from package metadata rather than a hardcoded string:

```ts
it("prints the package version", async () => {
  const output: string[] = [];
  const cli = buildCli();
  cli.configureOutput({ writeOut: (text) => output.push(text) });

  await cli.parseAsync(["--version"], { from: "user" });

  expect(output.join("")).toContain("0.1.0");
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/__tests__/cli.test.ts
```

Expected: fails because CLI version is still `0.0.0`.

- [ ] **Step 3: Set V1 version metadata**

Update:

- root `package.json` version to `0.1.0`
- `apps/orchestrator/package.json` version to `0.1.0`

Keep unrelated packages at `0.0.0` unless the packaging implementation proves they must share a published version.

- [ ] **Step 4: Replace hardcoded CLI version**

In `apps/orchestrator/src/cli.ts`, derive the CLI version from package metadata loaded relative to the built file. Keep a testable fallback for unit tests:

```ts
export interface CliDeps {
  version?: string | undefined;
  // existing deps...
}

const program = new Command("issuepilot")
  .description("IssuePilot — AI-driven GitLab issue orchestrator")
  .version(deps.version ?? PACKAGE_VERSION);
```

If direct JSON import is simpler under current TS config, use an import assertion only if build/typecheck already supports it. Otherwise add a tiny `src/version.ts` generated or manually updated for V1.

- [ ] **Step 5: Re-run focused test**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/__tests__/cli.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json apps/orchestrator/package.json apps/orchestrator/src/cli.ts apps/orchestrator/src/__tests__/cli.test.ts
git commit -m "feat(cli): expose V1 package version"
```

## Task 2: Installed Dashboard Command

**Files:**
- Modify: `apps/orchestrator/src/cli.ts`
- Test: `apps/orchestrator/src/__tests__/cli.test.ts`
- Modify: `apps/dashboard/next.config.mjs`
- Modify: `apps/dashboard/package.json`

- [ ] **Step 1: Add failing dashboard command tests**

Add tests for:

- `issuepilot dashboard --port 3000 --api-url http://127.0.0.1:4738`
- invalid dashboard port rejection
- command delegates to an injected process runner

Use dependency injection so the test does not start Next.js:

```ts
const spawnDashboard = vi.fn(async () => ({ wait: async () => undefined }));
const cli = buildCli({ spawnDashboard });
await cli.parseAsync(["dashboard", "--port", "3333"], { from: "user" });
expect(spawnDashboard).toHaveBeenCalledWith(
  expect.objectContaining({ port: 3333 }),
);
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/__tests__/cli.test.ts
```

Expected: FAIL because `dashboard` command does not exist.

- [ ] **Step 3: Add dashboard process boundary**

Implement a small orchestrator-side helper that starts the packaged dashboard server:

```ts
export interface DashboardOptions {
  port: number;
  host: string;
  apiUrl: string;
}
```

For source checkout development, it can run `pnpm --filter @issuepilot/dashboard start` only as a fallback. For packaged V1, it must resolve a packaged dashboard server path. Keep the resolution logic isolated in a helper such as `src/dashboard.ts`.

- [ ] **Step 4: Add CLI command**

Add:

```bash
issuepilot dashboard --port 3000 --host 127.0.0.1 --api-url http://127.0.0.1:4738
```

Behavior:

- validates `--port`
- validates `--host` is non-empty
- passes `ISSUEPILOT_API_URL` to dashboard process
- waits for child process exit
- sets `process.exitCode = 1` on startup failure

- [ ] **Step 5: Configure dashboard standalone build**

Update `apps/dashboard/next.config.mjs` to support standalone output if Next.js packaging requires it:

```js
const nextConfig = {
  output: "standalone",
};

export default nextConfig;
```

Keep static assets copy behavior in the packaging task, not in the CLI.

- [ ] **Step 6: Run dashboard and orchestrator checks**

Run:

```bash
pnpm --filter @issuepilot/dashboard build
pnpm --filter @issuepilot/orchestrator test -- src/__tests__/cli.test.ts
pnpm --filter @issuepilot/orchestrator typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/orchestrator/src apps/dashboard/next.config.mjs apps/dashboard/package.json
git commit -m "feat(cli): add installed dashboard command"
```

## Task 3: Local Package Artifact

**Files:**
- Create: `scripts/release/package-local.ts`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `apps/orchestrator/package.json`

- [ ] **Step 1: Add a failing package script test by running the missing script**

Run:

```bash
pnpm release:pack
```

Expected: FAIL because the script does not exist.

- [ ] **Step 2: Add release artifact output to `.gitignore`**

Add:

```gitignore
dist/release/
```

Only ignore generated release artifacts, not source files.

- [ ] **Step 3: Implement `scripts/release/package-local.ts`**

The script should:

1. clean `dist/release`
2. run `pnpm -w turbo run build`
3. assemble a package staging directory
4. copy orchestrator `dist`
5. copy required package runtime `dist` files if using bundled workspace layout
6. copy dashboard standalone output and static assets
7. write package metadata with `bin.issuepilot`
8. run `npm pack` in the staging directory
9. print the tarball path

Start with local tarball support. Do not publish to a registry in this task.

- [ ] **Step 4: Add root scripts**

Add to root `package.json`:

```json
{
  "scripts": {
    "release:pack": "tsx scripts/release/package-local.ts"
  }
}
```

- [ ] **Step 5: Validate tarball creation**

Run:

```bash
pnpm release:pack
tar -tf dist/release/issuepilot-0.1.0.tgz | head -50
```

Expected:

- tarball exists
- package contains `dist/bin.js`
- package contains dashboard runtime assets or server entry
- package contains package metadata with `bin.issuepilot`

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/release/package-local.ts .gitignore apps/orchestrator/package.json
git commit -m "build(release): create local installable package"
```

## Task 4: Installed Package Smoke

**Files:**
- Create: `scripts/release/install-smoke.ts`
- Create: `scripts/release/fixtures/WORKFLOW.md`
- Modify: `package.json`

- [ ] **Step 1: Add a failing smoke script**

Run:

```bash
pnpm release:install-smoke
```

Expected: FAIL because the script does not exist.

- [ ] **Step 2: Create workflow fixture**

Create `scripts/release/fixtures/WORKFLOW.md` with a syntactically valid workflow that does not require real GitLab connectivity for `validate` if using injected or dry-run validation is available. If current `validate` always checks GitLab connectivity, use the fixture only for parser checks and use `doctor` / `--version` for installed smoke.

- [ ] **Step 3: Implement installed smoke**

The smoke should:

1. run `pnpm release:pack`
2. create a temp install prefix
3. run `npm install -g --prefix <tmp> dist/release/issuepilot-0.1.0.tgz`
4. prepend `<tmp>/bin` to PATH
5. run `issuepilot --version`
6. run `issuepilot doctor`
7. run `issuepilot validate --workflow scripts/release/fixtures/WORKFLOW.md` if validation can avoid real GitLab; otherwise document why validate is excluded and add a parse-only CLI path in Task 4
8. run `issuepilot dashboard --help`

- [ ] **Step 4: Add script**

Add:

```json
{
  "scripts": {
    "release:install-smoke": "tsx scripts/release/install-smoke.ts"
  }
}
```

- [ ] **Step 5: Run installed smoke**

Run:

```bash
pnpm release:install-smoke
```

Expected:

- installed `issuepilot --version` prints `0.1.0`
- `issuepilot doctor` runs
- dashboard help is available from installed command

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/release/install-smoke.ts scripts/release/fixtures/WORKFLOW.md
git commit -m "test(release): add installed CLI smoke"
```

## Task 5: Release Check

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `release:check` script**

Add:

```json
{
  "scripts": {
    "release:check": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm release:install-smoke && pnpm test:smoke && git diff --check"
  }
}
```

If runtime proves this too slow or duplicates work, keep the same checks but move the orchestration into `scripts/release/check.ts` for clearer output.

- [ ] **Step 2: Run release check**

Run:

```bash
pnpm release:check
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "build(release): add V1 release check"
```

## Task 6: Changelog and Install Docs

**Files:**
- Create or modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/getting-started.zh-CN.md`
- Modify: `docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`

- [ ] **Step 1: Add `CHANGELOG.md`**

Add an initial `0.1.0` entry:

```md
# Changelog

## 0.1.0 - 2026-05-15

### Added

- Installable local `issuepilot` CLI release path.
- `issuepilot run`, `validate`, `doctor`, and `dashboard` installed commands.
- V1 release gate and installed CLI smoke.

### Known Non-Goals

- Multi-project daemon.
- Dashboard write operations.
- Auto-merge.
```

- [ ] **Step 2: Update README quickstart**

README should show install-first V1 path and keep source-checkout under contributor/development setup.

- [ ] **Step 3: Update Chinese README quickstart**

Keep the English and Chinese docs aligned.

- [ ] **Step 4: Update getting-started docs**

Make the boundary explicit:

- install IssuePilot package
- target repo contains `WORKFLOW.md`
- run `issuepilot run`
- run `issuepilot dashboard`

- [ ] **Step 5: Update smoke runbook evidence**

Add a V1 release evidence template:

```md
## V1 Release Evidence

- IssuePilot version:
- Install command:
- `issuepilot --version`:
- `issuepilot doctor`:
- Workflow path:
- Issue URL:
- MR URL:
- Dashboard run URL:
- Handoff note:
- Closing note:
- Final labels / issue state:
- Known risks:
```

- [ ] **Step 6: Run docs checks**

Run:

```bash
pnpm exec prettier --check CHANGELOG.md README.md README.zh-CN.md docs/getting-started.md docs/getting-started.zh-CN.md docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md
git diff --check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add CHANGELOG.md README.md README.zh-CN.md docs/getting-started.md docs/getting-started.zh-CN.md docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md
git commit -m "docs: add V1 installable release guide"
```

## Task 7: Final Verification and PR Update

**Files:**
- Modify if needed: `.github/pull_request_template.md` only if template blocks accurate V1 reporting.

- [ ] **Step 1: Run full release gate**

Run:

```bash
pnpm release:check
```

Expected: PASS.

- [ ] **Step 2: Run targeted package checks if not covered**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test
pnpm --filter @issuepilot/dashboard build
pnpm release:pack
pnpm release:install-smoke
```

Expected: PASS.

- [ ] **Step 3: Update PR body**

Update PR #14 with:

- V1 installable CLI scope
- package artifact command
- installed smoke result
- remaining V2 non-goals

- [ ] **Step 4: Push**

```bash
git push
```

- [ ] **Step 5: Final status**

Report:

- commit list
- PR URL
- release check result
- any known limitation, especially dashboard packaging if implemented with fallback

