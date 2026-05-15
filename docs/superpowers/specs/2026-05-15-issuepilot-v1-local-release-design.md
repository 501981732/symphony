# IssuePilot V1 本地稳定发布设计

日期：2026-05-15
状态：待用户评审
关联文档：

- `docs/superpowers/specs/2026-05-11-issuepilot-design.md`
- `docs/superpowers/specs/2026-05-15-issuepilot-gap-closure-design.md`
- `docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`
- `README.md`
- `README.zh-CN.md`

## 1. 背景

IssuePilot P0 已经完成 GitLab Issue 到 Codex app-server run、MR handoff、
human-review closure、事件记录和只读 dashboard 的本地闭环。P0 gap 收口后，
当前主要风险不再是核心功能缺失，而是“如何把这套本地闭环稳定、重复地跑起来”。

V1 的目标不是引入团队服务能力，也不是立刻做 npm 或 tarball 分发。当前使用者仍
以单人 source checkout 为主，因此 V1 应该把现有使用方式固化成一个可验证、可回滚、
文档清楚的本地稳定版本。

## 2. 目标

V1 交付一个 **stable source-checkout release**：

```text
git clone
pnpm install
pnpm build
pnpm smoke --workflow /path/to/target-project/WORKFLOW.md
pnpm dev:dashboard
```

V1 完成后，一个使用者应该能够：

1. 从仓库 checkout 指定 tag 或 commit。
2. 按 README / getting-started 在本地完成安装、构建和环境检查。
3. 用 `pnpm release:check` 跑完整本地 release gate。
4. 用 `pnpm smoke` 对真实 GitLab sandbox 做人工验收。
5. 遇到问题时按文档定位 auth、workflow、daemon、runner、workspace、event logs。
6. 如需回滚，切回上一 tag 或 commit 后重新安装构建。

## 3. 非目标

V1 不做以下内容：

- npm package、global install、`pnpm dlx` 或 standalone tarball。
- 多项目 workflow 配置。
- 团队共享 daemon 或多用户 dashboard。
- dashboard 写操作，例如 `retry`、`stop`、`archive run`。
- CI 失败自动回流到 `ai-rework`。
- 自动 merge MR。
- 正式的 `~/.issuepilot` 本地状态迁移指南。
- Docker / Kubernetes sandbox。
- Postgres / SQLite run history。

这些能力仍放到 V2 或更后续版本。

## 4. 分发形态

V1 采用 source-checkout 形态：

- 仓库根 `package.json` 仍可保持 `private: true`。
- root version 从 `0.0.0` 进入第一个本地稳定版本，例如 `0.1.0`。
- 用 git tag 表达版本边界，例如 `v0.1.0`。
- README 明确 source checkout 是 V1 支持路径。
- package 分发只作为 roadmap，不在 V1 实现。

这个选择降低 packaging 风险，避免在 CLI bin、workspace package export、dashboard
build assets 和 publish 权限上提前投入。

## 5. V1 Release Gate

新增统一检查命令：

```bash
pnpm release:check
```

它应该串行执行：

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm build`
5. `pnpm test`
6. `pnpm test:smoke`
7. `git diff --check`

如果局部脚本已经包含重复任务，可以在实现计划中优化为 turbo pipeline 或组合脚本，
但 V1 对外暴露的入口应是一个稳定的 `release:check`。

真实 GitLab smoke 不进入自动脚本，因为它依赖外部 GitLab sandbox、token、SSH key
和 Codex 登录态。V1 只要求 smoke runbook 提供固定 evidence 字段。

## 6. 版本和变更记录

V1 需要新增或更新：

- `CHANGELOG.md`
- README / README.zh-CN 的当前状态和 V1 说明
- getting-started 中的 source-checkout 使用路径
- smoke runbook 的 release evidence 字段

`CHANGELOG.md` 至少记录：

- `0.1.0` 版本目标
- P0 gap closure 摘要
- V1 source-checkout 支持边界
- 已知非目标
- 验证命令

## 7. 文档边界

V1 文档应保持这些说法一致：

- `WORKFLOW.md` 是目标仓库默认 workflow 文件。
- IssuePilot 仓库负责运行 orchestrator、dashboard 和 smoke wrapper。
- 目标项目仓库负责持有 `WORKFLOW.md` 和被 agent 修改的代码。
- `pnpm smoke` 启动 orchestrator daemon，并等待 API ready。
- dashboard 仍通过 `pnpm dev:dashboard` 单独启动。
- MR merge 由人类完成，IssuePilot 只负责 merged 后收尾。
- V1 不承诺 package install。
- V1 不要求本地状态迁移；单人试点期间如遇不可恢复状态，可以停止 daemon 后清理
  具体 workspace 或 repo cache。

## 8. 错误处理和回滚

V1 的回滚策略保持简单：

```bash
git fetch --tags
git checkout <previous-tag-or-commit>
pnpm install
pnpm build
```

如果本地 run 卡住或状态异常：

1. 停止 `pnpm smoke` / daemon。
2. 检查 `~/.issuepilot/state` 下对应 run record 和 event log。
3. 检查目标 GitLab Issue labels、handoff note、MR 状态。
4. 必要时手动移除 `ai-running`，切回 `ai-ready`、`ai-rework` 或人工处理。
5. 只有明确知道对应 workspace / repo cache 不再需要时，才手动清理相关目录。

这不是正式迁移指南，只是本地单人试点的排障边界。

## 9. 测试策略

V1 需要覆盖三层验证：

1. 自动检查：`pnpm release:check`。
2. 针对性测试：修改 package 时继续运行对应 `pnpm --filter ... test/typecheck`。
3. 人工真实 smoke：按 runbook 填写固定 evidence。

Release evidence 建议包含：

- Issue URL
- MR URL
- Dashboard run URL
- Handoff note 摘要
- Closing note 摘要
- 本地命令输出摘要
- 最终 labels / issue state
- 已知风险或人工介入点

## 10. 完成标准

V1 完成时应满足：

1. `package.json` 提供 `pnpm release:check`。
2. README / README.zh-CN / getting-started 与 V1 source-checkout 边界一致。
3. `CHANGELOG.md` 存在并记录 `0.1.0`。
4. smoke runbook 有固定 release evidence 模板。
5. 主设计 spec §20 与本 V1 设计一致。
6. `pnpm release:check` 本地通过。
7. PR 描述包含 V1 release gate 和未进入 V1 的能力清单。

