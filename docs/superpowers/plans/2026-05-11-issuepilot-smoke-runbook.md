# IssuePilot 真实 Smoke Runbook

日期：2026-05-12
对应 spec：[`docs/superpowers/specs/2026-05-11-issuepilot-design.md`](../specs/2026-05-11-issuepilot-design.md) §18.3
对应 plan：[`2026-05-11-issuepilot-implementation-plan.md`](./2026-05-11-issuepilot-implementation-plan.md) Task 8.5

## 目标

任何工程师在 30 分钟内可以：

1. 准备一个一次性的 GitLab 测试项目；
2. 启动本机 IssuePilot（orchestrator + dashboard）；
3. 触发一个真实的 ai-ready Issue；
4. 对照 spec §18.3 的 10 个验收点逐一勾选。

跑通即代表 P0 端到端闭环成立。Fakes E2E 已经覆盖了协议层（见
`tests/e2e/`），本 runbook 关注**真实 GitLab API + 真实 Codex
app-server** 这两个外部系统是否能在本机闭环。

> 不要拿生产仓库做 smoke。请用一次性 sandbox 项目。

---

## 0. 准备

### 0.1 工具版本

- Node `>=22 <23`
- pnpm `10.x`（仓库已经声明 `packageManager: pnpm@10.x`，用 corepack 即可）
- Git `>=2.40`
- Codex CLI 已登录，能跑 `codex app-server`（注意是 `app-server`
  子命令，不是默认的 TUI）

跑一次 `pnpm exec issuepilot doctor` 验证（`apps/orchestrator/dist/bin.js`
build 后即可调用）：

```bash
pnpm -F @issuepilot/orchestrator build
pnpm exec issuepilot doctor
```

期望全部 `[OK]`。

### 0.2 创建 GitLab sandbox 项目

1. 在公司 GitLab（或 gitlab.com）建立一个 `group/issuepilot-smoke`
   私有项目，从 README-only 模板创建。
2. 在项目下创建以下 label（颜色随意）：
   - `ai-ready`
   - `ai-running`
   - `human-review`
   - `ai-rework`
   - `ai-failed`
   - `ai-blocked`
3. 项目 Settings → Access Tokens 创建一个 **Project Access Token**
   或 **Group Access Token**：
   - 名称：`issuepilot-smoke`
   - 角色：`Maintainer`（需要 push 分支 + 改 label + 写 note + 开 MR）
   - 权限：`api`, `read_repository`, `write_repository`
   - 复制 token，下面 `GITLAB_TOKEN` 用它。

### 0.3 SSH key

确保本机 `~/.ssh` 有能 push 到 sandbox 项目的 key
（`ssh -T git@<gitlab-host>` 能认到你）。orchestrator 通过
`workflow.git.repo_url` 配置的 git URL 做镜像/push，credentials
不会通过 token 走 https。

---

## 1. 配置 `.agents/workflow.md`

在 sandbox 项目里新建文件 `.agents/workflow.md`（与本仓库无关，是
**目标项目**里的文件），内容参考 spec §6：

```md
---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/issuepilot-smoke"
  token_env: "GITLAB_TOKEN"
  active_labels:
    - ai-ready
    - ai-rework
  running_label: ai-running
  handoff_label: human-review
  failed_label: ai-failed
  blocked_label: ai-blocked

workspace:
  root: "~/.issuepilot/workspaces"
  strategy: worktree
  repo_cache_root: "~/.issuepilot/repos"

git:
  repo_url: "git@gitlab.example.com:group/issuepilot-smoke.git"
  base_branch: main
  branch_prefix: ai

agent:
  runner: codex-app-server
  max_concurrent_agents: 1
  max_turns: 10
  max_attempts: 1
  retry_backoff_ms: 30000

codex:
  command: "codex app-server"
  approval_policy: never
  thread_sandbox: workspace-write
  turn_timeout_ms: 3600000
  turn_sandbox_policy:
    type: workspaceWrite

poll_interval_ms: 10000
---

你是当前仓库的 AI 工程师。

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
URL: {{ issue.url }}

Description:
{{ issue.description }}

要求：
1. 阅读相关代码再开始编辑。
2. 工作只能落在提供的 workspace 内。
3. 完成 Issue 要求的修改。
4. 提交代码并创建/更新 Merge Request。
5. 回写 Issue 评论，说明实现、验证、风险、MR 链接。
6. 成功后把 Issue 移交到 human-review。
7. 缺少信息/权限/密钥时打 ai-blocked 并解释。
```

把它 push 到 `main`：

```bash
git checkout -b chore/issuepilot-workflow
mkdir -p .agents
$EDITOR .agents/workflow.md
git add .agents/workflow.md
git commit -m "chore(issuepilot): seed workflow.md"
git push -u origin chore/issuepilot-workflow
# 然后在 GitLab 上 fast-forward 合到 main，或直接给自己开 MR 合并
```

---

## 2. 在本机启动 IssuePilot

### 2.1 准备本仓库

```bash
cd /path/to/issuepilot
pnpm install
pnpm -w turbo run build
```

> 第一次跑 smoke 之前 **必须** build orchestrator，因为
> `pnpm smoke` 会启动 `apps/orchestrator/dist/bin.js`。

### 2.2 拷贝目标项目 workflow 路径

```bash
mkdir -p ~/issuepilot-smoke
git clone git@gitlab.example.com:group/issuepilot-smoke.git \
  ~/issuepilot-smoke
WORKFLOW_PATH="$HOME/issuepilot-smoke/.agents/workflow.md"
```

### 2.3 启动 orchestrator + dashboard

终端 A：

```bash
export GITLAB_TOKEN="<token>"
pnpm smoke --workflow "$WORKFLOW_PATH"
```

成功输出形如：

```text
[smoke] starting orchestrator daemon on 127.0.0.1:4738…
======================================================
 IssuePilot daemon ready
------------------------------------------------------
 API:        http://127.0.0.1:4738
 Dashboard:  http://localhost:3000
 Workflow:   /home/you/issuepilot-smoke/.agents/workflow.md
 Project:    group/issuepilot-smoke
 Poll every: 10000ms
 Concurrency:1
------------------------------------------------------
 Walk through the §18.3 smoke checklist now. Press Ctrl+C to stop.
======================================================
```

`Ctrl+C` 会优雅退出 daemon。

终端 B：

```bash
pnpm dev:dashboard
```

打开 `http://localhost:3000`，应该能看到 orchestrator 概览页。

> 如果端口冲突：`pnpm smoke --workflow ... --port 4839 \
> --dashboard-url http://localhost:3000`。

---

## 3. 触发 ai-ready Issue

在 GitLab sandbox 项目里：

1. 新建一个简单 Issue，例如「在 README 末尾追加一段
   `## Smoke Test {{ today's date }}`」。
2. 打上 `ai-ready` label。
3. 不要 assignee 给你自己；orchestrator 会接管。

约 10s 后（`poll_interval_ms`）你应该会看到：

- Dashboard runs 列表新出现一行；
- Run 详情 timeline 开始记录 `run_started`、`run_claimed`、
  `tool_call_*`、`note_handoff` 等事件；
- terminal A 滚动 orchestrator 日志。

---

## 4. §18.3 验收清单

每项确认后在下面打勾。任何一项失败，停下排查，参考
`.codex/skills/debug/SKILL.md`。

- [ ] **1. Issue 创建 + `ai-ready` 已加 label**。GitLab 上能看到，
      dashboard 也展示 issue iid。
- [ ] **2. orchestrator 自动拾取 issue**。dashboard runs 表新增一行，
      `status` 由 `pending` → `running`。
- [ ] **3. worktree 已创建**。`ls -lh ~/.issuepilot/workspaces/` 里
      多出一个 `group__issuepilot-smoke/<iid>` 目录。
- [ ] **4. Codex app-server run 起来**。
      `ps aux | grep "codex app-server"` 看到子进程；timeline 里
      有 `codex_thread_started`、`codex_turn_started` 事件。
- [ ] **5. branch push**：`git ls-remote git@gitlab.example.com:...`
      或在 GitLab Repository → Branches 里看到 `ai/<issue-iid>-*` 分支。
- [ ] **6. MR 创建**：GitLab Merge Requests 列表新增一条 draft MR，
      `Source` = AI 分支，`Target` = `main`。
- [ ] **7. Issue note**：Issue discussion 里有 IssuePilot 写的工作日志
      note（含实现、验证、MR 链接、可能的风险）。
- [ ] **8. label `human-review` 已切换**：GitLab Issue 上原 `ai-ready` /
      `ai-running` 被替换为 `human-review`。
- [ ] **9. dashboard timeline 完整**：run 详情页能看到
      `run_started → claim_succeeded → workspace_ready →
      codex_thread_started → tool_call_* → branch_pushed →
      merge_request_opened → note_handoff → run_completed`，
      时间线无空洞、无空 redact。
- [ ] **10. workspace + logs 保留**：成功 run 之后
      `~/.issuepilot/workspaces/group__issuepilot-smoke/<iid>/` 仍在；
      `~/.issuepilot/workspaces/.issuepilot/events/group__issuepilot-smoke/<iid>.jsonl`
      存有完整事件流；`.issuepilot/logs/issuepilot.log` 有最近 50 行
      内容。

10 项全过 = MVP §21 闭环验证 ✅。

---

## 5. 失败 / blocked 场景验证（可选 + 推荐）

跑完上面 10 项之后，可以拿一份新 issue 复现失败路径：

- 把 `agent.max_attempts` 改为 `1`，让 Codex 故意返回错误（例如
  prompt 强制 `git push` 一个不存在的 ref），观察 label 是否切到
  `ai-failed`，note 是否写错误原因。
- 临时把 GitLab token 改成只读，观察 label 是否切到 `ai-blocked`，
  并且 orchestrator 没有疯狂 retry。

Fakes 已经覆盖了这两条路径（`tests/e2e/blocked-and-failed.test.ts`），
真实跑一次只是为了验证 GitLab 真实响应码与本地分类映射一致。

---

## 6. 清理

```bash
# 终端 A
Ctrl+C        # 关掉 daemon
# 删除一次性 workspace
rm -rf ~/.issuepilot/workspaces/group__issuepilot-smoke
# 删除一次性 mirror
rm -rf ~/.issuepilot/repos/group__issuepilot-smoke
# GitLab 上：把 issue close + 删 MR + 删 token
```

`~/.issuepilot/state` 里只有运行时索引，可以保留，下次 smoke 不
影响。

---

## 7. 常见问题

- **`[OK] codex app-server` 但 timeline 里看不到 codex_thread_started？**
  90% 是 `codex.command` 没指到正确的二进制。`which codex` 查一下
  绝对路径，或用 `command: "/Users/you/.local/bin/codex app-server"`。

- **`Could not resolve remote.origin` / push 卡住？**
  Workspace mirror 通过 `git clone --mirror` 创建，但 push 不能走
  mirror。本仓库已经在 `packages/workspace/src/mirror.ts` 修过
  `remote.origin.mirror=false` + 配置 fetch refspec。如果还有问题，
  手动 `rm -rf ~/.issuepilot/repos/<slug>` 让 IssuePilot 重新拉。

- **403 / 401**：`GITLAB_TOKEN` 没 export，或者 token 没 `api` scope，
  或 sandbox 项目对该 token 不可见。

- **dashboard 401 / CORS**：dashboard 走的是 `http://127.0.0.1:4738`，
  和 `--host` 必须一致。如果你跑在容器/远程机器上，临时让
  `--host 0.0.0.0`（`pnpm smoke` 会把 `--host` 透传给 orchestrator
  CLI 的 `--host`，daemon 会真正绑到该地址；同时记得让 dashboard 的
  `NEXT_PUBLIC_API_BASE` 指向同一地址）。

- **`pnpm smoke` 卡在 readiness 失败**：如果 readiness 探测失败，
  smoke wrapper 会发 SIGTERM 给 daemon 然后等最多 5s。仍未退出会自动
  升级到 SIGKILL，所以命令一定会返回控制权（不会无限 hang）。
