import type { GitLabApi } from "./api-shape.js";
import type { GitLabClient } from "./client.js";

export interface CreateIssueNoteResult {
  id: number;
}

export interface WorkpadNote {
  id: number;
  body: string;
}

const NOTES_PER_PAGE = 100;
const ISSUEPILOT_RUN_MARKER = /^<!--\s*issuepilot:run(?::|=)[^>]+-->\s*$/;

export async function createIssueNote(
  client: GitLabClient<GitLabApi>,
  iid: number,
  body: string,
): Promise<CreateIssueNoteResult> {
  return client.request("issueNotes.create", async (api) => {
    const created = await api.IssueNotes.create(client.projectId, iid, body);
    return { id: created.id };
  });
}

export async function updateIssueNote(
  client: GitLabClient<GitLabApi>,
  iid: number,
  noteId: number,
  body: string,
): Promise<void> {
  await client.request("issueNotes.edit", async (api) => {
    await api.IssueNotes.edit(client.projectId, iid, noteId, { body });
  });
}

/**
 * Find the IssuePilot workpad note on an issue. Each run prefixes its first
 * line with `<!-- issuepilot:run=<runId> -->`; this lookup re-uses the same
 * note across attempts so the issue thread doesn't accumulate stale comments.
 *
 * GitLab "system" notes (label/state changes) are always skipped — they
 * cannot be edited by us anyway.
 */
export async function findWorkpadNote(
  client: GitLabClient<GitLabApi>,
  iid: number,
  marker: string,
): Promise<WorkpadNote | null> {
  return client.request("issueNotes.find", async (api) => {
    const notes = await api.IssueNotes.all(client.projectId, iid, {
      perPage: NOTES_PER_PAGE,
    });
    for (const n of notes) {
      if (n.system) continue;
      const body = typeof n.body === "string" ? n.body : "";
      if (firstLine(body) === marker) {
        return { id: n.id, body };
      }
    }
    return null;
  });
}

export async function findLatestIssuePilotWorkpadNote(
  client: GitLabClient<GitLabApi>,
  iid: number,
): Promise<WorkpadNote | null> {
  return client.request(
    "issueNotes.findLatestIssuePilotWorkpad",
    async (api) => {
      const notes = await api.IssueNotes.all(client.projectId, iid, {
        perPage: NOTES_PER_PAGE,
      });
      for (let index = notes.length - 1; index >= 0; index -= 1) {
        const note = notes[index];
        if (!note || note.system) continue;
        const body = typeof note.body === "string" ? note.body : "";
        if (ISSUEPILOT_RUN_MARKER.test(firstLine(body))) {
          return { id: note.id, body };
        }
      }
      return null;
    },
  );
}

function firstLine(body: string): string {
  const newlineAt = body.indexOf("\n");
  const head = newlineAt === -1 ? body : body.slice(0, newlineAt);
  return head.trim();
}
