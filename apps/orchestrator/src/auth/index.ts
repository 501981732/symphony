import {
  CredentialError,
  DEFAULT_OAUTH_CLIENT_ID,
  DEFAULT_OAUTH_SCOPES,
  OAuthError,
  createCredentialsStore,
  pollForToken,
  refreshAccessToken,
  requestDeviceCode,
  type CredentialsStore,
  type OAuthTokenResponse,
  type StoredCredential,
} from "@issuepilot/credentials";

/**
 * `console`-shaped output sink. Real CLI passes Node's `console`; tests
 * inject a buffer to assert exactly what the user would have seen.
 */
export interface CliConsole {
  log: (msg: string) => void;
  error: (msg: string) => void;
}

export interface AuthDepsCommon {
  store?: CredentialsStore | undefined;
  console?: CliConsole | undefined;
  /**
   * `os.homedir()`-equivalent override; honored when the default store is
   * created (i.e. `store` is not injected).
   */
  homeDir?: string | undefined;
  /**
   * Override the credentials directory entirely. Mirrors the `IPILOT_HOME`
   * env var so containerized smoke tests can pin state.
   */
  configDirOverride?: string | undefined;
}

export interface AuthLoginOptions {
  hostname: string;
  scope?: string[] | undefined;
  clientId?: string | undefined;
  baseUrl?: string | undefined;
}

export interface AuthLoginDeps extends AuthDepsCommon {
  /** Default `requestDeviceCode`; tests inject a fake. */
  requestDeviceCode?: typeof requestDeviceCode | undefined;
  pollForToken?: typeof pollForToken | undefined;
  /** Used to display token expiry in human-friendly form. */
  now?: () => number | undefined;
}

export interface AuthStatusOptions {
  hostname?: string | undefined;
}

export interface AuthLogoutOptions {
  hostname?: string | undefined;
  /** Required when no hostname is given — refuses to wipe everything otherwise. */
  all?: boolean | undefined;
}

const consoleSink: CliConsole = {
  log: (msg) => {
    console.log(msg);
  },
  error: (msg) => {
    console.error(msg);
  },
};

function maskToken(token: string): string {
  if (token.length <= 8) return "********";
  return `${token.slice(0, 6)}…${token.slice(-2)}`;
}

function defaultStore(opts: AuthDepsCommon): CredentialsStore {
  if (opts.store) return opts.store;
  const pathOpts: Parameters<typeof createCredentialsStore>[0] = {};
  if (opts.homeDir !== undefined) pathOpts.homeDir = opts.homeDir;
  if (opts.configDirOverride !== undefined) {
    pathOpts.configDirOverride = opts.configDirOverride;
  }
  return createCredentialsStore(pathOpts);
}

function defaultBaseUrl(hostname: string): string {
  return /^https?:\/\//i.test(hostname) ? hostname : `https://${hostname}`;
}

function nowFn(deps: AuthLoginDeps): () => number {
  const supplied = deps.now;
  if (typeof supplied === "function") {
    return () => {
      const value = supplied();
      return typeof value === "number" ? value : Date.now();
    };
  }
  return Date.now;
}

function describeExpiry(expiresAtIso: string, nowMs: number): string {
  const expiresAtMs = Date.parse(expiresAtIso);
  if (Number.isNaN(expiresAtMs)) return "unknown";
  const deltaMs = expiresAtMs - nowMs;
  if (deltaMs <= 0) return `expired (${expiresAtIso})`;
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "<1 minute";
  if (minutes < 120) return `${minutes} minutes`;
  return `${Math.round(minutes / 60)} hours`;
}

function buildStoredCredential(
  hostname: string,
  clientId: string,
  token: OAuthTokenResponse,
  obtainedAtMs: number,
): StoredCredential {
  return {
    version: 1,
    hostname,
    clientId,
    accessToken: token.accessToken,
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    tokenType: token.tokenType,
    ...(token.scope ? { scope: token.scope } : {}),
    obtainedAt: new Date(obtainedAtMs).toISOString(),
    expiresAt: token.expiresAt,
  };
}

export async function authLogin(
  options: AuthLoginOptions,
  deps: AuthLoginDeps = {},
): Promise<{ credential: StoredCredential }> {
  const out = deps.console ?? consoleSink;
  const store = defaultStore(deps);
  const requestDeviceCodeImpl = deps.requestDeviceCode ?? requestDeviceCode;
  const pollImpl = deps.pollForToken ?? pollForToken;
  const now = nowFn(deps);

  const baseUrl = options.baseUrl ?? defaultBaseUrl(options.hostname);
  const clientId =
    options.clientId ??
    process.env["IPILOT_OAUTH_CLIENT_ID"] ??
    DEFAULT_OAUTH_CLIENT_ID;
  const scope = options.scope ?? Array.from(DEFAULT_OAUTH_SCOPES);

  let device;
  try {
    device = await requestDeviceCodeImpl({ baseUrl, clientId, scope });
  } catch (err) {
    if (err instanceof OAuthError) {
      if (err.category === "invalid_client") {
        throw new Error(
          [
            `Failed to start OAuth device authorization (category=invalid_client): client_id "${clientId}" is not registered on ${options.hostname}.`,
            ``,
            `To fix this, a GitLab administrator needs to register an OAuth Application on ${options.hostname}:`,
            `  1. Go to: https://${options.hostname.replace(/^https?:\/\//, "")}/admin/applications`,
            `     (or User Settings → Applications for a personal OAuth app)`,
            `  2. Create a new application:`,
            `       Name: IssuePilot (or any name)`,
            `       Redirect URI: (leave empty or use urn:ietf:wg:oauth:2.0:oob)`,
            `       Confidential: NO (must be unchecked)`,
            `       Scopes: api, read_repository, write_repository`,
            `       Enable "Device Authorization Grant" (if present)`,
            `  3. Copy the generated Application ID.`,
            ``,
            `Then run:`,
            `  pnpm exec issuepilot auth login --hostname ${options.hostname.replace(/^https?:\/\//, "")} --client-id <application-id>`,
            ``,
            `Or set the env var permanently:`,
            `  export IPILOT_OAUTH_CLIENT_ID=<application-id>`,
          ].join("\n"),
        );
      }
      throw new Error(
        `Failed to start OAuth device authorization (category=${err.category})`,
      );
    }
    throw err;
  }

  out.log("");
  out.log("! First copy your one-time code:");
  out.log(`!   ${device.userCode}`);
  out.log("! Then open in your browser:");
  out.log(`!   ${device.verificationUriComplete ?? device.verificationUri}`);
  out.log("");
  out.log("Waiting for authorization (Ctrl+C to abort)…");

  let token: OAuthTokenResponse;
  try {
    token = await pollImpl(
      {
        baseUrl,
        clientId,
        deviceCode: device.deviceCode,
        pollIntervalMs: device.pollIntervalMs,
        expiresAt: device.expiresAt,
      },
      {
        onStatus: (status) => {
          if (status === "slow_down") {
            out.log("(server asked us to slow down — backing off)");
          }
        },
      },
    );
  } catch (err) {
    if (err instanceof OAuthError) {
      throw new Error(
        `OAuth login failed: ${err.category} (retriable=${String(err.retriable)})`,
      );
    }
    throw err;
  }

  const credential = buildStoredCredential(
    options.hostname,
    clientId,
    token,
    now(),
  );
  await store.write(credential);
  out.log(
    `Logged in to ${options.hostname} (token ${maskToken(token.accessToken)}, expires in ${describeExpiry(token.expiresAt, now())})`,
  );
  return { credential };
}

export async function authStatus(
  options: AuthStatusOptions = {},
  deps: AuthDepsCommon = {},
): Promise<{ entries: StoredCredential[] }> {
  const out = deps.console ?? consoleSink;
  const store = defaultStore(deps);
  const all = await store.list();
  const filtered = options.hostname
    ? all.filter((c) => c.hostname === options.hostname)
    : all;
  if (filtered.length === 0) {
    if (options.hostname) {
      out.log(
        `No credentials stored for ${options.hostname}. Run: issuepilot auth login --hostname ${options.hostname}`,
      );
    } else {
      out.log(
        "No credentials stored. Run: issuepilot auth login --hostname <host>",
      );
    }
    return { entries: [] };
  }
  const now = Date.now();
  for (const cred of filtered) {
    out.log(`hostname:   ${cred.hostname}`);
    out.log(`client_id:  ${cred.clientId}`);
    if (cred.scope) out.log(`scope:      ${cred.scope}`);
    out.log(`expires:    ${describeExpiry(cred.expiresAt, now)}`);
    out.log(`obtained:   ${cred.obtainedAt}`);
    out.log(`token type: ${cred.tokenType}`);
    out.log("");
  }
  return { entries: filtered };
}

export async function authLogout(
  options: AuthLogoutOptions = {},
  deps: AuthDepsCommon = {},
): Promise<{ removed: string[] }> {
  const out = deps.console ?? consoleSink;
  const store = defaultStore(deps);
  if (options.hostname) {
    await store.delete(options.hostname);
    out.log(`Removed credentials for ${options.hostname}`);
    return { removed: [options.hostname] };
  }
  if (!options.all) {
    out.error(
      "Refusing to wipe all credentials. Pass --all if you really want to clear every host.",
    );
    return { removed: [] };
  }
  const all = await store.list();
  for (const cred of all) {
    await store.delete(cred.hostname);
  }
  const hostnames = all.map((c) => c.hostname);
  if (hostnames.length === 0) {
    out.log("No credentials to remove.");
  } else {
    out.log(`Removed credentials for: ${hostnames.join(", ")}`);
  }
  return { removed: hostnames };
}

export {
  CredentialError,
  OAuthError,
  refreshAccessToken,
  type CredentialsStore,
};
