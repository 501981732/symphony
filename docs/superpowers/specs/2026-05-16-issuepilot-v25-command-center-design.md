# IssuePilot V2.5 Command Center / Run Report 设计

日期：2026-05-16
状态：待用户评审
关联文档：

- `docs/superpowers/specs/2026-05-11-issuepilot-design.md`
- `docs/superpowers/specs/2026-05-14-issue-note-handoff-design.md`
- `docs/superpowers/specs/2026-05-14-human-review-closure-design.md`
- `docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`
- `docs/superpowers/specs/2026-05-15-issuepilot-v2-phase2-dashboard-operations-design.md`
- `docs/superpowers/specs/2026-05-16-issuepilot-v2-phase3-ci-feedback-design.md`
- `docs/superpowers/specs/2026-05-16-issuepilot-v2-phase4-review-feedback-sweep-design.md`
- `docs/superpowers/specs/2026-05-16-issuepilot-v2-phase5-workspace-retention-design.md`

## 1. 背景

IssuePilot V2 已经把团队可运营底座落地：team mode、dashboard actions、CI 回流、review
feedback sweep 和 workspace retention 已进入 `main`。当前 dashboard 能展示 overview、run
detail、timeline、tool calls、log tail、CI 状态、review feedback 和基础操作。

下一步不是把 IssuePilot 做成通用项目管理系统，而是把 dashboard 从“可观测页面”升级为
“可运营控制台”：

- Operator 能快速判断当前 run 分布在哪些阶段、哪些 issue 需要处理。
- Reviewer 能在一个 review packet 中看清 handoff、diff、测试、风险、CI、review feedback
  和 merge readiness。
- Tech Lead 能在 Reports 中查看成功率、返工率、CI pass rate、review 命中率和耗时趋势。

本设计定义 V2.5 的产品形态、UI 信息架构、`RunReportArtifact` 数据模型、merge readiness
dry run 语义和测试要求。

## 2. 目标

V2.5 交付 **Linear-like Command Center + 统一 Run Report**：

1. Command Center 支持 `List / Board` 两种视图，围绕 IssuePilot run 而不是通用 ticket 管理。
2. List View 服务日常运营：排序、筛选、快速定位失败、阻塞和可 review 的 run。
3. Board View 服务阶段态势：按 `ai-ready`、`ai-running`、`ai-rework`、`human-review`、
   `ai-failed/ai-blocked` 分列展示任务。
4. Run Detail 升级为 Review Packet，直接展示结构化 handoff、failure、blocked、closing
   note 字段。
5. 新增持久化 `RunReportArtifact`，作为 dashboard、GitLab note、Markdown 报告和 merge
   readiness dry run 的统一事实来源。
6. V2.5 只做 merge readiness dry run，不执行真实自动 merge。
7. Reports 页面聚合质量指标和耗时指标，不挤占 Command Center 第一屏。
8. UI 质量必须达到工程运营工具标准：高密度但可扫读、键盘可用、状态清晰、响应式降级明确。

## 3. 非目标

V2.5 不做：

- 通用 Linear 替代品。
- 真实自动 merge。
- 拖拽 Board 卡片直接修改 GitLab label。
- 多租户权限系统。
- 自定义 workflow 可视化编辑器。
- 大模型质量评分或成本预算。
- 长期数据库迁移；P0/V2 的本地 `~/.issuepilot/state` 模型继续有效。

## 4. 用户和优先级

V2.5 的主用户是 **Operator**，强二级用户是 **Reviewer**。

| 用户 | 核心问题 | 主入口 |
| --- | --- | --- |
| Operator | 当前哪些 run 在跑、卡住、失败、等待 review？ | Command Center List / Board |
| Reviewer | 这个 MR 改了什么、验证了什么、有什么风险、能不能 merge？ | Review Packet |
| Tech Lead | 本周 IssuePilot 质量如何，返工和 CI 失败集中在哪里？ | Reports |

设计排序：Operator 工作流优先，Reviewer 决策链必须完整，Tech Lead 指标放在 Reports 中分阶段增强。

## 5. 设计选项

### 方案 A：Report-first Command Center（采用）

先定义 `RunReportArtifact`，再让 Command Center、Review Packet、GitLab note 和 Markdown 报告
都消费这份结构化报告。

优点：

- dashboard、GitLab note、报告字段天然一致。
- merge readiness dry run 有稳定输入。
- 后续真实 auto merge 可以复用同一策略评估模型。
- 适合把 V2 已有 CI / review / retention 能力收成一个可运营产品面。

缺点：

- 需要先补 report store 和 report 渲染层，不能只改 UI。

### 方案 B：UI-first Command Center

先把 dashboard 做成 Linear-like 操作台，报告继续从 run/events/notes 临时拼。

优点：视觉变化最快。

缺点：信息仍散落在 events、notes、run record 中，后续 report 和 merge readiness 会返工。

### 方案 C：Review-first Packet

先深挖 run detail / review packet，Overview 只小改。

优点：直接服务 reviewer。

缺点：Operator 的日常看板不完整，不符合 V2.5 的主用户排序。

## 6. 产品页面结构

### 6.1 Command Center

Command Center 是 V2.5 的第一屏。

布局：

- 左侧稳定导航：`Command Center`、`Review Queue`、`Reports`、`Projects`、`Settings`。
- 顶部筛选：project、status、time range、owner、saved view。
- 主区支持 `List / Board` view toggle。
- 右侧 inspector 展示当前选中 run 的 Review Packet 摘要。

默认视图：

- 默认使用 List View。
- 记住用户上次选择的 view。
- 当用户从 saved view 进入阶段分析时，可以直接打开 Board View。

Command Center 不应满屏堆 KPI。顶部只保留少量必要状态计数，例如 running、human-review、
blocked、CI failed、ready to merge。更完整质量指标进入 Reports。

### 6.2 List View

List View 是默认运营视图，目标是高密度、可扫读、可排序。

建议字段：

- Issue：iid、title、project。
- Status：run status + GitLab workflow label。
- CI：latest pipeline status。
- Merge：merge readiness dry run 状态。
- Attempt：当前 attempt。
- Updated：最近事件时间。
- Duration：总耗时或当前阶段耗时。
- Risk：最高风险等级。

交互：

- 行点击打开右侧 inspector。
- issue、MR、workspace、report 使用明确链接。
- 支持 status / project / readiness / risk 快速筛选。
- 支持 saved views，例如 `Ready to merge`、`Needs action`、`Blocked`。

### 6.3 Board View

Board View 用于回答：“当前任务分别卡在哪些阶段？”

列定义：

- `ai-ready`
- `ai-running`
- `ai-rework`
- `human-review`
- `ai-failed / ai-blocked`

卡片字段：

- Issue id + title。
- Project。
- Attempt。
- 当前耗时。
- CI pill。
- Merge readiness pill。
- 风险/阻塞摘要。

Board View 的状态来自 GitLab label 和 run report，不允许通过拖拽直接修改状态。状态变更仍由
orchestrator 和 GitLab label 状态机控制。若未来需要人工操作，必须走明确 action，并写入
operator audit event。

Board View 在桌面端可以横向滚动；移动端默认退回 List View，Board 作为可选视图。

### 6.4 Review Packet

Review Packet 是 run detail 的产品化形态，服务 reviewer 的 merge / rework 决策。

主要区块：

- Header：issue、project、status、branch、MR、attempt。
- Handoff：summary、validation、risks、follow-ups、next action。
- Diff Summary：文件数量、主要文件、增删统计、notable changes。
- Checks：测试/验证命令、状态、耗时、失败说明。
- CI：pipeline 状态、pipeline 链接、更新时间。
- Review Feedback：最新 sweep 的 reviewer comments、resolved 状态、cursor。
- Merge Readiness：dry run checklist 和 blocking reasons。
- Timeline：事件证据链。
- Logs：redacted log tail。

Review Packet 的上半部分必须从 `RunReportArtifact` 读取；timeline 和 logs 只作为证据链。

### 6.5 Reports

Reports 聚合质量和效率指标。

V2.5 推荐指标：

- success rate。
- rework rate。
- CI pass rate。
- review feedback hit rate。
- average run duration。
- average review wait duration。
- blocked / failed reason distribution。
- ready-to-merge but waiting count。

图表优先采用：

- KPI bullet / compact stat。
- time-series line chart。
- distribution bar chart。

图表必须有文本值和表格替代，不能只靠颜色表达状态。

## 7. UI 设计标准

V2.5 采用 **Linear-like issue workspace**，不是厚重运维大屏。

视觉规则：

- 轻边框、低饱和背景、紧凑列表、右侧 detail panel。
- 状态使用 pill 表达，并配合文字，不只靠颜色。
- 避免大面积深色 dashboard 和装饰性渐变。
- KPI 轻量化，第一屏以 issue/run 工作流为主。
- 使用一致 icon family，按钮内优先图标 + tooltip，不使用 emoji 作为结构图标。
- 卡片半径保持克制，避免卡片套卡片。

交互和可访问性：

- 所有可点击元素有 `cursor-pointer`、hover、focus-visible 状态。
- 所有 icon-only button 必须有 `aria-label`。
- 表格有 `aria-sort`。
- List / Board / filters 支持键盘导航。
- async action 使用 loading / disabled state，避免重复点击。
- 错误信息必须包含恢复路径。
- loading 超过 300ms 使用 skeleton。
- 支持 `prefers-reduced-motion`。
- 文本对比度满足 WCAG AA。

响应式：

- Desktop：三栏布局（nav / main / inspector）。
- Tablet：nav 可折叠，inspector 可变为 side sheet。
- Mobile：分层导航（list/board -> detail），不强行保留三栏。
- Wide table 在移动端转为 card list 或横向滚动容器，不能撑破 viewport。

## 8. RunReportArtifact

`RunReportArtifact` 是 V2.5 的核心数据对象。它不是替代 event store，而是把 run record、events、
GitLab MR、CI、review feedback、agent output、diff 和 checks 归纳成一份稳定报告。

建议 TypeScript 形态：

```ts
interface RunReportArtifact {
  version: 1;
  runId: string;
  issue: {
    projectId: string;
    iid: number;
    title: string;
    url: string;
    labels: string[];
  };
  run: {
    status: "claimed" | "running" | "retrying" | "stopping" | "completed" | "failed" | "blocked";
    attempt: number;
    branch: string;
    workspacePath: string;
    startedAt: string;
    endedAt?: string;
    durations: {
      totalMs?: number;
      queueMs?: number;
      workspaceMs?: number;
      agentMs?: number;
      reconcileMs?: number;
      reviewWaitMs?: number;
    };
    lastError?: {
      code: string;
      message: string;
      classification?: "failed" | "blocked" | "cancelled" | "unknown";
    };
  };
  mergeRequest?: {
    iid: number;
    url: string;
    state: "opened" | "merged" | "closed";
    approvals?: {
      required?: number;
      approvedBy: string[];
      satisfied: boolean;
    };
  };
  handoff: {
    summary: string;
    validation: string[];
    risks: Array<{ level: "low" | "medium" | "high"; text: string }>;
    followUps: string[];
    nextAction: string;
  };
  diff: {
    summary: string;
    filesChanged: number;
    additions?: number;
    deletions?: number;
    notableFiles: string[];
  };
  checks: Array<{
    name: string;
    status: "passed" | "failed" | "skipped" | "unknown";
    command?: string;
    durationMs?: number;
    details?: string;
  }>;
  ci?: {
    status: "running" | "success" | "failed" | "pending" | "canceled" | "unknown";
    pipelineUrl?: string;
    checkedAt: string;
  };
  reviewFeedback?: {
    latestCursor?: string;
    unresolvedCount: number;
    comments: Array<{
      author: string;
      body: string;
      url: string;
      resolved: boolean;
      createdAt: string;
    }>;
  };
  mergeReadiness: {
    mode: "dry-run";
    status: "ready" | "not-ready" | "blocked" | "unknown";
    reasons: Array<{
      code: string;
      severity: "info" | "warning" | "blocking";
      message: string;
    }>;
    evaluatedAt: string;
  };
  notes: {
    handoffNoteId?: number;
    failureNoteId?: number;
    closingNoteId?: number;
  };
}
```

字段原则：

- 缺失信息必须显式表达为 `unknown`、`skipped`、`not reported` 或空数组，不能让 UI 看起来像通过。
- `version` 必须存在，未来 schema 变化通过版本迁移处理。
- `handoff` 是 dashboard 和 GitLab note 的共同字段来源。
- `checks` 只记录实际知道的验证结果；没有结构化测试输出时不能伪造通过。
- `mergeReadiness` 即使无法判断也必须存在，状态为 `unknown` 并给出原因。

存储：

- report 存在 `~/.issuepilot/state`，和 run store / event store 同生命周期。
- 每个 run 至少一份当前 report。
- 允许按阶段增量更新。
- 旧 run 没有 report 时，dashboard 可以从现有 run/events 派生 legacy summary，但必须标记
  `legacy run` 或 `report unavailable`。

## 9. Report 生命周期

report 生命周期：

1. claim 成功后创建初始 report，记录 issue、attempt、branch、workspace、startedAt。
2. workspace ready 后补 workspace timing。
3. agent 完成后补 summary、validation、risks、checks 和 agent timing。
4. reconcile 阶段补 diff、MR、handoff note id 和 reconcile timing。
5. CI feedback sweep 补 CI 状态。
6. review feedback sweep 补 reviewer comments 和 unresolved count。
7. merge readiness evaluator 更新 dry run 状态。
8. human-review closure 后补 closing note id、MR merged 状态、review wait duration。

report 生成失败不能影响 event store 写入。dashboard 必须能降级展示事件和 logs，同时明确提示
`report incomplete`。

## 10. GitLab Note 和 Markdown 报告渲染

V2.5 后，GitLab note 不再各自拼字段，而是从 `RunReportArtifact` 渲染。

渲染目标：

- handoff note。
- failure / blocked note。
- closing note。
- Markdown report export。

要求：

- 继续保留 `<!-- issuepilot:run:<runId> -->` marker。
- handoff note 使用 report 的 `handoff`、`diff`、`checks`、`mergeRequest`、`mergeReadiness`
  摘要。
- failure / blocked note 使用 report 中的 status、`run.lastError`、risks、next action。
- closing note 使用 report 中的 MR merged 状态、closing note id 和 final result。
- Markdown report 可以比 GitLab note 更完整，但字段来源必须相同。

## 11. Merge Readiness Dry Run

V2.5 只评估 merge readiness，不执行 merge。

语义：

- `mergeReadiness.mode = "dry-run"`。
- orchestrator 只判断“如果允许自动 merge，现在是否满足条件”。
- 不调用 GitLab merge API。
- 人类仍在 GitLab 中手动 merge。

判断输入：

- MR 存在且 `state === opened`。
- CI 状态为 `success`。
- approval 满足项目规则。
- 没有 unresolved review comments。
- report 中没有 high risk。
- run 不是 `failed` 或 `blocked`。
- branch 等于 IssuePilot 记录的 branch。
- issue 仍处于 `human-review`。
- 可选策略：只允许特定 project、label 或 file pattern 进入 ready。

建议配置：

```yaml
merge:
  auto_merge:
    mode: dry_run
    require_ci_success: true
    require_approval: true
    block_on_high_risk: true
    block_on_unresolved_review: true
    allowed_labels:
      - safe-to-auto-merge
```

V2.5 解析到 `mode: enabled` 时必须拒绝或降级为 `dry_run` 并输出 warning，避免操作者误以为
系统会真实 merge。

展示：

- List View：`ready`、`not ready`、`blocked`、`unknown`。
- Board 卡片：`dry-run pass`、`approval missing`、`CI failed` 等 pill。
- Review Packet：完整 checklist 和 blocking reasons。
- Reports：统计 ready-to-merge but waiting 的数量和等待时间。

## 12. API 和共享契约

建议新增或扩展 shared contracts：

- `RunReportArtifact`。
- `RunReportSummary`，供 `/api/runs` 轻量列表使用。
- `MergeReadinessResult`。
- `ReportRenderTarget`，区分 `handoff`、`failure`、`blocked`、`closing`、`markdown`。

API 调整方向：

- `GET /api/runs` 返回 run record + report summary。
- `GET /api/runs/:runId` 返回 run record + full report + events + logs。
- `GET /api/reports` 支持 Reports 聚合查询。
- `GET /api/reports/:runId.md` 或 CLI report command 可导出 Markdown。

所有 API 响应继续经过 redaction，不能泄漏 token、authorization header 或 secret env。

## 13. 错误处理

- report 生成失败：run detail 顶部展示 `report incomplete`，事件和 logs 仍可查看。
- GitLab handoff note 写入失败：不得切到 `human-review`。
- diff summary 缺失：显示 `not available`，保留 commit/MR 链接。
- checks 缺失：显示 `not reported`，不得显示为 passed。
- CI 或 approval 无权限读取：merge readiness 为 `unknown`，reason severity 为 `warning` 或
  `blocking`。
- Board 列数据过多：列内滚动或分页，不能导致页面整体不可用。
- 旧 run 没有 report：使用 legacy fallback，并明确标记。
- report schema 版本不支持：dashboard 展示只读 fallback，不尝试修改。

## 14. 测试要求

shared-contracts：

- `RunReportArtifact` schema、version、fallback 字段。
- `MergeReadinessResult` 状态和 reason severity。

orchestrator：

- claim 创建初始 report。
- agent completed 后补 handoff、checks、timing。
- reconcile 后补 diff、MR、note id。
- failure / blocked run 生成 report，并写入 `run.lastError`。
- closing 后更新 final report。
- report 生成失败时 event store 不丢失。

GitLab note rendering：

- handoff note 从 report 渲染。
- failure / blocked note 从 report 渲染。
- closing note 从 report 渲染。
- marker 与 runId 保持一致。

merge readiness：

- CI missing。
- CI failed。
- approval missing。
- unresolved review comments。
- high risk。
- ready path。
- `mode: enabled` 被拒绝或降级。

dashboard：

- List / Board 视图切换。
- Board 按 workflow labels 分列。
- inspector 共用 Review Packet。
- legacy run fallback。
- loading / empty / error states。
- keyboard navigation、focus-visible、aria-label、aria-sort。

E2E：

- happy path 从 `ai-ready` 到 `human-review` 后生成 report。
- fake CI success + approval 后 merge readiness dry run 为 ready。
- fake review comment unresolved 后 readiness 变为 blocked/not-ready。
- 人工 merge 后 closing report 更新。

## 15. 分阶段交付建议

### Phase 1：Report Contract and Store

- 定义 shared contract。
- 实现 report store。
- 在 claim / complete / reconcile / failure / closing 关键路径更新 report。

### Phase 2：Note Rendering from Report

- handoff / failure / blocked / closing note 改为从 report 渲染。
- 保持现有 marker 和去重逻辑。
- 补 renderer 单测和 E2E。

### Phase 3：Command Center UI

- 引入 Linear-like layout。
- List View 使用 report summary。
- Board View 按 label 分列。
- 右侧 inspector 展示 Review Packet 摘要。

### Phase 4：Merge Readiness Dry Run

- 实现 evaluator。
- 更新 report。
- 在 List、Board、Review Packet、Reports 展示 readiness。

### Phase 5：Reports

- 聚合 run reports。
- 展示质量和耗时趋势。
- 支持 Markdown report export。

## 16. Rollback

rollback 分层：

- UI rollback：保留 report store，只回退 Command Center UI 到现有 overview/detail。
- report rendering rollback：GitLab note 临时回到旧 renderer，但保留 report 采集。
- merge readiness rollback：关闭 evaluator，不影响 handoff 和 review。
- store rollback：dashboard fallback 到 run/events；旧 reports 文件保留但不再更新。

任何 rollback 都不能删除 event store、workspace 和 GitLab note marker，因为这些是恢复和排障依据。
