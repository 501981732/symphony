# Changelog

本仓库的所有显著变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Added

- 2026-05-12 — **IssuePilot P0 Phase 7（M7 Dashboard）完成。** `@issuepilot/dashboard` 完整落地 spec §14 的两组只读视图（Overview `/` + Run detail `/runs/[runId]`），通过 SSE 实时刷新；dashboard 44 单测、`pnpm -w turbo run test typecheck lint --force` 33/33 任务全绿，`/` 与 `/runs/[runId]` 路由都通过 Next.js 14 dynamic build。涵盖 4 个 Task：
  - **Task 7.1** `feat(dashboard): nextjs app with tailwind and shadcn primitives` — Tailwind 3.x + 手写 shadcn 风格 `Button/Card/Table/Badge` primitives + `cn` 工具（clsx + tailwind-merge）。
  - **Task 7.2** `feat(dashboard): typed api client and event stream hook` — `lib/api.ts` 5 个 typed REST helper + `ApiError` + base URL fallback；`lib/use-event-stream.ts` SSE hook 含指数退避、buffer cap、malformed payload 容错、test seam。
  - **Task 7.3** `feat(dashboard): overview page with service header and runs table` — Server Component 并行拉 state + runs，client side OverviewPage 节流 1s re-fetch；ServiceHeader 7 字段、SummaryCards 6 张 RunStatus 卡、RunsTable 11 列含 sortable header（iid/status/updatedAt + aria-sort + ▲▼）。
  - **Task 7.4** `feat(dashboard): run detail page with live timeline` — `app/runs/[runId]/page.tsx` 路由 Server Component 并行调 `getRun + listEvents`，404 走 `notFound()`；`RunDetailPage` 客户端组件用 `useEventStream({ runId })` 实时追加事件（按 `event.id` 去重）；`EventTimeline` 33 种 EventType 一一映射 BadgeTone，事件按 createdAt 升序，可展开 redacted data；`ToolCallList` 过滤 `tool_call_*`；`LogTail` 黑底终端样式，未拿到 logsTail 时给出 `~/.issuepilot/state/logs/issuepilot.log` 路径提示。新增 10 个详情组件单测。

- 2026-05-12 — **IssuePilot P0 Phase 7 Task 7.3（概览页）完成。** `apps/dashboard/app/page.tsx` + `components/overview/*` 落地 spec §14 三段视图（Service header / Summary cards / Runs table），首页改 `dynamic = "force-dynamic"` 走 Next.js Server Component 拉初始数据。验证：`pnpm --filter @issuepilot/dashboard test typecheck lint build` 全绿（34/34 单测），`pnpm -w turbo run test typecheck lint --force` 33/33 全绿。
  - `components/overview/service-header.tsx`：渲染 `status / gitlabProject / concurrency / pollIntervalMs / workflowPath / lastConfigReloadAt / lastPollAt` 7 个字段，status 用 Badge tone 区分（ready=success，degraded=warning），时间戳本地化 + invalid date fallback；2 个测试。
  - `components/overview/summary-cards.tsx`：用 `RUN_STATUS_VALUES`（shared-contracts 常量）渲染 6 张卡片，running/retrying/failed/blocked 高亮配色；1 个测试。
  - `components/overview/runs-table.tsx`：`"use client"` 表格组件，11 列覆盖 plan 7.3 全部要求（iid / title / labels / status / attempt / elapsed / updated / branch / MR / workspace / actions detail link），sortable header 支持 `iid / status / updatedAt` 三键 + `aria-sort` attribute + ▲▼ 视觉指示，默认 updatedAt desc；empty state 友好提示加 `ai-ready` label；外链全部 `rel="noreferrer noopener"`；4 个测试覆盖渲染 / empty / detail link / 排序切换。
  - `components/overview/overview-page.tsx`：`"use client"` page wrapper，用 `useEventStream({ bufferSize: 50, onEvent })` 监听 `run_/claim_/retry_/reconciliation_` 前缀的生命周期事件，触发节流 1s 的 `refetch`（双护栏 `pendingRef + inflightRef` 防风暴 + 防重叠请求）；2 个测试。
  - `app/page.tsx`：Server Component 调 `fetchOverview()` 并行 GET state + runs，`refetch` 走 `"use server"` Server Action（避免 client → 4738 跨源），错误兜底页提示 `pnpm dev:orchestrator`。
  - 测试工具：vitest config 启用 esbuild automatic JSX runtime + `vitest.setup.ts` 引入 `@testing-library/jest-dom/vitest` matchers 并在 `afterEach` 调 `cleanup()` 防止 DOM 累积；devDeps 新增 `@testing-library/jest-dom`。

- 2026-05-12 — **IssuePilot P0 Phase 7 Task 7.2（API 客户端 + SSE hook）完成。** `apps/dashboard/lib/` 落地 typed REST client 与 `useEventStream` React hook，覆盖 spec §15 的 5 个 orchestrator endpoint。验证：`pnpm --filter @issuepilot/dashboard test typecheck lint build` 全绿（25/25 单测，5 个 spec 文件）。
  - `lib/api.ts`：`apiGet<T>` 用 fetch + `cache: "no-store"` + `accept: application/json`；`resolveApiBase()` 优先读 `NEXT_PUBLIC_API_BASE`、默认 `http://127.0.0.1:4738`、自动 strip trailing slash；`ApiError(status, body)` 保留状态码与响应体便于下层 fallback；`getState/listRuns/getRun/listEvents/eventStreamUrl` 5 个 typed helper 直接返回 `@issuepilot/shared-contracts` 中的 `OrchestratorStateSnapshot / RunRecord / IssuePilotEvent`，`listRuns` 支持 `RunStatus | readonly RunStatus[]` 状态查询。
  - `lib/use-event-stream.ts`：`"use client"` React hook，封装 EventSource 连接 + 指数退避重连（1s → 2s → … 上限 30s）+ unmount 自动 close + runId 过滤参数；新增 `bufferSize`（默认 200 FIFO 防内存膨胀）、`onEvent` 回调（用 ref 缓存，回调变更不重连）、`enabled` 开关；malformed JSON 静默丢弃但保持 stream 打开。`__setEventSourceFactory` test seam 用 `__` 前缀显式标记。
  - 测试：`api.test.ts` 10 个 case 覆盖 base URL fallback / status query encode / runId URL-encode / 错误传播；`use-event-stream.test.tsx` 6 个 case 覆盖连接 / buffer cap / onEvent 回调 / 指数退避重连 / unmount cleanup / malformed payload 容错。
  - 依赖：新增 `@issuepilot/shared-contracts@workspace:*`、devDeps `@testing-library/react ^16`、`@testing-library/dom`、`jsdom`。

- 2026-05-12 — **IssuePilot P0 Phase 7 Task 7.1（Dashboard 脚手架）完成。** `@issuepilot/dashboard` 接入 Tailwind 3.x + shadcn 风格 primitives，为后续概览页/详情页打下基础。验证：`pnpm --filter @issuepilot/dashboard test typecheck lint build` 全绿（9/9 单测通过，Next.js 14 build 成功）。`pnpm -w turbo run test typecheck lint --force` 33/33 任务全绿不破坏其他包。
  - `lib/cn.ts` + `lib/cn.test.ts`：`clsx + tailwind-merge` 组合，conflict-resolution 友好的 className 工具，4 个测试覆盖 join / 条件 / 冲突覆盖 / 对象语法。
  - `components/ui/{button,card,table,badge}.tsx`：手写 shadcn 风格 primitives，Button 支持 variant/size 表驱动，Badge 支持 6 种 tone，Card 拆 `Card/CardHeader/CardTitle/CardContent`，Table 拆 `Table/TableHeader/TableBody/TableRow/TableHead/TableCell` 并外层加 overflow-x-auto；4 个 smoke 测试验证 forwardRef 组件可渲染。
  - `app/globals.css` + `tailwind.config.ts` + `postcss.config.mjs`：tailwind 3.x 三件套，content 覆盖 `app/components/lib`；扩展 `font-sans` / `font-mono` 字体栈。
  - `app/layout.tsx` 引入 globals.css 并加 `min-h-screen font-sans antialiased`；`app/page.tsx` 用新 primitives 展示 Phase 7 skeleton 状态。
  - 依赖：新增 `clsx ^2`、`tailwind-merge ^3`、devDeps 新增 `tailwindcss ^3.4`、`postcss ^8.4`、`autoprefixer ^10.4`；未引入 `@radix-ui/*` 与 shadcn-cli（P0 dashboard 只读不需要 popover/dialog，保持依赖轻量）。
  - dashboard 内部 import 改成无 `.js` 后缀（适配 Next.js webpack + bundler resolution）；vitest config 扩展 `.tsx` 文件并新增 `components/**/*.test.tsx` 入口。

### Fixed

- 2026-05-12 — **docs: IssuePilot design spec 与 implementation plan 全面修正（共 13 处问题）**
  - **Design Spec (`2026-05-11-issuepilot-design.md`)**：
    - §6 补充 `poll_interval_ms` 字段到 workflow YAML 示例，默认 `10000`；在加载规则中说明 `thread_sandbox`（kebab-case）与 `turn_sandbox_policy.type`（camelCase）分属不同 RPC 层级，格式差异是设计意图，`danger-full-access`/`dangerFullAccess` 均不允许
    - §7 `ai-rework` label 补充语义说明：这是人工主动打回（从 human-review 阶段触发）的独立状态，不是 `ai-ready` 的别名
    - §10 runner 职责说明补充 sandbox 字段格式对照注释（`thread/start` 用 kebab-case，`turn/start` 用 camelCase）
    - §12 reconciliation 兜底 push 策略补充分支冲突处理：使用 `git push --force-with-lease`；non-fast-forward 冲突分类为 `failed`，不强制覆盖
    - §16 `IssuePilotEvent.type` 从宽泛 `string` 改为 `EventType` 字面量联合类型，并补充 `threadId`/`turnId`/`projectId` 字段
    - §22 区分 workpad note（持久进度记录，agent 可主动更新）与 fallback note（orchestrator 兜底摘要），两者语义不同可共存
  - **Implementation Plan (`2026-05-11-issuepilot-implementation-plan.md`)**：
    - Architecture 描述包数量从"六个"修正为"七个"
    - Tech Stack 列表补充 `p-timeout`
    - Task 1.1 根 `package.json` devDependencies 补充 `execa`（根集成 smoke test 直接用 `execaSync`）
    - Task 2.1 `WorkflowSchema` 中的 `.default({} as any)` 改为 `.default({})`，并移除对 `danger-full-access`/`dangerFullAccess` 的允许；schema 新增 `poll_interval_ms` 字段
    - Task 3.2 排序职责澄清：adapter 只做单字段 API 排序，orchestrator 做多字段稳定排序
    - Task 5.2 补充 `p-timeout` 依赖声明说明
    - Task 6.6 `cfg.poll_interval_ms` 改为 `cfg.pollIntervalMs`（与 WorkflowConfig camelCase 对齐）
    - Phase 6.x Observability 改为 Phase 5.x，明确 `redact.ts` + `event-bus.ts` 必须在 Phase 5 前完成
    - Task 8.2 fake Codex 脚本 schema 补充四种指令类型（`expect`/`respond`/`notify`/`tool_call`）的完整语义说明和示例
  - **代码同步**：
    - `packages/workflow/src/types.ts`：`WorkflowConfig` 新增 `pollIntervalMs: number` 字段
    - `packages/workflow/src/parse.ts`：`WorkflowFrontMatterSchema` 新增 `poll_interval_ms` 字段（zod，默认 `10_000`），`parseWorkflowFile` 输出映射到 `pollIntervalMs`
    - 全量 `turbo typecheck` 通过，无 lint 错误

### Added

- 2026-05-11 — **IssuePilot P0 Phase 6（Orchestrator）完成。** `@issuepilot/orchestrator` 实现完整编排引擎，包含 8 个子模块、11 spec / 57 cases 全绿：
  - `feat(orchestrator): runtime state and concurrency slots` — 内存 RunEntry 管理 + 按状态查询/汇总、N 槽位并发控制。10 个测试。
  - `feat(orchestrator): claim candidates with optimistic labels` — 从 GitLab 拉候选 Issue、乐观 label 转换、冲突跳过、slot 感知。4 个测试。
  - `feat(orchestrator): classify errors and schedule retries` — 按 spec §13 把任意异常三分为 blocked/failed/retryable，retry 策略判断。14 个测试。
  - `feat(orchestrator): deterministic post-run reconciliation` — push / 创建或更新 MR / workpad note / label 转换 handoff，7 种缺失组合覆盖。7 个测试。
  - `feat(orchestrator): dispatch run through workspace and runner` — 串联 mirror → worktree → hooks → prompt → agent → reconcile 全流程，错误分类 + 重试决策。6 个测试。
  - `feat(orchestrator): main loop with reload and reconcile-on-start` — setInterval 驱动 tick、重启兜底 reconcile、inflight drain。5 个测试。
  - `feat(orchestrator): fastify HTTP API and SSE stream` — `/api/state`、`/api/runs`、`/api/runs/:runId`、`/api/events/stream` SSE 端点。5 个测试。
  - `feat(orchestrator): cli entry with run/validate/doctor` — commander CLI，run/validate/doctor 三命令冒烟验证。5 个测试。

- 2026-05-11 — **IssuePilot P0 Phase 6.x（Observability）完成。** `@issuepilot/observability` 实现 secret 脱敏、内存事件总线、JSONL 事件存储、原子 run 记录存储、pino 日志工厂。验证：27/27 全绿；observability 包内 6 spec / 25 cases 全绿。包含 5 个子模块：
  - `feat(observability): redact secrets in events and logs` — 基于 token 模式（glpat-/glrt-/Bearer/sk-）和字段名黑名单（password/secret/api_key/token 等）的递归脱敏。7 个测试。
  - `feat(observability): in-memory event bus` — 泛型 pub/sub，支持过滤函数和 unsubscribe，订阅者错误隔离。5 个测试。
  - `feat(observability): append-only event store` — JSONL 按 `<projectSlug>-<issueIid>.jsonl` 切文件，支持 limit/offset 分页。4 个测试。
  - `feat(observability): atomic run record store` — JSON 按 `<projectSlug>-<issueIid>.json` 存储，写入先到 .tmp 再 rename 保证原子性。5 个测试。
  - `feat(observability): pino logger with run context` — pino factory 支持 stdout + 可选文件双输出，child logger 注入 runId/issueIid。2 个测试。

- 2026-05-11 — **IssuePilot P0 Phase 5（M5 Codex App-Server Runner）完成。** `@issuepilot/runner-codex-app-server` 实现 spec §10 的 JSON-RPC stdio client、线程/回合生命周期编排、事件标准化和 spec §11 的 9 个 GitLab dynamic tools。验证：`pnpm -w turbo run build test typecheck --force` 27/27 全绿；runner 包内 5 spec / 24 cases 全绿。包含 5 个 Task：
  - **Task 5.1（commit 07ab23a）** `feat(runner): newline-delimited JSON-RPC stdio client` — `spawnRpc` 封装 `execa` 实现双向 NDJSON-RPC，支持 request/response（带 pending map）、通知、malformed 行处理、进程退出清理。6 个测试。
  - **Task 5.2（commit 6568a69）** `feat(runner): drive thread/turn lifecycle with timeouts` — `driveLifecycle` 编排 initialize → thread/start → turn/start 循环，处理 completed/failed/cancelled/timeout 四种回合结局，支持 maxTurns 限制。3 个测试。
  - **Task 5.3（commit 46a455f）** `feat(runner): normalize app-server notifications into events` — 把 turn/notification、tool/*、approval/request、turn/input_required 映射成标准 IssuePilotEvent；policy=never 自动 approve；input 请求自动回复 non-interactive 消息。8 个测试。
  - **Task 5.4（commit 2e8ac42）** `feat(runner): expose allowlisted GitLab dynamic tools` — `createGitLabTools` 生成 9 个 ToolDefinition，每个 handler 用 `safe()` 包装，成功返回 `{ok:true,data}`，失败返回 `{ok:false,error}`。5 个测试。
  - **Task 5.5（commit d36884d）** `feat(runner): expose codex runner facade` — 汇总导出所有 runner 功能到 index.ts。

- 2026-05-11 — **IssuePilot P0 Phase 4（M4 Workspace Manager）完成。** `@issuepilot/workspace` 实现 spec §9 的 bare mirror + git worktree 模型和 hooks 执行。验证：`pnpm -w turbo run build test typecheck --force` 27/27 全绿；workspace 包内 6 spec / 37 cases 全绿，覆盖路径安全、mirror 克隆/fetch、worktree 创建/复用/脏检测、hook 执行/超时/跳过、失败标记保留。包含 6 个 Task：
  - **Task 4.1（commit 2585c4e）** `feat(workspace): path safety and branch sanitizer` — `slugify` 仅保留 `[a-z0-9-]`，collapses 连字符，空返 `untitled`，支持 maxLen；`assertWithinRoot` 用 `fs.realpath` canonicalize 后校验子路径在根路径下，防 symlink escape 和 `..` traversal；`branchName` 生成 `prefix/iid-titleSlug`，校验 ≤200 字符且不含 `..`/`:`/`~`/`^`/`\\`。新增 15 个测试。
  - **Task 4.2（commit 0f3c7bb）** `feat(workspace): ensure bare mirror via execa` — `ensureMirror` 首次调用 `git clone --mirror`，后续调用 `git fetch --prune origin`，支持 `~` 路径展开。新增 4 个测试覆盖 first clone、fetch reuse、新 commit pickup、无效 URL 报错。
  - **Task 4.3（commit 963302e）** `feat(workspace): worktree create-or-reuse with safety checks` — `ensureWorktree` 路径确定 `<root>/<slug>/<iid>`，先 `assertWithinRoot`；不存在时 `git worktree add -B <branch> <baseBranch>`；存在时校验 is-worktree、branch 一致、工作区干净，脏工作区抛 `WorkspaceDirtyError`。新增 4 个测试。
  - **Task 4.4（commit db48996）** `feat(workspace): execute hooks with timeout and size cap` — `runHook` 用 `bash -lc` 在 workspace cwd 执行自定义脚本，支持 env 注入、可配 timeout（默认 600s）、stdout/stderr 1MB 截断；空/undefined script 跳过返回 `skipped: true`；非零退出或超时抛 `HookFailedError`。新增 7 个测试。
  - **Task 4.5（commit 3a92e41）** `feat(workspace): mark workspace failure for forensics` — `cleanupOnFailure` 不删除文件，仅在 `.issuepilot/failed-at-<iso>` 写入失败 context JSON；`pruneWorktree` 为 P1 占位。新增 4 个测试。
  - **Task 4.6（commit def715b）** `feat(workspace): expose workspace manager facade` — 汇总导出 slugify/assertWithinRoot/branchName/ensureMirror/ensureWorktree/runHook/cleanupOnFailure/pruneWorktree 及三个 Error class，index.test.ts 增加 facade 契约测试。

- 2026-05-11 — **IssuePilot P0 Phase 3（M3 GitLab Adapter）完成。** `@issuepilot/tracker-gitlab` 用 `@gitbeaker/rest@^43.8` 实现 spec §11 的 9 个适配器方法 + 三分类错误（auth/permission/not_found/validation/rate_limit/transient/unknown），retriable 默认与 spec §13 对齐。验证（无缓存）：`pnpm -w turbo run build test typecheck lint --force` 36/36 全绿；tracker-gitlab 包内 9 spec / 57 cases 全绿，覆盖 client 错误分类、issue 列表/详情、label 乐观锁、note workpad、MR 幂等 CRUD、pipeline 状态映射。包含 6 个 Task：
  - **Task 3.1（commit 6b21b3c）** `feat(tracker-gitlab): client factory with classified errors` — `createGitLabClient` 接受 baseUrl / tokenEnv / projectId，通过 `resolveGitLabToken` 校验 env name 合法（`^[A-Za-z_][A-Za-z0-9_]*$`）+ trim 后非空，token 用 `Object.defineProperty({ enumerable: false })` + 自定义 `toJSON` 双重隐藏；`request(label, fn)` 统一把抛错 normalize 成 `GitLabError`：401→auth / 403→permission / 404→not_found / 400-409-422→validation / 429→rate_limit / 5xx→transient / 其它→unknown。新增 13 个测试。
  - **Task 3.2（commit d61c2c1）** `feat(tracker-gitlab): list candidate issues with exclude filter` — `listCandidateIssues(client, opts)` 用 `Issues.all({ state: "opened", labels: activeLabels.join(","), orderBy: "updated_at", sort: "asc", perPage: opts.perPage ?? 50 })`，本地用 `Set(excludeLabels)` 过滤；`toIssueRef` 把 REST 的数字 id 映射成 `gid://gitlab/Issue/<n>` 并 `Object.freeze` labels 数组。同时拆出 `src/api-shape.ts` 给 `@gitbeaker/rest` 的最小接口定义（Issues/IssueNotes/MergeRequests/MergeRequestNotes/Pipelines + 配套 Raw* 行 schema），让 stub 注入和真实 ctor 共享类型。新增 7 个测试。
  - **Task 3.3（commit fa0a1a8）** `feat(tracker-gitlab): label transition with optimistic claim` — `transitionLabels(client, iid, { add, remove, requireCurrent })` 先 `Issues.show` 读 labels，缺失 `requireCurrent` → `GitLabError(category="validation", status=409, retriable=false, message="claim_conflict: ...")`；计算 `next = (current\remove) ∪ add` 保留顺序去重；只有差异时调 `Issues.edit`；第二次 `Issues.show` 验证 add 全部到位且 remove 全部移除，否则同样 claim_conflict。新增 7 个测试。
  - **Task 3.4（commit 959f97a）** `feat(tracker-gitlab): persistent workpad note operations` — `createIssueNote` / `updateIssueNote(... noteId, { body })` / `findWorkpadNote(iid, marker)`，第一行匹配（trim 后）`<!-- issuepilot:run=<runId> -->` 作为 workpad sticky note 标识；跳过 GitLab system note；perPage=100。新增 7 个测试。
  - **Task 3.5（commit 9d54638）** `feat(tracker-gitlab): merge request CRUD and pipeline status` — `createMergeRequest` 先 `MergeRequests.all({ sourceBranch, state: "opened", perPage: 5 })`，已存在 opened MR 时幂等返回，否则 `MergeRequests.create(projectId, source, target, title, { description, issueIid })`；`updateMergeRequest` 在 updates 为空时直接 short-circuit；`getMergeRequest` 投影 `{ iid, webUrl, state }`；`listMergeRequestNotes` 把 author 回退到 username→name→`"unknown"`。`getPipelineStatus(ref)` 取 `Pipelines.all({ ref, perPage: 1, orderBy: "updated_at", sort: "desc" })` 最新一条，`classifyPipelineStatus` 把 GitLab 12+ 种 raw status 收敛成 6 种（created/manual/scheduled/preparing/waiting_for_resource → pending；skipped → canceled；未知 → unknown）。新增 13 个测试。
  - **Task 3.6（commit 5038a10）** `feat(tracker-gitlab): expose adapter facade` — `createGitLabAdapter(input)` 返回 `GitLabAdapterHandle = GitLabAdapter & { client }`，每个方法是 helper 的一行 binding，保持 adapter 无状态；同时补全 `getIssue(iid) → IssueRef & { description }`（description 缺失回退 `""`）。8 个 contract 测试覆盖 11 个方法签名 + token 仍然 redact。

### Fixed

- 2026-05-11 — **IssuePilot Workflow Loader 安全边界加固。** 拒绝 workflow 配置 `danger-full-access` / `dangerFullAccess` sandbox；`tracker.token_env` 限制为合法环境变量名且缺失错误不回显疑似 secret；`renderPrompt` 在运行时构造 prompt 白名单 context，额外字段渲染为空并 warn；`createWorkflowLoader` 统一执行 parse → path expand → token env validate；hot reload 忽略较晚完成的过期 reload 结果。验证：`pnpm --filter @issuepilot/workflow test` 47/47 通过，`typecheck` / `lint` / `build` / `git diff --check` 通过。

### Added

- 2026-05-11 — **IssuePilot P0 Phase 2（M2 Workflow Loader）完成。** `@issuepilot/workflow` 完整实现 `.agents/workflow.md` 的解析、`~/$HOME` 路径与 token env 解析、liquidjs prompt 渲染、fs.watch + stat 轮询的 hot reload，以及面向 orchestrator 的 `createWorkflowLoader` 门面。验证（无缓存）：`pnpm -w turbo run build test typecheck lint --force` 36/36 全绿；workflow 包内 6 spec / 47 cases 全绿，覆盖 spec §6 加载规则、§6 全部 12 个模板变量、与缺失 secret/缺失 tracker/坏 YAML/hot reload 失败保留 last-known-good 等错误路径。包含 5 个 Task：
  - **Task 2.1（commit 8636bb4）** `feat(workflow): parse front matter into typed config` — `parseWorkflowFile` 通过 `gray-matter` + `yaml`（显式拒绝 array/标量 front matter）+ zod schema，把 snake_case YAML 映射成 camelCase `WorkflowConfig`，可选 section 用 `prefault({})` 触发嵌套 default 与 spec §6 默认值对齐；`WorkflowConfigError(path)` 区分 `<file>` / `<front-matter>` / 字段 dot-path 三类错误。新增 4 个 fixture（valid/minimal/missing-tracker/bad-yaml）+ 6 个测试。
  - **Task 2.2（commit 1127790）** `feat(workflow): resolve tilde paths and validate token env` — `expandHomePath` 支持 `~`、`~/...` 与字面量 `$HOME`（仅在边界字符前），显式不展开 `~user/...`、`${HOME}`、`$HOMEX`、其它 env；非字符串输入抛 `WorkflowConfigError(path = "<path>")`。`expandWorkflowPaths` 克隆并展开 `workspace.root` / `repoCacheRoot`，保持纯函数。`validateWorkflowEnv` 与 `resolveTrackerSecret` 把 secret 解析集中到运行期，cfg 永不带 token。新增 15 个测试。
  - **Task 2.3（commit e4569f8）** `feat(workflow): render liquid prompt with whitelisted context` — `renderPrompt` 用 liquidjs（strictVariables=false / strictFilters=true / cache=false / root=[]），并把 `fs` 适配器全部替换成 reject/false 实现，显式禁掉 `{% include %}` / `{% render %}`；`detectMissingVariables` 用正则提取顶层 dotted 引用静态扫描，缺失项以 `{ path }` 元数据走可注入的 `PromptRenderLogger.warn`。新增 8 个测试覆盖 spec §6 12 个变量、未定义字段空串 + warn 路径、空数组不触发 warn、include/render 抛错、未知 filter 抛错。
  - **Task 2.4（commit 079ecb9）** `feat(workflow): hot reload with last-known-good fallback` — `watchWorkflow(file, opts)` 监听 dirname + basename 过滤，规避编辑器 rename-then-write 模式；debounce 默认 250ms（测试可调低），`sha256` dedup 防止编辑器双写；运行期 parse 失败包装成 `WorkflowConfigError` 走 `onError`、`current()` 保留 last-known-good；`stop()` 幂等。新增 6 个测试。
  - **Task 2.5（commit dd610bb）** `feat(workflow): expose loader facade with start/loadOnce/render` — `createWorkflowLoader({ logger? })` 返回 `{ loadOnce, start, render }`，`start` 的 `onReload` / `onError` 默认 no-op，`render` 默认沿用注入 logger 调用方可覆盖。同时在 `watch.ts` 加上 `max(debounceMs*4, 200ms)` 的 stat-mtime 轮询兜底（解决 turbo 并发跑时 fs.watch 偶发不触发），仍依赖 sha256 dedup。`index.ts` 汇总导出 parse/resolve/render/watch/loader 的公共 API。新增 4 个集成测试。

- 2026-05-11 — **IssuePilot P0 Phase 1（M1 Skeleton）完成。** 落地 pnpm workspace + Turborepo + TypeScript 项目引用，并把跨包公共契约前置到 `@issuepilot/shared-contracts`。验证：`pnpm -w turbo run build test typecheck lint` 36/36 全绿、`pnpm test:smoke` 11/11 全绿、`pnpm --filter @issuepilot/shared-contracts test` 20/20 全绿。包含 4 个 Task：
  - **Task 1.1（commit 1228596）** `chore: bootstrap pnpm workspace with turborepo` — 根 `package.json` 锁定 `pnpm@10.33.2` + Node 22；新增 `pnpm-workspace.yaml`、`turbo.json`、`tsconfig.base.json`（strict + NodeNext + ES2023 + composite）、`.npmrc`（engine-strict）、`.gitignore`、`tests/integration/scaffold.smoke.test.ts`。
  - **Task 1.2（commit e403384）** `chore: scaffold workspace packages and apps` — 为 7 个 library package（`@issuepilot/core`、`workflow`、`tracker-gitlab`、`workspace`、`runner-codex-app-server`、`observability`、`shared-contracts`）和 2 个 app（`@issuepilot/orchestrator` 占位 + `@issuepilot/dashboard` Next.js 14 + React 18 最小可 build 应用）创建 stub。每个 workspace 都接入 turbo `build/test/typecheck/lint` 调度。
  - **Task 1.3（commit 6548e94）** `chore: configure eslint, prettier, tsconfig project references` — 接入 ESLint v9 flat config（`typescript-eslint` recommended + `eslint-plugin-import`，测试与 dashboard 上下文有针对性 override）、Prettier（80 列、双引号、`trailingComma: all`）、`.editorconfig`，根 `tsconfig.json` 聚合 8 个 emitting workspace 的 `references`；每个包 `lint` script 由占位 echo 改为 `eslint --max-warnings 0`。新增 `tests/integration/lint.smoke.test.ts` 把契约纳入 CI。
  - **Task 1.4（commit 26cdd3b）** `feat(shared-contracts): define run/event/state interfaces` — 在 `@issuepilot/shared-contracts` 落地 5 个子模块：`issue.ts`（`IssueRef`）、`run.ts`（`RUN_STATUS_VALUES` + `RunStatus` + `isRunStatus` + `RunRecord`）、`events.ts`（覆盖 spec §10 全部 33 个 event type 的 `EVENT_TYPE_VALUES` + `EventType` + `isEventType` + `IssuePilotEvent`）、`state.ts`（`SERVICE_STATUS_VALUES` + `OrchestratorStateSnapshot`）、`api.ts`（`ListRunsQuery` / `RunsListResponse` / `RunDetailResponse` / `EventsQuery` / `EventsListResponse`）。每个值 + 类型对都用 `expectTypeOf` 配套测试防止漂移。
- 2026-05-11 — 新增 IssuePilot P0 实现计划：`docs/superpowers/plans/2026-05-11-issuepilot-implementation-plan.md`。计划基于 `docs/superpowers/specs/2026-05-11-issuepilot-design.md`，按 spec §19 的里程碑拆分为 8 个 Phase（M1 skeleton → M8 E2E + smoke），细化到 ≈ 40 个 Task，每个 Task 给出 Files / TDD 5 步 / 验收。包含跨包接口契约（`@issuepilot/shared-contracts`、`@issuepilot/workflow`、`@issuepilot/tracker-gitlab`、`@issuepilot/workspace`、`@issuepilot/runner-codex-app-server`、`@issuepilot/observability`）、文件结构总图、风险与回退、以及与 spec §21 MVP DoD 14 条逐项对齐的验证矩阵。
