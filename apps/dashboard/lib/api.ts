import type {
  IssuePilotEvent,
  OrchestratorStateSnapshot,
  RunDetailResponse,
  RunRecord,
  RunStatus,
} from "@issuepilot/shared-contracts";

const DEFAULT_API_BASE = "http://127.0.0.1:4738";

/**
 * Resolve the orchestrator HTTP API base URL.
 *
 * Order of precedence:
 *   1. `NEXT_PUBLIC_API_BASE` (exposed to the browser by Next.js)
 *   2. Hard default `http://127.0.0.1:4738` per spec §14
 *
 * Trailing slashes are stripped so callers can safely concatenate paths.
 */
export function resolveApiBase(): string {
  const raw = process.env.NEXT_PUBLIC_API_BASE;
  const base = raw && raw.length > 0 ? raw : DEFAULT_API_BASE;
  return base.replace(/\/+$/, "");
}

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
  }
}

export interface ApiGetOptions {
  signal?: AbortSignal;
}

export async function apiGet<T>(
  path: string,
  opts: ApiGetOptions = {},
): Promise<T> {
  const url = `${resolveApiBase()}${path}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: opts.signal,
    cache: "no-store",
  });

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => null);
    }
    throw new ApiError(
      `GET ${path} failed: HTTP ${response.status}`,
      response.status,
      body,
    );
  }

  return (await response.json()) as T;
}

export function getState(
  opts: ApiGetOptions = {},
): Promise<OrchestratorStateSnapshot> {
  return apiGet<OrchestratorStateSnapshot>("/api/state", opts);
}

export interface ListRunsParams {
  status?: RunStatus | readonly RunStatus[];
  limit?: number;
}

export function listRuns(
  params: ListRunsParams = {},
  opts: ApiGetOptions = {},
): Promise<RunRecord[]> {
  const search = new URLSearchParams();
  if (params.status) {
    const value = Array.isArray(params.status)
      ? params.status.join(",")
      : (params.status as string);
    if (value.length > 0) search.set("status", value);
  }
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    search.set("limit", String(params.limit));
  }
  const query = search.toString();
  return apiGet<RunRecord[]>(`/api/runs${query ? `?${query}` : ""}`, opts);
}

export function getRunDetail(
  runId: string,
  opts: ApiGetOptions = {},
): Promise<RunDetailResponse> {
  return apiGet<RunDetailResponse>(
    `/api/runs/${encodeURIComponent(runId)}`,
    opts,
  );
}

export interface ListEventsParams {
  runId: string;
  limit?: number;
  offset?: number;
}

export function listEvents(
  params: ListEventsParams,
  opts: ApiGetOptions = {},
): Promise<IssuePilotEvent[]> {
  const search = new URLSearchParams({ runId: params.runId });
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    search.set("limit", String(params.limit));
  }
  if (typeof params.offset === "number" && Number.isFinite(params.offset)) {
    search.set("offset", String(params.offset));
  }
  return apiGet<IssuePilotEvent[]>(`/api/events?${search.toString()}`, opts);
}

export function eventStreamUrl(runId?: string): string {
  const base = `${resolveApiBase()}/api/events/stream`;
  if (!runId) return base;
  const search = new URLSearchParams({ runId });
  return `${base}?${search.toString()}`;
}
