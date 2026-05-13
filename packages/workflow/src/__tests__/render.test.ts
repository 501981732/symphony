import { describe, it, expect, vi } from "vitest";

import { renderPrompt } from "../render.js";
import type { PromptContext, PromptRenderLogger } from "../render.js";

function ctx(overrides: Partial<PromptContext> = {}): PromptContext {
  const base: PromptContext = {
    issue: {
      id: "gid://gitlab/Issue/1",
      iid: 42,
      identifier: "group/project#42",
      title: "Update README",
      description: "Bring the README in line with the new CLI.",
      labels: ["ai-ready", "documentation"],
      url: "https://gitlab.example.com/group/project/-/issues/42",
      author: "alice",
      assignees: ["alice", "bob"],
    },
    attempt: 1,
    workspace: { path: "/tmp/issuepilot/wd/42" },
    git: { branch: "ai/42-update-readme" },
  };
  return {
    issue: { ...base.issue, ...overrides.issue },
    attempt: overrides.attempt ?? base.attempt,
    workspace: { ...base.workspace, ...overrides.workspace },
    git: { ...base.git, ...overrides.git },
  };
}

describe("renderPrompt", () => {
  it("渲染 spec §6 规定的所有顶级变量", async () => {
    const tpl = [
      "id={{ issue.id }}",
      "iid={{ issue.iid }}",
      "identifier={{ issue.identifier }}",
      "title={{ issue.title }}",
      "description={{ issue.description }}",
      "labels={{ issue.labels | join: ',' }}",
      "url={{ issue.url }}",
      "author={{ issue.author }}",
      "assignees={{ issue.assignees | join: ',' }}",
      "attempt={{ attempt }}",
      "workspace.path={{ workspace.path }}",
      "git.branch={{ git.branch }}",
    ].join("\n");

    const out = await renderPrompt(tpl, ctx());
    expect(out).toContain("id=gid://gitlab/Issue/1");
    expect(out).toContain("iid=42");
    expect(out).toContain("identifier=group/project#42");
    expect(out).toContain("title=Update README");
    expect(out).toContain("description=Bring the README in line with the new CLI.");
    expect(out).toContain("labels=ai-ready,documentation");
    expect(out).toContain("url=https://gitlab.example.com/group/project/-/issues/42");
    expect(out).toContain("author=alice");
    expect(out).toContain("assignees=alice,bob");
    expect(out).toContain("attempt=1");
    expect(out).toContain("workspace.path=/tmp/issuepilot/wd/42");
    expect(out).toContain("git.branch=ai/42-update-readme");
  });

  it("未定义字段渲染为空串", async () => {
    const out = await renderPrompt("[{{ issue.nonexistent }}]", ctx());
    expect(out).toBe("[]");
  });

  it("未定义字段触发 logger.warn 并附路径", async () => {
    const logger: PromptRenderLogger = { warn: vi.fn() };
    await renderPrompt(
      "{{ issue.unknown_field }} {{ workspace.who_knows }}",
      ctx(),
      { logger },
    );

    expect(logger.warn).toHaveBeenCalled();
    const calls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const paths = calls.flatMap((args) =>
      args[1] && typeof args[1] === "object" && args[1] !== null
        ? [String((args[1] as Record<string, unknown>)["path"])]
        : [],
    );
    expect(paths).toContain("issue.unknown_field");
    expect(paths).toContain("workspace.who_knows");
  });

  it("运行时额外传入的字段不会进入 prompt 渲染上下文", async () => {
    const logger: PromptRenderLogger = { warn: vi.fn() };
    const unsafeContext = {
      ...ctx(),
      extra: "top-secret",
      issue: {
        ...ctx().issue,
        token: "glpat-should-not-render",
      },
    } as PromptContext;

    const out = await renderPrompt(
      "title={{ issue.title }} token={{ issue.token }} extra={{ extra }}",
      unsafeContext,
      { logger },
    );

    expect(out).toBe("title=Update README token= extra=");
    expect(logger.warn).toHaveBeenCalledWith(
      "prompt variable not found",
      expect.objectContaining({ path: "issue.token" }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "prompt variable not found",
      expect.objectContaining({ path: "extra" }),
    );
  });

  it("已定义但落地为空数组的字段不会触发 warn", async () => {
    const logger: PromptRenderLogger = { warn: vi.fn() };
    const c = ctx();
    c.issue.assignees = [];
    await renderPrompt("{{ issue.assignees | join: ',' }}", c, { logger });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("filesystem 类标签被禁用（{% include %}）", async () => {
    await expect(
      renderPrompt('{% include "../etc/passwd" %}', ctx()),
    ).rejects.toThrow();
  });

  it("filesystem 类标签被禁用（{% render %}）", async () => {
    await expect(
      renderPrompt('{% render "evil.liquid" %}', ctx()),
    ).rejects.toThrow();
  });

  it("不允许使用未定义 filter（strictFilters: true）", async () => {
    await expect(
      renderPrompt("{{ issue.title | nonexistent_filter }}", ctx()),
    ).rejects.toThrow();
  });

  it("`attempt` 顶层访问也能命中（与嵌套对象区分）", async () => {
    const out = await renderPrompt("attempt={{ attempt }}", ctx({ attempt: 3 }));
    expect(out).toBe("attempt=3");
  });
});
