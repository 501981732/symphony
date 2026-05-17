# IssuePilot 中心化 Workflow 配置设计

日期：2026-05-17
状态：已确认，实施计划已补充
对应计划：`docs/superpowers/plans/2026-05-17-issuepilot-central-workflow-config.md`
上级设计：

- `docs/superpowers/specs/2026-05-11-issuepilot-design.md`
- `docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`
- `docs/superpowers/specs/2026-05-16-issuepilot-v2-phase1-team-runtime-foundation-design.md`

## 1. 背景

V2 team mode 已经支持：

```bash
issuepilot run --config /path/to/issuepilot.team.yaml
```

当前实验实现是 `issuepilot.team.yaml` 聚合多个项目，但每个项目仍通过
`projects[].workflow` 指向各自业务仓库里的 `WORKFLOW.md`。这在单项目或早期试点中
可用，但进入团队多项目后会出现几个问题：

- workflow 策略散落在多个业务 repo，团队无法从一个位置查看、校验和回滚 agent 行为。
- 修改 label 状态机、runner sandbox、CI 回流或 review sweep 策略时，需要批量改多个
  repo，容易漂移。
- 业务 repo 的代码变更和 IssuePilot 运行策略混在一起，不利于实验期统一调整。
- 新项目接入需要复制完整 `WORKFLOW.md`，重复字段多，模板长期维护成本高。

因此，团队多项目模式需要把 workflow 从“各项目自带完整配置”直接切换为“中心配置管理，
项目只提供必要事实和少量覆盖”。

## 2. 目标

本设计目标是引入一个中心化配置模型：

1. 一个 team daemon 从一个配置根加载全部项目和 workflow profile。
2. workflow 主体由中心配置仓库管理，支持 review、回滚和统一校验。
3. 每个项目只维护必要项目事实：GitLab project、repo URL、base branch、profile 选择和
   少量白名单 override。
4. 新模型可以编译成内部 `WorkflowConfig` 运行态，但这是实现复用，不是旧
   `projects[].workflow` 或 repo-owned `WORKFLOW.md` 的兼容层。
5. team mode 的新 schema 可以破坏式替换旧实验 schema；当前没有正式应用，不需要平滑迁移。

## 3. 非目标

本设计不做：

- workflow 可视化编辑器。
- 鉴权层、权限模型、审批系统或多租户权限系统。
- 数据库存储配置。
- 从业务 repo 自动发现所有项目。
- 在配置文件中保存 token、OAuth refresh token 或任何 secret。
- 为旧 `projects[].workflow` 或 repo-owned `WORKFLOW.md` 做兼容加载、迁移工具或双路径运行。
- 允许业务 repo 任意覆盖 sandbox、token、runner command 等高风险运行字段。

## 4. 推荐形态

推荐使用独立中心配置目录或独立 Git 仓库，例如：

```text
issuepilot-config/
  issuepilot.team.yaml
  workflows/
    default-web.md
    default-node-lib.md
    default-docs.md
  projects/
    platform-web.yaml
    infra-tools.yaml
  policies/
    labels.gitlab.yaml
    codex.default.yaml
```

`issuepilot.team.yaml` 是 team mode 的唯一启动入口；它不再聚合 `WORKFLOW.md` 路径，而是声明
项目 registry、全局运行策略和 workflow profile 选择。

业务 repo 可以不放 IssuePilot 配置。若团队希望 repo 自描述，只允许保留薄文件：

```text
.issuepilot/project.yaml
```

该文件只描述稳定项目事实，不承载完整 prompt、runner、token、hooks 或状态机。

## 5. 配置模型

### 5.1 Team config

示例：

```yaml
version: 1

server:
  host: 127.0.0.1
  port: 4738

scheduler:
  max_concurrent_runs: 2
  max_concurrent_runs_per_project: 1
  lease_ttl_ms: 900000
  poll_interval_ms: 10000

defaults:
  labels: ./policies/labels.gitlab.yaml
  codex: ./policies/codex.default.yaml
  workspace_root: ~/.issuepilot/workspaces
  repo_cache_root: ~/.issuepilot/repos

projects:
  - id: platform-web
    name: Platform Web
    enabled: true
    project: ./projects/platform-web.yaml
    workflow_profile: ./workflows/default-web.md

  - id: infra-tools
    name: Infra Tools
    enabled: true
    project: ./projects/infra-tools.yaml
    workflow_profile: ./workflows/default-node-lib.md
```

### 5.2 Project file

示例：

```yaml
tracker:
  kind: gitlab
  base_url: https://gitlab.example.com
  project_id: group/platform-web

git:
  repo_url: git@gitlab.example.com:group/platform-web.git
  base_branch: main
  branch_prefix: ai

agent:
  max_turns: 10
  max_attempts: 2
```

project file 只允许项目事实和少量运行参数。高风险运行字段继续由中心配置或 daemon 启动
环境控制；这只是实验期的配置护栏，不是鉴权层。

### 5.3 Workflow profile

`workflows/*.md` 保持当前 `WORKFLOW.md` 的 Markdown 体验，但其中的 front matter 更偏
模板化和 profile 化。profile 负责：

- agent prompt 模板。
- 默认 hooks。
- 默认 CI / review sweep 行为。
- 适合该项目类型的上下文说明。

profile 可以引用项目事实，例如：

```md
---
agent:
  runner: codex-app-server
  max_concurrent_agents: 1

codex:
  approval_policy: never
  thread_sandbox: workspace-write
---

你正在处理 GitLab 项目 `{{ project.tracker.project_id }}` 的 Issue。
目标仓库地址是 `{{ project.git.repo_url }}`，默认分支是
`{{ project.git.base_branch }}`。
```

## 6. Effective Workflow 编译

中心化配置可以先编译为内部 `WorkflowConfig` 运行态。这里的 `WorkflowConfig` 是
orchestrator 内部接口，不代表要兼容旧的 `projects[].workflow` 输入：

```text
issuepilot.team.yaml
  -> project file
  -> workflow profile
  -> defaults / policies
  -> effective WorkflowConfig
  -> daemon runtime
```

这样可以减少实现面：

- `apps/orchestrator` 继续按 project 注册 workflow。
- `packages/workflow` 新增中心配置解析和 effective workflow 编译能力。
- `packages/tracker-gitlab` 不关心配置文件分层，只消费 effective workflow。
- `packages/workspace` 继续只消费 resolved `repo_url`、`base_branch`、workspace root。
- dashboard 继续展示 effective workflow source 和 project id。

## 7. 覆盖优先级

配置合并采用固定优先级：

```text
built-in safe defaults
  < central policies
  < workflow profile
  < project file
  < projects[].overrides
```

但不是所有字段都允许覆盖。覆盖能力分三类：

| 字段类型 | 例子 | 覆盖规则 |
| --- | --- | --- |
| 项目事实 | `tracker.project_id`、`git.repo_url`、`git.base_branch` | project file 必须提供，可被中心 team config 直接声明 |
| 运行参数 | `agent.max_turns`、`agent.max_attempts`、`ci.enabled` | 可按 project 覆盖 |
| 实验期运行护栏 | `tracker.token_env`、`codex.approval_policy`、`codex.thread_sandbox`、runner command | 默认由中心配置或 daemon 环境控制，项目侧不开放 |

如果 project file 或 repo-local thin file 尝试覆盖高风险运行护栏，校验必须失败并给出
dotted path 错误。

## 8. Repo-local Thin File

业务 repo 内的 `.issuepilot/project.yaml` 是可选项。它适合两类场景：

1. 项目 owner 希望 repo 内能看到最小接入事实。
2. 中心配置希望从业务 repo 读取 base branch 或 repo URL，降低重复录入。

该文件不是 team mode 的最高事实来源。中心配置可以选择：

```yaml
projects:
  - id: platform-web
    repo_local_project_file: /srv/repos/platform-web/.issuepilot/project.yaml
    workflow_profile: ./workflows/default-web.md
```

即使读取 repo-local thin file，loader 也必须按白名单过滤字段，不能让业务 repo 提升
sandbox、改变 token env 或替换 runner command。这是配置解析阶段的字段约束，不是用户
鉴权。

## 9. CLI 和校验

新增或扩展：

```bash
issuepilot validate --config /srv/issuepilot-config/issuepilot.team.yaml
issuepilot validate --config /srv/issuepilot-config/issuepilot.team.yaml --project platform-web
issuepilot render-workflow --config /srv/issuepilot-config/issuepilot.team.yaml --project platform-web
```

`validate --config` 必须输出每个项目的配置来源：

```text
Team config loaded: /srv/issuepilot-config/issuepilot.team.yaml
Projects:
  - [enabled] platform-web
    project: /srv/issuepilot-config/projects/platform-web.yaml
    profile: /srv/issuepilot-config/workflows/default-web.md
    effective workflow: ok
```

`render-workflow` 用于排障和 review，输出编译后的 workflow，不输出 secret。

## 10. 实验期切换策略

当前没有正式应用，不需要兼容层。切换策略是破坏式收敛：

1. `projects[].workflow` 从 team config schema 中移除。
2. `projects[].project` 和 `projects[].workflow_profile` 成为必填字段。
3. repo-owned `WORKFLOW.md` 不再作为 team mode 输入。
4. 测试 fixture、README/USAGE 和 runbook 一次性改成中心配置写法。
5. 如需本地排障，使用 `render-workflow` 查看 effective workflow，而不是回退到旧
   `WORKFLOW.md`。

验收重点：

- `validate --config` 能稳定输出 effective workflow。
- daemon 使用中心配置可以完成完整 issue run。
- dashboard 能展示 project source 和 profile source。
- 配置错误按 dotted path 指向中心配置文件、project file 或 profile file。

## 11. 风险与处理

| 风险 | 处理 |
| --- | --- |
| 中心配置仓库变成瓶颈 | 通过 profile 复用、project file 拆分和 code review 降低冲突 |
| 项目差异过多导致 profile 失效 | 允许 project file 覆盖运行参数，但高风险运行字段仍锁定 |
| 配置来源变复杂 | `validate --config --project` 和 `render-workflow` 必须展示来源链 |
| 业务 repo 需要自描述 | 支持 `.issuepilot/project.yaml` 薄文件，但不是完整 workflow |
| 高风险运行字段被 project override 绕过 | 字段白名单 + schema 校验 + dotted path 错误 |

## 12. 推荐决策

IssuePilot V2 后续应采用“中心配置管理 workflow，业务 repo 只保留项目事实”的模型。

由于仍处于实验阶段，team mode 不需要保留 `projects[].workflow` 兼容路径。推荐入口直接变为：

```text
issuepilot-config/issuepilot.team.yaml
  -> workflows/*.md
  -> projects/*.yaml
  -> effective WorkflowConfig
```

这能把团队运行策略、agent 行为和实验期运行护栏放到一个可 review、可回滚、可验证的位置，
同时避免为旧实验 schema 增加额外兼容成本。
