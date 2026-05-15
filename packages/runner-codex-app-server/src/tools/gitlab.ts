export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  handler: (args: unknown) => Promise<unknown>;
}

interface IssueRef {
  id: string;
  iid: number;
  title: string;
  url: string;
  projectId: string;
  labels: string[];
}

interface GitLabAdapterSlice {
  getIssue(iid: number): Promise<IssueRef & { description: string }>;
  transitionLabels(
    iid: number,
    opts: { add: string[]; remove: string[]; requireCurrent?: string[] },
  ): Promise<{ labels: string[] }>;
  createIssueNote(iid: number, body: string): Promise<{ id: number }>;
  updateIssueNote(
    iid: number,
    noteId: number,
    opts: { body: string },
  ): Promise<void>;
  createMergeRequest(input: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
    issueIid: number;
  }): Promise<{ id: number; iid: number; webUrl: string }>;
  updateMergeRequest(
    mrIid: number,
    input: Partial<{
      title: string;
      description: string;
      targetBranch: string;
    }>,
  ): Promise<void>;
  getMergeRequest(
    mrIid: number,
  ): Promise<{ iid: number; webUrl: string; state: string }>;
  listMergeRequestNotes(
    mrIid: number,
  ): Promise<Array<{ id: number; body: string; author: string }>>;
  getPipelineStatus(
    ref: string,
  ): Promise<
    "running" | "success" | "failed" | "pending" | "canceled" | "unknown"
  >;
}

async function safe(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const category =
      err && typeof err === "object" && "category" in err
        ? (err as { category: string }).category
        : "unknown";
    return { ok: false, error: { category, message } };
  }
}

export function createGitLabTools(
  adapter: GitLabAdapterSlice,
  issue: IssueRef,
): ToolDefinition[] {
  return [
    {
      name: "gitlab_get_issue",
      description: `Get the current issue (iid=${issue.iid})`,
      inputSchema: { type: "object", properties: {} },
      handler: () => safe(() => adapter.getIssue(issue.iid)),
    },
    {
      name: "gitlab_update_issue_labels",
      description: "Add or remove labels on the current issue",
      inputSchema: {
        type: "object",
        properties: {
          add: { type: "array", items: { type: "string" } },
          remove: { type: "array", items: { type: "string" } },
        },
        required: ["add", "remove"],
      },
      handler: (args) => {
        const a = args as { add: string[]; remove: string[] };
        return safe(() =>
          adapter.transitionLabels(issue.iid, {
            add: a.add,
            remove: a.remove,
          }),
        );
      },
    },
    {
      name: "gitlab_create_issue_note",
      description: "Create a note on the current issue",
      inputSchema: {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
      },
      handler: (args) => {
        const a = args as { body: string };
        return safe(() => adapter.createIssueNote(issue.iid, a.body));
      },
    },
    {
      name: "gitlab_update_issue_note",
      description: "Update an existing note on the current issue",
      inputSchema: {
        type: "object",
        properties: {
          noteId: { type: "number" },
          body: { type: "string" },
        },
        required: ["noteId", "body"],
      },
      handler: (args) => {
        const a = args as { noteId: number; body: string };
        return safe(() =>
          adapter.updateIssueNote(issue.iid, a.noteId, { body: a.body }),
        );
      },
    },
    {
      name: "gitlab_create_merge_request",
      description: "Create a merge request linked to the current issue",
      inputSchema: {
        type: "object",
        properties: {
          sourceBranch: { type: "string" },
          targetBranch: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["sourceBranch", "targetBranch", "title"],
      },
      handler: (args) => {
        const a = args as {
          sourceBranch: string;
          targetBranch: string;
          title: string;
          description?: string;
        };
        return safe(() =>
          adapter.createMergeRequest({
            sourceBranch: a.sourceBranch,
            targetBranch: a.targetBranch,
            title: a.title,
            description: a.description ?? "",
            issueIid: issue.iid,
          }),
        );
      },
    },
    {
      name: "gitlab_update_merge_request",
      description: "Update an existing merge request",
      inputSchema: {
        type: "object",
        properties: {
          mrIid: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["mrIid"],
      },
      handler: (args) => {
        const a = args as {
          mrIid: number;
          title?: string;
          description?: string;
        };
        const updates: Partial<{ title: string; description: string }> = {};
        if (a.title !== undefined) updates.title = a.title;
        if (a.description !== undefined) updates.description = a.description;
        return safe(() => adapter.updateMergeRequest(a.mrIid, updates));
      },
    },
    {
      name: "gitlab_get_merge_request",
      description: "Get a merge request by iid",
      inputSchema: {
        type: "object",
        properties: { mrIid: { type: "number" } },
        required: ["mrIid"],
      },
      handler: (args) => {
        const a = args as { mrIid: number };
        return safe(() => adapter.getMergeRequest(a.mrIid));
      },
    },
    {
      name: "gitlab_list_merge_request_notes",
      description: "List notes on a merge request",
      inputSchema: {
        type: "object",
        properties: { mrIid: { type: "number" } },
        required: ["mrIid"],
      },
      handler: (args) => {
        const a = args as { mrIid: number };
        return safe(() => adapter.listMergeRequestNotes(a.mrIid));
      },
    },
    {
      name: "gitlab_get_pipeline_status",
      description: "Get pipeline status for a ref/branch",
      inputSchema: {
        type: "object",
        properties: { ref: { type: "string" } },
        required: ["ref"],
      },
      handler: (args) => {
        const a = args as { ref: string };
        return safe(() => adapter.getPipelineStatus(a.ref));
      },
    },
  ];
}
