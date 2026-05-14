import { z } from "zod";

import type {
  DeviceCodeRequest,
  DeviceCodeResponse,
  OAuthTokenResponse,
} from "./types.js";

/**
 * Coarse-grained classification of all OAuth client failures. Mirrors RFC
 * 8628 §3.5 plus the few non-protocol categories we need (`transient`,
 * `invalid_client`, `unknown`).
 */
export type OAuthErrorCategory =
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "access_denied"
  | "invalid_grant"
  | "invalid_client"
  | "transient"
  | "unknown";

export interface OAuthErrorOptions {
  category: OAuthErrorCategory;
  retriable: boolean;
}

export class OAuthError extends Error {
  override name = "OAuthError";
  readonly category: OAuthErrorCategory;
  readonly retriable: boolean;

  constructor(message: string, opts: OAuthErrorOptions) {
    super(message);
    this.category = opts.category;
    this.retriable = opts.retriable;
  }
}

const NON_RETRIABLE: ReadonlySet<OAuthErrorCategory> = new Set([
  "authorization_pending",
  "slow_down",
  "expired_token",
  "access_denied",
  "invalid_grant",
  "invalid_client",
  "unknown",
]);

const RETRIABLE: ReadonlySet<OAuthErrorCategory> = new Set(["transient"]);

function categoryFromOAuthString(value: string): OAuthErrorCategory {
  switch (value) {
    case "authorization_pending":
    case "slow_down":
    case "expired_token":
    case "access_denied":
    case "invalid_grant":
    case "invalid_client":
      return value;
    default:
      return "unknown";
  }
}

function categoryRetriable(category: OAuthErrorCategory): boolean {
  if (RETRIABLE.has(category)) return true;
  if (NON_RETRIABLE.has(category)) return false;
  return false;
}

const DeviceCodeBodySchema = z
  .object({
    device_code: z.string().min(1),
    user_code: z.string().min(1),
    verification_uri: z.string().min(1),
    verification_uri_complete: z.string().min(1).optional(),
    expires_in: z.number().int().positive(),
    interval: z.number().int().nonnegative().default(5),
  })
  .loose();

const TokenBodySchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    token_type: z.string().min(1).default("Bearer"),
    scope: z.string().optional(),
    expires_in: z.number().int().positive(),
  })
  .loose();

const ErrorBodySchema = z
  .object({
    error: z.string().min(1).optional(),
    error_description: z.string().optional(),
  })
  .loose();

const DEFAULT_TIMEOUT_MS = 30_000;

export interface FetchDeps {
  fetch?: typeof fetch;
}

export interface PollDeps extends FetchDeps {
  /**
   * Sleep abstraction; defaults to `setTimeout`. Tests inject a synchronous
   * implementation so we can drive the polling loop without real timers.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Reporter so the CLI can print a `slow_down` notice to the user. */
  onStatus?: (status: "polling" | "slow_down") => void;
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}${path.startsWith("/") ? path : `/${path}`}`;
}

async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function postOAuthForm<T>(
  fetchImpl: typeof fetch,
  url: string,
  body: URLSearchParams,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await withTimeout(
      (signal) =>
        fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body,
          signal,
        }),
      DEFAULT_TIMEOUT_MS,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new OAuthError(`OAuth request failed: ${message}`, {
      category: "transient",
      retriable: true,
    });
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new OAuthError(
      `OAuth response was not valid JSON (status ${response.status})`,
      { category: "transient", retriable: response.status >= 500 },
    );
  }

  if (response.ok) {
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new OAuthError(
        `OAuth response did not match schema: ${result.error.message}`,
        { category: "unknown", retriable: false },
      );
    }
    return result.data;
  }

  if (response.status >= 500) {
    throw new OAuthError(`OAuth server error: HTTP ${response.status}`, {
      category: "transient",
      retriable: true,
    });
  }
  const errBody = ErrorBodySchema.safeParse(parsed);
  if (errBody.success && errBody.data.error) {
    const category = categoryFromOAuthString(errBody.data.error);
    throw new OAuthError(`OAuth error: ${errBody.data.error}`, {
      category,
      retriable: categoryRetriable(category),
    });
  }
  throw new OAuthError(`OAuth request rejected: HTTP ${response.status}`, {
    category: "unknown",
    retriable: false,
  });
}

export async function requestDeviceCode(
  input: DeviceCodeRequest,
  deps: FetchDeps = {},
): Promise<DeviceCodeResponse> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const body = new URLSearchParams();
  body.set("client_id", input.clientId);
  body.set("scope", input.scope.join(" "));

  const data = await postOAuthForm(
    fetchImpl,
    joinUrl(input.baseUrl, "/oauth/authorize_device"),
    body,
    DeviceCodeBodySchema,
  );

  const obtainedAtMs = Date.now();
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    ...(data.verification_uri_complete !== undefined
      ? { verificationUriComplete: data.verification_uri_complete }
      : {}),
    expiresAt: new Date(obtainedAtMs + data.expires_in * 1_000).toISOString(),
    pollIntervalMs: Math.max(1_000, data.interval * 1_000),
  };
}

function tokenResponseFromBody(
  data: z.infer<typeof TokenBodySchema>,
): OAuthTokenResponse {
  const obtainedAtMs = Date.now();
  return {
    accessToken: data.access_token,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    tokenType: data.token_type,
    ...(data.scope ? { scope: data.scope } : {}),
    expiresAt: new Date(obtainedAtMs + data.expires_in * 1_000).toISOString(),
  };
}

export interface PollForTokenInput {
  baseUrl: string;
  clientId: string;
  deviceCode: string;
  pollIntervalMs: number;
  expiresAt: string;
}

export async function pollForToken(
  input: PollForTokenInput,
  deps: PollDeps = {},
): Promise<OAuthTokenResponse> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const onStatus = deps.onStatus;

  let interval = input.pollIntervalMs;
  const expiresAtMs = Date.parse(input.expiresAt);
  const url = joinUrl(input.baseUrl, "/oauth/token");

  while (true) {
    if (Date.now() >= expiresAtMs) {
      throw new OAuthError("Device authorization grant expired", {
        category: "expired_token",
        retriable: false,
      });
    }
    await sleep(interval);
    onStatus?.("polling");

    const body = new URLSearchParams();
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
    body.set("client_id", input.clientId);
    body.set("device_code", input.deviceCode);

    try {
      const data = await postOAuthForm(fetchImpl, url, body, TokenBodySchema);
      return tokenResponseFromBody(data);
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      if (err.category === "authorization_pending") continue;
      if (err.category === "slow_down") {
        interval += 5_000;
        onStatus?.("slow_down");
        continue;
      }
      throw err;
    }
  }
}

export interface RefreshAccessTokenInput {
  baseUrl: string;
  clientId: string;
  refreshToken: string;
}

export async function refreshAccessToken(
  input: RefreshAccessTokenInput,
  deps: FetchDeps = {},
): Promise<OAuthTokenResponse> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", input.clientId);
  body.set("refresh_token", input.refreshToken);

  const data = await postOAuthForm(
    fetchImpl,
    joinUrl(input.baseUrl, "/oauth/token"),
    body,
    TokenBodySchema,
  );
  return tokenResponseFromBody(data);
}
