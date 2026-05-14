import {
  refreshAccessToken as defaultRefreshAccessToken,
  OAuthError,
} from "./device-flow.js";
import type { CredentialsStore } from "./store.js";
import {
  DEFAULT_OAUTH_CLIENT_ID,
  type CredentialResolver,
  type OAuthTokenResponse,
  type ResolvedCredential,
  type StoredCredential,
} from "./types.js";

const DEFAULT_REFRESH_SKEW_MS = 5 * 60_000;

export class CredentialError extends Error {
  override name = "CredentialError";
  constructor(
    message: string,
    public readonly code:
      | "not_logged_in"
      | "invalid_token_env"
      | "expired_no_refresh",
  ) {
    super(message);
  }
}

export interface EnvLike {
  get(name: string): string | undefined;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface CreateResolverDeps {
  store: CredentialsStore;
  env?: EnvLike;
  /** Override the device-flow refresh implementation; tests inject this. */
  refresh?: typeof defaultRefreshAccessToken;
  /** Defaults to 5 minutes; access tokens expiring sooner are refreshed up-front. */
  refreshSkewMs?: number;
  /** Default OAuth client_id when no entry overrides it. */
  clientId?: string;
  /** Defaults to `Date.now`; tests inject a virtual clock. */
  now?: () => number;
  /** Hostname → baseUrl map. Defaults to `https://${hostname}`. */
  baseUrlFor?: (hostname: string) => string;
}

function defaultBaseUrl(hostname: string): string {
  return /^https?:\/\//i.test(hostname) ? hostname : `https://${hostname}`;
}

function shouldRefresh(cred: StoredCredential, nowMs: number, skew: number): boolean {
  const expiresAtMs = Date.parse(cred.expiresAt);
  if (Number.isNaN(expiresAtMs)) return false;
  return expiresAtMs - nowMs <= skew;
}

function applyTokenToCredential(
  base: StoredCredential,
  next: OAuthTokenResponse,
  nowIso: string,
): StoredCredential {
  return {
    ...base,
    accessToken: next.accessToken,
    ...(next.refreshToken
      ? { refreshToken: next.refreshToken }
      : base.refreshToken
        ? { refreshToken: base.refreshToken }
        : {}),
    tokenType: next.tokenType,
    ...(next.scope ? { scope: next.scope } : {}),
    obtainedAt: nowIso,
    expiresAt: next.expiresAt,
  };
}

export function createCredentialResolver(
  deps: CreateResolverDeps,
): CredentialResolver {
  const env: EnvLike =
    deps.env ?? { get: (name) => process.env[name] };
  const refresh = deps.refresh ?? defaultRefreshAccessToken;
  const skew = deps.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const clientIdDefault = deps.clientId ?? DEFAULT_OAUTH_CLIENT_ID;
  const now = deps.now ?? Date.now;
  const baseUrlFor = deps.baseUrlFor ?? defaultBaseUrl;

  async function refreshAndPersist(
    cred: StoredCredential,
  ): Promise<StoredCredential> {
    if (!cred.refreshToken) {
      throw new CredentialError(
        "Stored credential has no refresh token; please run `issuepilot auth login` again",
        "expired_no_refresh",
      );
    }
    const refreshed = await refresh({
      baseUrl: baseUrlFor(cred.hostname),
      clientId: cred.clientId || clientIdDefault,
      refreshToken: cred.refreshToken,
    });
    const next = applyTokenToCredential(
      cred,
      refreshed,
      new Date(now()).toISOString(),
    );
    await deps.store.write(next);
    return next;
  }

  async function resolveOAuth(hostname: string): Promise<ResolvedCredential> {
    let cred = await deps.store.read(hostname);
    if (!cred) {
      throw new CredentialError(
        `Not logged in to ${hostname}. Run: issuepilot auth login --hostname ${hostname}`,
        "not_logged_in",
      );
    }
    if (shouldRefresh(cred, now(), skew)) {
      cred = await refreshAndPersist(cred);
    }
    const accessToken = cred.accessToken;
    const expiresAt = cred.expiresAt;
    const refreshClosure = async (): Promise<ResolvedCredential> => {
      const latest = (await deps.store.read(hostname)) ?? cred!;
      const next = await refreshAndPersist(latest);
      return {
        source: "oauth",
        hostname,
        accessToken: next.accessToken,
        expiresAt: next.expiresAt,
        refresh: refreshClosure,
      };
    };
    return {
      source: "oauth",
      hostname,
      accessToken,
      expiresAt,
      refresh: refreshClosure,
    };
  }

  return {
    async resolve({ hostname, trackerTokenEnv }) {
      if (typeof trackerTokenEnv === "string" && trackerTokenEnv.length > 0) {
        if (!ENV_NAME_RE.test(trackerTokenEnv)) {
          throw new CredentialError(
            `Invalid env var name: ${trackerTokenEnv}`,
            "invalid_token_env",
          );
        }
        const fromEnv = env.get(trackerTokenEnv);
        if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
          return {
            source: "env",
            hostname,
            accessToken: fromEnv.trim(),
          };
        }
      }
      try {
        return await resolveOAuth(hostname);
      } catch (err) {
        if (err instanceof CredentialError || err instanceof OAuthError) {
          throw err;
        }
        throw err;
      }
    },
  };
}
