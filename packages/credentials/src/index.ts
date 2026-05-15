export const PACKAGE_NAME = "@issuepilot/credentials";
export const VERSION = "0.0.0";

export { DEFAULT_OAUTH_CLIENT_ID, DEFAULT_OAUTH_SCOPES } from "./types.js";
export type {
  CredentialResolver,
  DeviceCodeRequest,
  DeviceCodeResponse,
  OAuthTokenResponse,
  ResolvedCredential,
  StoredCredential,
} from "./types.js";

export {
  OAuthError,
  pollForToken,
  refreshAccessToken,
  requestDeviceCode,
  type FetchDeps,
  type OAuthErrorCategory,
  type PollDeps,
  type PollForTokenInput,
  type RefreshAccessTokenInput,
} from "./device-flow.js";

export {
  CredentialsPermissionError,
  assertSecureFileMode,
  credentialsPath,
  ensureCredentialsDir,
  type CredentialsLocation,
  type CredentialsPathOptions,
} from "./paths.js";

export { createCredentialsStore, type CredentialsStore } from "./store.js";

export {
  CredentialError,
  createCredentialResolver,
  type CreateResolverDeps,
  type EnvLike,
} from "./resolver.js";
