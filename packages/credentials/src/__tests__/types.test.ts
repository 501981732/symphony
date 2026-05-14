import { describe, expect, expectTypeOf, it } from "vitest";

import {
  DEFAULT_OAUTH_CLIENT_ID,
  DEFAULT_OAUTH_SCOPES,
  type CredentialResolver,
  type ResolvedCredential,
  type StoredCredential,
} from "../types.js";

describe("contract types", () => {
  it("StoredCredential carries version, hostname, and access token fields", () => {
    expectTypeOf<StoredCredential>().toHaveProperty("version");
    expectTypeOf<StoredCredential>().toHaveProperty("hostname");
    expectTypeOf<StoredCredential>().toHaveProperty("accessToken");
  });

  it("ResolvedCredential exposes a typed source discriminator", () => {
    expectTypeOf<ResolvedCredential["source"]>().toEqualTypeOf<
      "env" | "oauth"
    >();
  });

  it("CredentialResolver.resolve returns a ResolvedCredential promise", () => {
    expectTypeOf<CredentialResolver["resolve"]>().returns.toEqualTypeOf<
      Promise<ResolvedCredential>
    >();
  });

  it("provides default scopes and client_id", () => {
    expect(DEFAULT_OAUTH_CLIENT_ID).toMatch(/.+/);
    expect(DEFAULT_OAUTH_SCOPES).toContain("api");
  });
});
