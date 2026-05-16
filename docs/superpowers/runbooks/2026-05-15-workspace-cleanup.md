# Runbook：Workspace Cleanup（V2 Phase 5）

最后更新：2026-05-16
负责人：IssuePilot 平台值班
对应 spec：`docs/superpowers/specs/2026-05-16-issuepilot-v2-phase5-workspace-retention-design.md`
对应实施计划：`docs/superpowers/plans/2026-05-15-issuepilot-v2-workspace-retention.md`

本 runbook 面向操作员，描述 `~/.issuepilot` workspace 自动清理的日常操作、诊断与回滚步骤。Phase 5 的 cleanup 路径由 orchestrator 主循环周期性触发，所有 cleanup 行为都会落到 event log，可在 dashboard 或 `/api/events?type=workspace_cleanup_*` 查询。

---

## 1. 心智模型

cleanup 一定遵循的三条不可妥协的约束（来自 spec §11 / §5）：

1. **active run 永不清理。** orchestrator 把当前 `claimed / running / retrying / stopping` 状态的 run 标记为 `active`，无论其 workspace 多老都不会进入 `plan.delete`。
2. **未到期的 failure 现场永不清理。** 即便总容量超过 `max_workspace_gb`，已超量的容量也只能压缩到「已过期的 terminal run」中。容量从来不能凌驾于 forensics 保留期之上。
3. **失败时不阻塞后续删除。** 单条 `rm` 失败（权限、忙占用、被人手动持有）只会写一条 `workspace_cleanup_failed`，整轮 cleanup 继续推进。

工作流：

```
loop tick (每 retention.cleanup_interval_ms)
  → enumerateWorkspaceEntries(real fs)
  → planWorkspaceCleanup(纯函数)
  → workspace_cleanup_planned 事件
  → fs.rm() 逐条删除
    └─ 成功 → workspace_cleanup_completed
    └─ 失败 → workspace_cleanup_failed
```

---

## 2. 决策树：常规 cleanup vs 强制 cleanup

```
disk pressure?
├── 否：让 orchestrator 自动 cleanup（默认行为）
└── 是：
    ├── 想立刻预览要删什么？
    │    └── 跑 dry-run（§3）。若结果可接受，等下一个 cleanup tick；
    │        若不够，调小 retention.cleanup_interval_ms 或者重启 daemon。
    │
    ├── 想立刻删？
    │    └── 不能强制删 active run / 保留期内 failure。
    │       优先把 `successful_run_days` 调短（如 3 天），或
    │       临时调小 `max_workspace_gb` 让 planner 把可删的全部列出。
    │       手动 rm 必须先 `git worktree prune`，再走下面的回滚预案。
    │
    └── 想关掉？
         └── 把 `retention.cleanup_interval_ms` 调到一个非常大的值
            （如 `31_536_000_000`，等于 1 年）并 reload。Phase 5
             不支持完全禁用清理（spec §5：cleanup 必须可审计）。
```

---

## 3. `issuepilot doctor --workspace` dry-run

`doctor` 子命令带 `--workspace` 标志会运行 cleanup planner 但**绝不**触碰文件系统。dry-run 出于安全考虑把所有目录都视为 `unknown`（因为没有正在运行的 daemon 提供 RuntimeState），因此输出里 `will delete` 通常为 `0` —— 这是符合预期的；它的价值是让你看到 workspace 总容量、目录数量与 retention 上限。

```bash
pnpm --filter @issuepilot/orchestrator exec node dist/cli.js \
  doctor --workspace --workflow ./workflow.yaml
```

典型输出：

```
Workspace cleanup dry-run
  workspace root: /Users/ops/.issuepilot/workspaces
  entries: 24
  total usage: 18.732 GB (cap 50 GB)
  will delete: 0
  keep failure markers: 0
```

字段含义：

- `entries`：planner 看到的 project/run 目录数。
- `total usage`：实际占用（粗略 `du`，与 GitHub Actions 风格的 `du -sh` 一致）。
- `will delete: 0`：dry-run 总为 0，**真实** delete 数请订阅 `workspace_cleanup_planned` 事件。

> 当你想看 daemon 当下真实想删什么，使用：
>
> ```bash
> curl -sS "$ISSUEPILOT_API/api/events?type=workspace_cleanup_planned&limit=1" | jq
> ```

---

## 4. 诊断 `workspace_cleanup_failed`

每一条 failed 事件 `data.reason` 给出粗分类：

| `data.reason`      | 含义                         | 建议处理                                                                                                 |
| ------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `enumerate_failed` | 整个 workspace root 读取失败 | 检查 `workspace.root` 路径是否存在；权限；磁盘是否 read-only。                                           |
| `stat_failed`      | 单个目录 `stat` 失败         | 通常是 race（目录刚被人删）或者权限。等下一轮 cleanup 再观察。                                           |
| `rm_failed`        | 单个 `fs.rm` 失败            | 看 `data.message`：`EACCES` → 权限；`EBUSY` → 仍被进程持有；`ENOTEMPTY` 通常意味着含挂载点，需手动卸载。 |

定位步骤：

1. 拿到事件 `data.workspacePath`。
2. `ls -lah <workspacePath>` 看实际权限与持有者。
3. `lsof +D <workspacePath>` 看是否被某个 codex 进程或终端持有。
4. 如果是 git worktree 残留：

   ```bash
   cd <repo-cache-root>
   git worktree prune
   git worktree list
   ```

5. 仍失败 → 升级到平台值班，附上 `data.workspacePath`、上一次 `workspace_cleanup_planned` payload、`ls -la` 输出。

---

## 5. 回滚预案

**场景 A：误把 `successful_run_days` 调到 1，导致大量未达终态的 worktree 被清理。**

- 立即把配置改回去（`successful_run_days >= 7`），重新加载 workflow（修改文件即可触发 hot reload）。
- 对每个被删的 run：
  - `mirror` 仍在，从 `git.repo_url` 重新克隆并 `git worktree add` 到 workspace 即可恢复源码视图。
  - 若该 run 已有 MR，IssuePilot 在下一个 poll 周期会通过 GitLab MR 状态 + workpad note 重新 reconcile，不会丢失 issue 状态。

**场景 B：cleanup 把还在跑的 codex 工作目录干掉了。**

- 这是契约 bug（spec §5：active run 永不清理）。
- 立即在 `apps/orchestrator/src/orchestrator/loop.ts` 入口加上「禁用 cleanup」flag 并重启 daemon，避免二次破坏。
- 在 GitLab 上把对应 issue 打回 `ai-rework`（带 `human-review` 标签也行），让 IssuePilot 在下一个 poll 重新申领。
- 修复完后补上回归测试，覆盖出现 race 的特定 status 组合。

**场景 C：dry-run 报告了非预期数字（如 `entries: 0`）。**

- 多半是 `workflow.workspace.root` 配错了。`doctor` 输出第一行会打印实际 root。
- 修正 workflow → 重新 dry-run。

---

## 6. 操作前自检清单

每次准备调整 retention 配置或手动触发 cleanup，先做一遍：

- [ ] `workspace_cleanup_planned` 最近一次事件的 `data.totalBytes` / `data.retainBytes` 已确认。
- [ ] dashboard service header 的 `Workspace usage` 与 `Next cleanup` 与你的认知一致。
- [ ] 没有正在跑的 `running` / `retrying` run（`/api/runs?status=running` 为空），或者你已确认它们的 workspace 不会被本次操作触及。
- [ ] 准备好了回滚 plan（场景 A/B/C）。

---

## 7. 已知限制（Phase 5 不解决）

- 不会清理 GitLab 远端 `ai/*` branch（spec §4：留给后续 release 管理任务）。
- 不会把要删除的 workspace 归档到 S3 或其它远端存储。
- 不支持多 host 共享 workspace 的清理协议（V3 多 worker 范围）。

如需上述能力，提交 RFC 走 V3 设计流程。
