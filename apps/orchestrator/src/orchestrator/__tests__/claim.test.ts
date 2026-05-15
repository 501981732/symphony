import { describe, it, expect, vi } from "vitest";
import { claimCandidates } from "../claim.js";
import { createRuntimeState } from "../../runtime/state.js";
import { createConcurrencySlots } from "../../runtime/slots.js";

function fakeGitlab(issues: Array<{ iid: number; labels: string[] }>) {
  return {
    listCandidateIssues: vi.fn(async () =>
      issues.map((i) => ({
        id: `gid://gitlab/Issue/${i.iid}`,
        iid: i.iid,
        title: `Issue ${i.iid}`,
        url: `https://gitlab.example.com/issues/${i.iid}`,
        projectId: "group/project",
        labels: i.labels,
      })),
    ),
    transitionLabels: vi.fn(async (_iid: number) => ({
      labels: ["ai-running"],
    })),
  };
}

describe("claimCandidates", () => {
  it("claims available candidates up to slot count", async () => {
    const gitlab = fakeGitlab([
      { iid: 1, labels: ["ai-ready"] },
      { iid: 2, labels: ["ai-ready"] },
      { iid: 3, labels: ["ai-ready"] },
    ]);
    const state = createRuntimeState();
    const slots = createConcurrencySlots(2);

    const claimed = await claimCandidates({
      gitlab,
      state,
      slots,
      activeLabels: ["ai-ready", "ai-rework"],
      runningLabel: "ai-running",
      excludeLabels: ["ai-running", "human-review", "ai-failed", "ai-blocked"],
    });

    expect(claimed).toHaveLength(2);
    expect(gitlab.transitionLabels).toHaveBeenCalledTimes(2);
    expect(state.listRuns("claimed")).toHaveLength(2);
  });

  it("returns empty when no candidates", async () => {
    const gitlab = fakeGitlab([]);
    const state = createRuntimeState();
    const slots = createConcurrencySlots(2);

    const claimed = await claimCandidates({
      gitlab,
      state,
      slots,
      activeLabels: ["ai-ready"],
      runningLabel: "ai-running",
      excludeLabels: [],
    });

    expect(claimed).toHaveLength(0);
  });

  it("skips claim conflicts gracefully", async () => {
    const gitlab = fakeGitlab([
      { iid: 1, labels: ["ai-ready"] },
      { iid: 2, labels: ["ai-ready"] },
    ]);
    gitlab.transitionLabels
      .mockResolvedValueOnce({ labels: ["ai-running"] })
      .mockRejectedValueOnce(new Error("claim_conflict"));

    const state = createRuntimeState();
    const slots = createConcurrencySlots(5);

    const claimed = await claimCandidates({
      gitlab,
      state,
      slots,
      activeLabels: ["ai-ready"],
      runningLabel: "ai-running",
      excludeLabels: [],
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.iid).toBe(1);
  });

  it("stamps RunRecord with projectId/name so V1 runs group on dashboard", async () => {
    const gitlab = fakeGitlab([{ iid: 11, labels: ["ai-ready"] }]);
    gitlab.transitionLabels.mockResolvedValue({ labels: ["ai-running"] });
    const state = createRuntimeState();
    const slots = createConcurrencySlots(2);

    const claimed = await claimCandidates({
      gitlab,
      state,
      slots,
      activeLabels: ["ai-ready"],
      runningLabel: "ai-running",
      excludeLabels: [],
      projectId: "default",
      projectName: "Default",
    });

    expect(claimed).toHaveLength(1);
    const run = state.getRun(claimed[0]!.runId);
    expect(run?.projectId).toBe("default");
    expect(run?.projectName).toBe("Default");
  });

  it("defaults projectId to 'default' when caller omits it", async () => {
    const gitlab = fakeGitlab([{ iid: 22, labels: ["ai-ready"] }]);
    gitlab.transitionLabels.mockResolvedValue({ labels: ["ai-running"] });
    const state = createRuntimeState();
    const slots = createConcurrencySlots(2);

    const claimed = await claimCandidates({
      gitlab,
      state,
      slots,
      activeLabels: ["ai-ready"],
      runningLabel: "ai-running",
      excludeLabels: [],
    });
    const run = state.getRun(claimed[0]!.runId);
    expect(run?.projectId).toBe("default");
    expect(run?.projectName).toBeUndefined();
  });

  it("returns empty when no slots available", async () => {
    const gitlab = fakeGitlab([{ iid: 1, labels: ["ai-ready"] }]);
    const state = createRuntimeState();
    const slots = createConcurrencySlots(1);
    slots.tryAcquire("existing");

    const claimed = await claimCandidates({
      gitlab,
      state,
      slots,
      activeLabels: ["ai-ready"],
      runningLabel: "ai-running",
      excludeLabels: [],
    });

    expect(claimed).toHaveLength(0);
  });
});
