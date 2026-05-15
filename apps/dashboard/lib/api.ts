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
  /**
   * The orchestrator `code` field (e.g. `invalid_status`, `cancel_failed`,
   * `actions_unavailable`). Populated when the response body is a JSON
   * object containing a string `code`; otherwise undefined.
   */
  public readonly code: string | undefined;
  /**
   * Secondary discriminator surfaced by the `stop` action when cancel
   * fails (one of `cancel_timeout` / `cancel_threw` / `not_registered`).
   */
  public readonly reason: string | undefined;
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    if (body && typeof body === "object") {
      const data = body as { code?: unknown; reason?: unknown };
      if (typeof data.code === "string") this.code = data.code;
      if (typeof data.reason === "string") this.reason = data.reason;
    }
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
  /**
   * When true, sends `?includeArchived=true` so the orchestrator returns
   * runs whose `archivedAt` field is set. Operator-archived runs are
   * hidden by default in both the orchestrator response and dashboard
   * tables; flip this to true to surface them under "Show archived".
   */
  includeArchived?: boolean;
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
  if (params.includeArchived === true) {
    search.set("includeArchived", "true");
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

export interface OperatorActionOptions {
  /**
   * Optional operator identity sent as the `x-issuepilot-operator` header.
   * When omitted, the dashboard relies on the orchestrator's default
   * `"system"` so V2 P0 (no auth) and V3+ (real user identity) share the
   * same wire contract.
   */
  operator?: string;
  signal?: AbortSignal;
}

async function postRunAction(
  runId: string,
  action: "retry" | "stop" | "archive",
  opts: OperatorActionOptions = {},
): Promise<{ ok: true }> {
  const path = `/api/runs/${encodeURIComponent(runId)}/${action}`;
  const url = `${resolveApiBase()}${path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.operator && opts.operator.length > 0) {
    headers["x-issuepilot-operator"] = opts.operator;
  }
  const init: RequestInit = {
    method: "POST",
    headers,
    cache: "no-store",
  };
  if (opts.signal) init.signal = opts.signal;
  const response = await fetch(url, init);
  if (response.ok) {
    return { ok: true };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = await response.text().catch(() => null);
  }
  throw new ApiError(
    `POST ${path} failed: HTTP ${response.status}`,
    response.status,
    body,
  );
}

export function retryRun(
  runId: string,
  opts: OperatorActionOptions = {},
): Promise<{ ok: true }> {
  return postRunAction(runId, "retry", opts);
}

export function stopRun(
  runId: string,
  opts: OperatorActionOptions = {},
): Promise<{ ok: true }> {
  return postRunAction(runId, "stop", opts);
}

export function archiveRun(
  runId: string,
  opts: OperatorActionOptions = {},
): Promise<{ ok: true }> {
  return postRunAction(runId, "archive", opts);
}
