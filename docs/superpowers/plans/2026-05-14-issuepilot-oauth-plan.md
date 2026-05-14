# IssuePilot OAuth Device Flow Implementation Plan

> **For Codex / Claude：** REQUIRED SUB-SKILL：使用 `superpowers:executing-plans` 按 Phase / Task 顺序实施本计划，跨 Task 之间 commit。每个 Task 内严格遵循 TDD：先红、后绿、再 commit。
>
> **配套 Spec：** `docs/superpowers/specs/2026-05-11-issuepilot-design.md`（特别是 §4.3、§6 加载规则、§17、§22 决策 3、§23）。

**Goal：** 让 IssuePilot daemon 与 CLI 不再依赖手工管理的 PAT，提供内置 GitLab OAuth 2.0 Device Authorization Grant 登录流程：

```text
issuepilot auth login   --hostname gitlab.example.com
issuepilot auth status [--hostname <host>]
issuepilot auth logout [--hostname <host>]
```

并保证 daemon 启动时凭据按 spec §22 决策 3 的优先级解析（`tracker.token_env` → `~/.issuepilot/credentials`），access token 在到期前自动 refresh。所有 token 字符串经过 `observability/redact`，事件 / 日志 / dashboard / prompt 永不泄漏。

**Architecture：**

- 新增 `packages/credentials/`（domain：device flow client、credentials store、refresh policy、credential resolver facade）。
- 改造 `packages/tracker-gitlab/`：`resolveGitLabToken` 不再仅读环境变量，而是接收 `CredentialResolver` 抽象，支持 OAuth fallback 与 refresh 钩子。
- `apps/orchestrator/src/cli.ts` 新增 `auth login | status | logout` 子命令，复用 `@issuepilot/credentials`。
- daemon 启动 (`startDaemon`) 在创建 GitLab 客户端前调用 `CredentialResolver` 拿到 token + refresh callback，把 callback 注入 `createGitLabClient`，使后续 401 触发 refresh + retry once。

**Tech Stack：** 复用现有栈（TypeScript / Node 22 / pnpm workspace / Turborepo / Vitest / `zod` / `pino`）。OAuth HTTP 调用使用 Node 内置 `fetch`，**禁止引入 `axios`/`got`** —— 我们已经用 `@gitbeaker/rest`（基于 fetch），保持依赖最小。

---

## 0. 工作约定（所有 Task 通用，与 IssuePilot Implementation Plan §0 一致）

- **TDD**：每 Task 先写失败测试 → 实现 → 测试通过 → commit。
- **Conventional Commit**：scope 与包名一致，例如 `feat(credentials): device flow polling client`。
- **测试文件位置**：`packages/<pkg>/src/__tests__/*.test.ts`（与项目现行约定一致，见 CHANGELOG 2026-05-13 「统一单元测试目录结构」条目）。
- **不放任意 secret 进 fixture**：任何 token 字面量必须以 `glpat-test-`、`gloas-test-` 或 `oauth-test-` 开头，便于 redact 单测 + grep 排查。
- **绝不在 catch 里把 token 拼进 error message**：错误信息只描述行为（"refresh failed"、"device code expired"），不嵌入 access token、refresh token、device code、user code、verification URL。
- **超时**：所有 fetch 调用必须有 30s timeout（用 `AbortController`），device flow 整体最多等 `expires_in`（来自服务端，默认 600s）。
- **依赖检查**：`pnpm exec issuepilot doctor` 不需要扩展（OAuth 不需要外部 binary）。

---

## Phase 概览

| Phase | 里程碑 | 包 / App | 关键产出 |
|-------|--------|----------|----------|
| 1 | Credentials 包脚手架 | `@issuepilot/credentials` | 包初始化、契约类型、空实现，全套构建/测试链路打通 |
| 2 | Device Flow 客户端 | `@issuepilot/credentials` | `requestDeviceCode` + `pollForToken` + `refreshAccessToken`，覆盖 spec §22 决策 3 列出的所有 OAuth 错误状态 |
| 3 | Credentials Store | `@issuepilot/credentials` | `~/.issuepilot/credentials` 读写 + `0600/0700` 权限校验 + 多 hostname 支持 |
| 4 | Credential Resolver | `@issuepilot/credentials` | `resolveCredential({ trackerTokenEnv, hostname })`：env 优先、credentials 文件 fallback、自动 refresh + 写回 |
| 5 | Tracker-GitLab 集成 | `@issuepilot/tracker-gitlab` | `createGitLabClient` 接受 `CredentialResolver`；`request()` 在 401 时 refresh + retry once |
| 6 | CLI 子命令 | `apps/orchestrator` | `issuepilot auth login | status | logout`，daemon 启动时同样走 resolver |
| 7 | E2E + smoke 同步 | `tests/e2e` + docs | fake OAuth server + 全闭环测试 + 更新 smoke runbook 与 CHANGELOG |

---

## Phase 1：Credentials 包脚手架

**目标：** 在 `packages/credentials/` 建立与现有 7 个 package 同构的 TypeScript 包，把契约类型先定下来。

### Task 1.1：包初始化

**Files：**
- Create: `packages/credentials/package.json`、`tsconfig.json`、`vitest.config.ts`
- Create: `packages/credentials/src/index.ts`、`src/__tests__/index.test.ts`

**实现要点：**
- `name: "@issuepilot/credentials"`、`version: "0.0.0"`、`type: module`、`packageManager` 不要单独写。
- 依赖：`zod`（运行时校验 OAuth response）、`@issuepilot/observability`（用 redact）。
- devDependencies：`vitest`、`typescript`、`@types/node`。

**Step 1（红）：** `src/__tests__/index.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import * as credentials from "../index.js";

describe("@issuepilot/credentials", () => {
  it("exports VERSION", () => {
    expect(typeof credentials.VERSION).toBe("string");
  });
});
```

**Step 2（绿）：** `src/index.ts` 导出 `export const VERSION = "0.0.0";`。

**Step 3（commit）：** `chore(credentials): scaffold package`。

### Task 1.2：契约类型

**Files：**
- Create: `packages/credentials/src/types.ts`、`src/__tests__/types.test.ts`

**关键接口（必须实现）：**

```ts
// device flow
export interface DeviceCodeRequest {
  baseUrl: string;
  clientId: string;
  scope: string[];   // 默认 ["api","read_repository","write_repository"]
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: string;       // ISO，由 expires_in 计算
  pollIntervalMs: number;  // 由 interval (秒) 转换
}

export interface OAuthTokenResponse {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;       // "Bearer"
  scope?: string;
  expiresAt: string;       // 由 expires_in 计算
}

// 持久化文件
export interface StoredCredential {
  version: 1;
  hostname: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope?: string;
  obtainedAt: string;
  expiresAt: string;
}

// resolver
export interface ResolvedCredential {
  source: "env" | "oauth";
  hostname: string;
  accessToken: string;
  expiresAt?: string;       // env 来源时 undefined
  /** 触发一次强制 refresh（OAuth 来源才有意义；env 来源时返回 undefined）。 */
  refresh?: () => Promise<ResolvedCredential>;
}

export interface CredentialResolver {
  resolve(input: {
    hostname: string;
    trackerTokenEnv?: string;
  }): Promise<ResolvedCredential>;
}
```

**Step 1（红）：** type-only 测试断言关键 property 存在（`expectTypeOf`）。

**Step 2（绿）：** 落地 `types.ts` 并 `export *` 到 `index.ts`。

**Step 3（commit）：** `feat(credentials): define oauth and resolver contracts`。

**Phase 1 验收：**

- [ ] `pnpm install && pnpm --filter @issuepilot/credentials build test typecheck lint` 全绿。
- [ ] 包出现在 `pnpm-workspace.yaml` 通配里（无需手工修改，因为已经 `packages/*`）。
- [ ] `@issuepilot/credentials` 可被其他包 import（在 `@issuepilot/tracker-gitlab/package.json` 加 `dependencies` 但暂不使用，避免循环）。

---

## Phase 2：Device Flow 客户端

**目标：** 实现 OAuth 2.0 Device Authorization Grant 与 refresh 端点的客户端，使用 Node 内置 `fetch`，所有失败映射到结构化错误。

### Task 2.1：`requestDeviceCode`

**Files：**
- Create: `packages/credentials/src/device-flow.ts`、`src/__tests__/device-flow.test.ts`

**契约：**

```ts
export class OAuthError extends Error {
  override name = "OAuthError";
  constructor(
    message: string,
    public readonly category:
      | "authorization_pending"
      | "slow_down"
      | "expired_token"
      | "access_denied"
      | "invalid_grant"
      | "invalid_client"
      | "transient"
      | "unknown",
    public readonly retriable: boolean,
  ) { super(message); }
}

export async function requestDeviceCode(
  input: DeviceCodeRequest,
  deps?: { fetch?: typeof fetch },
): Promise<DeviceCodeResponse>;
```

**实现要点：**
- POST `${baseUrl}/oauth/authorize_device`，body `application/x-www-form-urlencoded`：`client_id`、`scope=space-separated`。
- 响应解析用 `zod`：`device_code` / `user_code` / `verification_uri` / `verification_uri_complete?` / `expires_in` / `interval`。
- `expiresAt = new Date(Date.now() + expires_in * 1000).toISOString()`。
- HTTP 4xx/5xx → `OAuthError`，category 按响应 body 中的 `error` 字段；网络异常 → `category: "transient", retriable: true`。
- 30s `AbortController` timeout。

**Step 1（红）：** mock fetch 返回 200 + 标准 body，断言转换正确；mock 返回 503 → 抛 `transient`；mock 抛 `AbortError` → 抛 `transient`。

**Step 2（绿）：** 实现。

**Step 3（commit）：** `feat(credentials): request device code via oauth endpoint`。

### Task 2.2：`pollForToken`

**Files：**
- Modify: `packages/credentials/src/device-flow.ts`
- Modify: `packages/credentials/src/__tests__/device-flow.test.ts`

**契约：**

```ts
export async function pollForToken(input: {
  baseUrl: string;
  clientId: string;
  deviceCode: string;
  pollIntervalMs: number;
  expiresAt: string;
}, deps?: {
  fetch?: typeof fetch;
  /** sleep 抽象注入；默认 setTimeout，测试可同步驱动。 */
  sleep?: (ms: number) => Promise<void>;
  /** 提供给 expired/access_denied/超时时输出 reporter。 */
  onStatus?: (s: "polling" | "slow_down") => void;
}): Promise<OAuthTokenResponse>;
```

**实现要点：**
- 循环：先 sleep `pollIntervalMs` → POST `${baseUrl}/oauth/token` (`grant_type=urn:ietf:params:oauth:grant-type:device_code`)。
- `authorization_pending` → 继续轮询。
- `slow_down` → `pollIntervalMs += 5_000`，调用 `onStatus("slow_down")`。
- `expired_token` / `access_denied` / `invalid_grant` → 抛对应 `OAuthError(retriable=false)`。
- 总耗时超过 `expiresAt` → 抛 `expired_token`。
- 成功 → 返回 `OAuthTokenResponse`，`accessToken/refreshToken/tokenType/scope/expiresAt` 全部填好。

**Step 1（红）：** 用 fake fetch + 同步 sleep 模拟「pending → pending → success」、「slow_down → success」、「expired → throw」、「access_denied → throw」四条路径。

**Step 2（绿）：** 实现。

**Step 3（commit）：** `feat(credentials): poll oauth token with backoff and expiry`。

### Task 2.3：`refreshAccessToken`

**Files：**
- Modify: `packages/credentials/src/device-flow.ts`
- Modify: `packages/credentials/src/__tests__/device-flow.test.ts`

**契约：**

```ts
export async function refreshAccessToken(input: {
  baseUrl: string;
  clientId: string;
  refreshToken: string;
}, deps?: { fetch?: typeof fetch }): Promise<OAuthTokenResponse>;
```

**实现要点：** POST `${baseUrl}/oauth/token` (`grant_type=refresh_token`)，body 含 `refresh_token` + `client_id`。失败映射同 Task 2.2。成功后 `OAuthTokenResponse.refreshToken` 必须取响应里的新值（GitLab 默认轮换 refresh token）。

**Step 1（红）：** mock 200 → 返回新 access + 新 refresh；mock 400 `invalid_grant` → 抛 `OAuthError("invalid_grant", retriable=false)`。

**Step 2（绿）：** 实现。

**Step 3（commit）：** `feat(credentials): refresh access token via refresh grant`。

**Phase 2 验收：**

- [ ] 4 种 OAuth 错误状态（authorization_pending、slow_down、expired_token、access_denied、invalid_grant）全部有单测。
- [ ] 所有响应解析走 zod schema，未识别字段不影响主流程。
- [ ] `OAuthError` 永不在 message 中嵌入 device_code / user_code / refresh_token / access_token。

---

## Phase 3：Credentials Store

**目标：** 把 OAuth 颁发的 token 落到 `~/.issuepilot/credentials`，按 spec §17 强制 `0600/0700` 权限。

### Task 3.1：路径与权限工具

**Files：**
- Create: `packages/credentials/src/paths.ts`、`src/__tests__/paths.test.ts`

**API：**

```ts
export interface CredentialsPathOptions {
  homeDir?: string;            // 测试注入；默认 os.homedir()
  configDirOverride?: string;  // 用户可设 IPILOT_HOME 覆盖
}

export function credentialsPath(opts?: CredentialsPathOptions): {
  dir: string;
  file: string;
};

export async function ensureCredentialsDir(dir: string): Promise<void>;
export async function assertSecureFileMode(file: string): Promise<void>;
```

**实现要点：**
- 默认目录：`<home>/.issuepilot`，文件：`<home>/.issuepilot/credentials`。
- `ensureCredentialsDir`：`fs.mkdir(dir, { recursive: true, mode: 0o700 })`，再 `fs.chmod(dir, 0o700)`（即便目录已存在也强制纠正）。
- `assertSecureFileMode`：`fs.stat(file)`，若 `mode & 0o077 !== 0` 抛 `CredentialsPermissionError`，提示「请运行 `chmod 600 <path>`」。
- Windows 兼容：`process.platform === "win32"` 时跳过 mode 校验，但留 TODO 注释（P0 只面向 macOS/Linux dev）。

**Step 1（红）：** mkdtempSync 临时目录 → ensureCredentialsDir → stat 应为 0o700；写一个 0o644 的 dummy 文件 → assertSecureFileMode 抛 `CredentialsPermissionError`。

**Step 2（绿）：** 实现。

**Step 3（commit）：** `feat(credentials): paths and 0600 mode guard`。

### Task 3.2：CredentialsStore

**Files：**
- Create: `packages/credentials/src/store.ts`、`src/__tests__/store.test.ts`

**API：**

```ts
export interface CredentialsStore {
  read(hostname: string): Promise<StoredCredential | null>;
  write(cred: StoredCredential): Promise<void>;
  delete(hostname: string): Promise<void>;
  list(): Promise<StoredCredential[]>;
}

export function createCredentialsStore(opts?: CredentialsPathOptions): CredentialsStore;
```

**实现要点：**
- 文件 layout：JSON 数组，每个 hostname 一条；schema 用 zod 校验，未知字段忽略。
- `write`：`ensureCredentialsDir` → 读旧数组 → 替换/追加同 hostname 条目 → 写到 `${file}.tmp`（mode 0o600）→ `fs.rename`，避免半写文件。
- `delete`：写回不含目标 hostname 的数组；若数组空则保留空 `[]` 而非删除文件（避免下次 write 时找不到目录）。
- `read` / `list`：先 `assertSecureFileMode`；文件不存在返回 `null` / `[]`。

**Step 1（红）：** roundtrip write→read 一致；并发两次 write 不撕裂（fs.rename 原子性）；mode 校验不通过抛错。

**Step 2（绿）：** 实现。

**Step 3（commit）：** `feat(credentials): json store with atomic write and mode guard`。

**Phase 3 验收：**

- [ ] 临时目录覆盖率 100%；读 / 写 / 删 / 列 / mode 校验各 1 个用例。
- [ ] `JSON.stringify(store)` 不会暴露 token（store facade 不含 token state）。

---

## Phase 4：Credential Resolver

**目标：** 把 env 变量、credentials 文件、refresh 流程串成一个 facade，daemon 与 CLI 共用。

### Task 4.1：`resolveCredential`

**Files：**
- Create: `packages/credentials/src/resolver.ts`、`src/__tests__/resolver.test.ts`

**API：**

```ts
export interface CreateResolverDeps {
  store: CredentialsStore;
  env?: { get(name: string): string | undefined };
  refresh?: typeof refreshAccessToken;
  /** 默认 5 分钟。低于此值视为「即将过期」并主动 refresh。 */
  refreshSkewMs?: number;
  clientId?: string;
  /** 默认 () => Date.now()，测试注入。 */
  now?: () => number;
}

export function createCredentialResolver(deps: CreateResolverDeps): CredentialResolver;
```

**行为：**
- `resolve({ hostname, trackerTokenEnv })`：
  1. 若 `trackerTokenEnv` 提供且 `env.get(name)` 非空 → 返回 `{ source: "env", accessToken, refresh: undefined }`，**不**触碰 credentials 文件。
  2. 否则 `store.read(hostname)`：
     - `null` → 抛 `CredentialError("not_logged_in", message="请运行 issuepilot auth login --hostname <host>")`。
     - 距离 `expiresAt` ≤ `refreshSkewMs` 且有 refreshToken → 调 `refresh()` → `store.write(new)` → 返回新 ResolvedCredential。
     - 其他情况 → 直接返回当前 credential。
- 返回的 `refresh` 闭包：再次调用 `refreshAccessToken` 强制刷新，写回 store。

**Step 1（红）：** 5 个用例：
1. env 命中 → source=env，store 不被读取。
2. env 缺失 + store 有未过期 → source=oauth。
3. env 缺失 + store 即将过期 → 触发 refresh，store.write 收到新 token。
4. env 缺失 + store 空 → 抛 `not_logged_in`。
5. refresh 失败 → 抛 `OAuthError`，store 不被覆盖。

**Step 2（绿）：** 实现。

**Step 3（commit）：** `feat(credentials): resolver with env precedence and auto refresh`。

### Task 4.2：facade 导出

**Files：**
- Modify: `packages/credentials/src/index.ts`

导出 `requestDeviceCode`、`pollForToken`、`refreshAccessToken`、`createCredentialsStore`、`createCredentialResolver`、所有类型。

**commit：** `feat(credentials): expose credentials facade`。

**Phase 4 验收：**

- [ ] resolver 5 个用例 + facade typecheck 通过。
- [ ] 任何抛错都不在 message 中嵌入 token / refresh token。

---

## Phase 5：Tracker-GitLab 集成

**目标：** 让 `createGitLabClient` 接受 `CredentialResolver`，并在 401 时尝试 refresh 一次。

### Task 5.1：`auth.ts` 接受 resolver

**Files：**
- Modify: `packages/tracker-gitlab/src/auth.ts`、`src/__tests__/auth.test.ts`

**改动：**
- 新增 `resolveTokenViaResolver({ resolver, hostname, trackerTokenEnv })`，返回 `{ token, refresh? }`。
- 保留旧 `resolveGitLabToken` 用作 env-only fast path（向后兼容现有测试），但新增 deprecation comment：「Phase 5 之后内部不直接调用，仅用于 env-only smoke 测试」。

**Step 1（红）：** 用 fake resolver 注入；env-only 路径返回 `refresh=undefined`；oauth 路径返回 `refresh` callback 可被调用。

**Step 2（绿）：** 实现。

**Step 3（commit）：** `feat(tracker-gitlab): accept credential resolver in auth`。

### Task 5.2：`client.ts` 拥抱 resolver + 401 refresh-and-retry

**Files：**
- Modify: `packages/tracker-gitlab/src/client.ts`、`src/__tests__/client.test.ts`

**改动：**
- `CreateGitLabClientInput` 新增 `resolver?: CredentialResolver` 与 `hostname?: string`（resolver 必须有 hostname；省略时从 `baseUrl` 派生）；`tokenEnv` 改为 optional。
- 内部状态保存当前 `token` 与 `refresh`；构造时第一次 `resolver.resolve(...)`。
- `request<T>(label, fn)`：执行 fn → 捕获 → 若 `toGitLabError` 分类为 `auth` 且当前 source=oauth 且未在本次重试过 → 调 `refresh()` → 重建 GitLab API 实例（用新 token）→ 重跑一次 fn；仍失败则向上抛 `auth` 错误。
- 每次 refresh 之后通过 `Object.defineProperty(client, "_token", { value: newToken, ... })` 更新内部 token slot（保持 enumerable=false）。

**Step 1（红）：**
- 不带 resolver、只带 tokenEnv → 走原路径（已有测试不变）。
- 带 resolver + env source → 不会因 401 触发 refresh（因为 source=env）。
- 带 resolver + oauth source + fn 第一次 401 第二次 200 → request resolves。
- oauth source + 两次 401 → request rejects with auth。

**Step 2（绿）：** 实现，注意保留现有 `toJSON()` 不暴露 token 的契约。

**Step 3（commit）：** `feat(tracker-gitlab): refresh oauth token on 401 once`。

**Phase 5 验收：**

- [ ] 现有 tracker-gitlab 测试套件仍全绿（含 39 个 case）。
- [ ] 新增 4 个 resolver 集成测试。
- [ ] `JSON.stringify(client)` 仍不含 token（regression）。

---

## Phase 6：CLI 子命令 + Daemon 集成

### Task 6.1：`issuepilot auth login`

**Files：**
- Create: `apps/orchestrator/src/auth/index.ts`、`src/__tests__/auth/login.test.ts`
- Modify: `apps/orchestrator/src/cli.ts`、`src/__tests__/cli.test.ts`

**实现要点：**
- 新增 `program.command("auth").command("login")`，options：`--hostname <host>` (required)、`--scope <list>` (default `api,read_repository,write_repository`)、`--client-id <id>` (default `process.env.IPILOT_OAUTH_CLIENT_ID ?? "issuepilot-cli"`).
- 调用 `requestDeviceCode` → 在 stdout 打印（**仅** 控制台，不进 logs）：

  ```text
  ! First copy your one-time code: ABCD-EFGH
  ! Then open: https://gitlab.example.com/-/profile/applications
  Press Enter to continue (waits for authorization)…
  ```

- `pollForToken` 循环；输出进度点 `.`（最多每 5s 一个）。成功后 `store.write(...)` + 打印 `Logged in to <hostname> as <prefix>...`（prefix 取 token 前 8 字符 + `…`，绝不打全 token）。

**Step 1（红）：** 注入 fake fetch 与 fake store；驱动 login → 校验 store.write 收到正确 hostname/scope/expiresAt。

**Step 2（绿）：** 实现。

**Step 3（commit）：** `feat(orchestrator): issuepilot auth login subcommand`。

### Task 6.2：`auth status` + `auth logout`

**Files：**
- Modify: `apps/orchestrator/src/auth/index.ts`、`src/__tests__/auth/status.test.ts`

**实现要点：**
- `status`：list store；按 hostname 输出 `clientId / scope / expiresAt / source`，不打印 token。空时输出 `No credentials stored. Run: issuepilot auth login --hostname <host>`。
- `logout --hostname`：删除指定 hostname；不带 hostname 时 prompt `--all` 才允许全删（避免误操作）。

**commit：** `feat(orchestrator): issuepilot auth status and logout`。

### Task 6.3：daemon 启动接 resolver

**Files：**
- Modify: `apps/orchestrator/src/daemon.ts`、`src/__tests__/daemon.test.ts`

**实现要点：**
- `startDaemon` 创建 `CredentialResolver` 一次（store + refresh 函数），注入 `createGitLabClient({ resolver, hostname: workflow.tracker.baseUrl host })`。
- 启动前调一次 `resolver.resolve(...)` 做 fail-fast；失败按 spec §17 提示 `请运行 issuepilot auth login --hostname <host>`。
- `validateWorkflow` 同样接 resolver（保持 CLI `validate` 行为一致）。

**Step 1（红）：**
- daemon 在 env-only 配置下仍能起来（兼容性）。
- daemon 在缺失 env + 缺失 credentials 时拒绝启动并打印明确错误。
- daemon 在 credentials 即将过期时启动过程中触发 refresh。

**Step 2（绿）：** 实现。

**Step 3（commit）：** `feat(orchestrator): daemon resolves credentials before serving`。

**Phase 6 验收：**

- [ ] 4 条新 CLI 子命令均有单测。
- [ ] `pnpm exec issuepilot --help` 列出 `auth login | status | logout`。
- [ ] `pnpm exec issuepilot doctor` 不变（OAuth 不需要新依赖）。

---

## Phase 7：E2E + Smoke 同步

### Task 7.1：fake OAuth server

**Files：**
- Create: `tests/e2e/fakes/oauth/server.ts`、`server.test.ts`

**实现：** Fastify 实例提供 `/oauth/authorize_device` 与 `/oauth/token`（同时支持 device_code grant 与 refresh_token grant）。配套 helper：`seed({ pendingTicks, accessToken, refreshToken })`，控制几次轮询后再返回成功。

**commit：** `test(e2e): fake gitlab oauth server`。

### Task 7.2：CLI happy-path E2E

**Files：**
- Create: `tests/e2e/oauth-login.test.ts`

**断言：**
1. 启动 fake OAuth server。
2. 执行 `issuepilot auth login --hostname <fake-host>`（程序化调用 cli.ts，注入 stdin/stdout）。
3. fake server 经过 2 次 pending 后返回 token。
4. 检查 `<tmpHome>/.issuepilot/credentials` 文件 mode === `0o600`、内容含正确 hostname / accessToken。
5. `issuepilot auth status` 输出 hostname + 「expires in N minutes」，不含 token 字符串。
6. `issuepilot auth logout --hostname <host>` 后 status 显示空。

**commit：** `test(e2e): oauth login happy path with status and logout`。

### Task 7.3：daemon 401 → refresh → retry E2E

**Files：**
- Create: `tests/e2e/oauth-refresh.test.ts`

**断言：**
1. seed credentials 文件，access token 已过期、refresh token 有效。
2. fake GitLab 第一次 `/api/v4/issues` 返回 401，第二次返回 200。
3. fake OAuth server 收到 refresh 调用 → 颁发新 access token。
4. daemon 拾取一个 ai-ready issue 流程不中断；事件流不含 token 字符串。

**commit：** `test(e2e): daemon refreshes oauth token on 401`。

### Task 7.4：smoke runbook + getting-started 同步

**Files：**
- Modify: `docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`
- Modify: `docs/getting-started.md` / `docs/getting-started.zh-CN.md`

**改动：** smoke runbook 新增「使用 `issuepilot auth login` 登录」备选路径（既可用 PAT 也可用 OAuth）；getting-started §5.0 已经在前置任务里写好，本任务核对实际行为与文档一致。

**commit：** `docs: oauth login flow in smoke runbook and getting-started`。

### Task 7.5：CHANGELOG + README

**Files：**
- Modify: `CHANGELOG.md`、`README.md`、`README.zh-CN.md`

**改动：** CHANGELOG 在 `Unreleased / Added` 顶部新增 OAuth 落地条目；README 在 Highlights 与「当前状态」里补一句「内置 GitLab OAuth Device Flow 登录」。

**commit：** `docs: changelog and readme entries for oauth device flow`。

**Phase 7 验收：**

- [ ] `pnpm -w turbo run build test typecheck lint` 全绿。
- [ ] 3 条新 e2e 用例稳定通过（无 flake，重跑 5 次）。
- [ ] CHANGELOG / README 中英文同步。

---

## MVP Definition of Done（OAuth）

| 验收项 | 验证手段 |
|---|---|
| `issuepilot auth login` 可走完 device flow 并落盘 | Phase 6 单测 + Phase 7 Task 7.2 e2e |
| credentials 文件强制 0600 权限 | Phase 3 单测 + Phase 7.2 e2e 文件 mode 断言 |
| daemon 优先读 env，缺失时 fallback 到 credentials | Phase 6 daemon 测试 |
| Access token 即将过期或 401 时自动 refresh 一次 | Phase 4 resolver 测试 + Phase 7.3 e2e |
| `auth status` / `auth logout` 行为符合 spec §23 | Phase 6 单测 |
| token 字符串不出现在事件 / 日志 / dashboard / prompt | redact 单测扩充 + Phase 7 e2e 输出 grep |
| 文档与 CHANGELOG 同步 | Phase 7.4 / 7.5 |

---

## 风险与回退

- **GitLab 内网实例未启用 OAuth Device 应用**：在 README/getting-started 显式标注前置条件「GitLab 实例需要管理员注册一个 confidential=false 的 OAuth Application 并允许 Device Authorization Grant」；env-only 路径仍可用作回退方案。
- **clock skew 导致 expiresAt 计算偏差**：`refreshSkewMs` 默认 5 分钟提供缓冲；额外在 401 路径触发 refresh 兜底。
- **fs.rename 在跨设备情况下失败**：credentials 文件与目录都在 `~/.issuepilot/`，同设备；测试在临时目录验证。
- **多 daemon 同时 refresh**：P0 单机场景，没有跨进程锁；refresh 失败一次 → 由 401 兜底再次触发，最多 1 次额外 HTTP，影响可忽略。

---

## 执行交接

**计划已保存：** `docs/superpowers/plans/2026-05-14-issuepilot-oauth-plan.md`

**两种执行方式：**

1. **Subagent 驱动**（当前会话）：每 Task 派一个 fresh subagent；Task 之间 review。
   - REQUIRED SUB-SKILL：`superpowers:subagent-driven-development`。
2. **独立会话**：在干净 worktree 中开新 session，按本计划逐 Task 实施。
   - REQUIRED SUB-SKILL：`superpowers:executing-plans`。

无论哪种方式：

- 每个 Task 完成后立即 commit，并把变更摘要追加进 `CHANGELOG.md`（Phase 7.5 兜底）。
- Phase 切换时跑一次 `pnpm -w turbo run build test typecheck lint`。
- 真实 GitLab smoke 在 Phase 7 完成后跑一次：用真实实例 + `issuepilot auth login` 走完 login → daemon → 一个 ai-ready issue → MR / handoff note。
