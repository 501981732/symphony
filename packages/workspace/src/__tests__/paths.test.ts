import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { slugify, assertWithinRoot, branchName } from "../paths.js";

describe("slugify", () => {
  it("converts to lowercase and keeps only [a-z0-9-]", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
  });

  it("collapses multiple hyphens", () => {
    expect(slugify("foo---bar")).toBe("foo-bar");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("--foo-bar--")).toBe("foo-bar");
  });

  it("returns 'untitled' for empty or whitespace-only input", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("   ")).toBe("untitled");
    expect(slugify("!!!")).toBe("untitled");
  });

  it("handles Chinese characters by stripping them", () => {
    expect(slugify("修复登录bug")).toBe("bug");
  });

  it("respects maxLen", () => {
    const long = "a".repeat(100);
    const result = slugify(long, 10);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it("trims trailing hyphen after truncation", () => {
    const result = slugify("abc-defgh", 4);
    expect(result).not.toMatch(/-$/);
  });
});

describe("assertWithinRoot", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("does not throw when child is inside root", async () => {
    const child = path.join(tmpRoot, "sub", "dir");
    fs.mkdirSync(child, { recursive: true });
    await expect(assertWithinRoot(child, tmpRoot)).resolves.toBeUndefined();
  });

  it("throws WorkspacePathError when child escapes root", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ws-outside-"));
    try {
      await expect(assertWithinRoot(outside, tmpRoot)).rejects.toMatchObject({
        name: "WorkspacePathError",
      });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("throws WorkspacePathError for symlink escape", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ws-outside-"));
    const link = path.join(tmpRoot, "evil-link");
    fs.symlinkSync(outside, link);
    try {
      await expect(assertWithinRoot(link, tmpRoot)).rejects.toMatchObject({
        name: "WorkspacePathError",
      });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      fs.unlinkSync(link);
    }
  });

  it("throws WorkspacePathError for path traversal with ..", async () => {
    const traversal = path.join(tmpRoot, "sub", "..", "..", "etc");
    await expect(assertWithinRoot(traversal, tmpRoot)).rejects.toMatchObject({
      name: "WorkspacePathError",
    });
  });
});

describe("branchName", () => {
  it("returns prefix/iid-titleSlug", () => {
    expect(branchName({ prefix: "ai", iid: 42, titleSlug: "fix-login" })).toBe(
      "ai/42-fix-login",
    );
  });

  it("throws if result contains ..", () => {
    expect(() =>
      branchName({ prefix: "ai", iid: 1, titleSlug: "a..b" }),
    ).toThrow();
  });

  it("throws if result exceeds 200 characters", () => {
    expect(() =>
      branchName({ prefix: "ai", iid: 1, titleSlug: "a".repeat(250) }),
    ).toThrow();
  });

  it("strips reserved characters from result", () => {
    const result = branchName({
      prefix: "ai",
      iid: 5,
      titleSlug: "my-feature",
    });
    expect(result).not.toMatch(/[~:^\\]/);
    expect(result).toBe("ai/5-my-feature");
  });
});
