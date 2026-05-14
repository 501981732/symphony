/**
 * Public type contracts for @issuepilot/credentials.
 *
 * Why these live in their own module: device-flow client, store, and
 * resolver each consume the same shapes. Pulling them out of the impl
 * files keeps consumers (orchestrator daemon, CLI, tracker-gitlab) able to
 * type-import without dragging in fetch/fs runtime code.
 */

export const DEFAULT_OAUTH_SCOPES = [
  "api",
  "read_repository",
  "write_repository",
] as const;

export const DEFAULT_OAUTH_CLIENT_ID = "issuepilot-cli";

/** Input payload for `requestDeviceCode`. */
export interface DeviceCodeRequest {
  /** GitLab instance base URL, e.g. `https://gitlab.example.com`. No trailing slash. */
  baseUrl: string;
  clientId: string;
  /** OAuth scopes; joined with " " when sent on the wire. */
  scope: readonly string[];
}

/** Successful response from the GitLab device authorization endpoint. */
export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Optional GitLab convenience field that pre-fills the user_code. */
  verificationUriComplete?: string;
  /** ISO timestamp computed from `expires_in`; the device_code becomes invalid past this. */
  expiresAt: string;
  /** Polling interval converted from `interval` seconds. */
  pollIntervalMs: number;
}

/** OAuth token endpoint success body, normalized into camelCase. */
export interface OAuthTokenResponse {
  accessToken: string;
  /** Refresh token rotates per refresh on GitLab. May be absent for non-refreshable grants. */
  refreshToken?: string;
  tokenType: string;
  scope?: string;
  /** ISO timestamp computed from `expires_in`. */
  expiresAt: string;
}

/**
 * Persisted credential entry for a single GitLab hostname.
 *
 * `version` is reserved so we can migrate the schema in a forward-compatible
 * way; readers must reject anything other than `1` for now.
 */
export interface StoredCredential {
  version: 1;
  hostname: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope?: string;
  /** ISO timestamp set when this credential was minted or refreshed. */
  obtainedAt: string;
  expiresAt: string;
}

/** Resolver return shape — daemon and CLI consume this directly. */
export interface ResolvedCredential {
  source: "env" | "oauth";
  hostname: string;
  accessToken: string;
  /** Only present when `source === "oauth"`. */
  expiresAt?: string;
  /**
   * Force a refresh, returning the new credential. Only present for
   * `source === "oauth"` — env tokens cannot be refreshed.
   */
  refresh?: () => Promise<ResolvedCredential>;
}

/**
 * Stable contract every consumer programs against. The default
 * implementation lives in `./resolver.ts`; tests can swap it for a fake
 * without touching real fs or HTTP.
 */
export interface CredentialResolver {
  resolve(input: {
    hostname: string;
    /** Env var name from `tracker.token_env`. Optional after OAuth landed. */
    trackerTokenEnv?: string;
  }): Promise<ResolvedCredential>;
}
