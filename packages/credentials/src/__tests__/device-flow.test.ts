import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  pollForToken,
  refreshAccessToken,
  requestDeviceCode,
  type OAuthError,
} from "../device-flow.js";

interface FakeFetchCall {
  url: string;
  init: RequestInit;
  body: URLSearchParams;
}

function fakeFetchSequence(
  responses: Array<
    | { status: number; body: unknown; contentType?: string }
    | (() => Promise<Response>)
  >,
): { fetch: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  let cursor = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const realInit = init ?? {};
    const bodyText =
      typeof realInit.body === "string"
        ? realInit.body
        : realInit.body instanceof URLSearchParams
          ? realInit.body.toString()
          : "";
    calls.push({
      url,
      init: realInit,
      body: new URLSearchParams(bodyText),
    });
    const next = responses[cursor++];
    if (!next) {
      throw new Error(
        `fakeFetchSequence: no response queued for call #${cursor}`,
      );
    }
    if (typeof next === "function") return next();
    const headers = new Headers({
      "content-type": next.contentType ?? "application/json",
    });
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers,
    });
  };
  return { fetch: fetchImpl, calls };
}

describe("requestDeviceCode", () => {
  it("posts client_id + space-joined scope and converts expires_in/interval", async () => {
    const { fetch, calls } = fakeFetchSequence([
      {
        status: 200,
        body: {
          device_code: "dev-abc",
          user_code: "ABCD-EFGH",
          verification_uri: "https://gitlab.example.com/-/oauth/device",
          verification_uri_complete:
            "https://gitlab.example.com/-/oauth/device?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 5,
        },
      },
    ]);

    const before = Date.now();
    const response = await requestDeviceCode(
      {
        baseUrl: "https://gitlab.example.com",
        clientId: "issuepilot-cli",
        scope: ["api", "read_repository", "write_repository"],
      },
      { fetch },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://gitlab.example.com/oauth/authorize_device",
    );
    expect(calls[0]!.body.get("client_id")).toBe("issuepilot-cli");
    expect(calls[0]!.body.get("scope")).toBe(
      "api read_repository write_repository",
    );

    expect(response.deviceCode).toBe("dev-abc");
    expect(response.userCode).toBe("ABCD-EFGH");
    expect(response.verificationUri).toBe(
      "https://gitlab.example.com/-/oauth/device",
    );
    expect(response.verificationUriComplete).toContain("ABCD-EFGH");
    expect(response.pollIntervalMs).toBe(5_000);
    const expiresAtMs = Date.parse(response.expiresAt);
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 600_000 - 1_000);
    expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + 600_000 + 1_000);
  });

  it("classifies a 503 as transient + retriable", async () => {
    const { fetch } = fakeFetchSequence([
      { status: 503, body: { error: "service_unavailable" } },
    ]);
    await expect(
      requestDeviceCode(
        {
          baseUrl: "https://gitlab.example.com",
          clientId: "id",
          scope: ["api"],
        },
        { fetch },
      ),
    ).rejects.toMatchObject({
      name: "OAuthError",
      category: "transient",
      retriable: true,
    });
  });

  it("classifies invalid_client (400 invalid_client) as non-retriable", async () => {
    const { fetch } = fakeFetchSequence([
      { status: 400, body: { error: "invalid_client" } },
    ]);
    await expect(
      requestDeviceCode(
        {
          baseUrl: "https://gitlab.example.com",
          clientId: "wrong",
          scope: ["api"],
        },
        { fetch },
      ),
    ).rejects.toMatchObject({
      name: "OAuthError",
      category: "invalid_client",
      retriable: false,
    });
  });

  it("treats network throws as transient", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new TypeError("network down");
    };
    await expect(
      requestDeviceCode(
        {
          baseUrl: "https://gitlab.example.com",
          clientId: "id",
          scope: ["api"],
        },
        { fetch },
      ),
    ).rejects.toMatchObject({ category: "transient", retriable: true });
  });
});

describe("pollForToken", () => {
  let now = 1_700_000_000_000;
  beforeEach(() => {
    now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns token after pending → pending → success", async () => {
    const { fetch, calls } = fakeFetchSequence([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "authorization_pending" } },
      {
        status: 200,
        body: {
          access_token: "oauth-test-access",
          refresh_token: "oauth-test-refresh",
          token_type: "Bearer",
          scope: "api",
          expires_in: 7_200,
        },
      },
    ]);
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      now += ms; // advance virtual clock to mirror sleep
    };

    const token = await pollForToken(
      {
        baseUrl: "https://gitlab.example.com",
        clientId: "issuepilot-cli",
        deviceCode: "dev-abc",
        pollIntervalMs: 5_000,
        expiresAt: new Date(now + 600_000).toISOString(),
      },
      { fetch, sleep },
    );

    expect(calls).toHaveLength(3);
    expect(calls[0]!.body.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
    expect(calls[0]!.body.get("device_code")).toBe("dev-abc");
    expect(token.accessToken).toBe("oauth-test-access");
    expect(token.refreshToken).toBe("oauth-test-refresh");
    expect(sleeps).toEqual([5_000, 5_000, 5_000]);
  });

  it("widens the interval on slow_down", async () => {
    const { fetch } = fakeFetchSequence([
      { status: 400, body: { error: "slow_down" } },
      {
        status: 200,
        body: {
          access_token: "oauth-test-success",
          token_type: "Bearer",
          expires_in: 3_600,
        },
      },
    ]);
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    };
    const statuses: string[] = [];
    await pollForToken(
      {
        baseUrl: "https://gitlab.example.com",
        clientId: "issuepilot-cli",
        deviceCode: "dev-abc",
        pollIntervalMs: 5_000,
        expiresAt: new Date(now + 600_000).toISOString(),
      },
      { fetch, sleep, onStatus: (s) => statuses.push(s) },
    );
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(statuses).toContain("slow_down");
  });

  it("rejects with expired_token after the deadline passes", async () => {
    const { fetch } = fakeFetchSequence([
      { status: 400, body: { error: "expired_token" } },
    ]);
    const sleep = async (ms: number) => {
      now += ms;
    };
    await expect(
      pollForToken(
        {
          baseUrl: "https://gitlab.example.com",
          clientId: "issuepilot-cli",
          deviceCode: "dev-abc",
          pollIntervalMs: 5_000,
          expiresAt: new Date(now + 4_000).toISOString(),
        },
        { fetch, sleep },
      ),
    ).rejects.toMatchObject({ category: "expired_token", retriable: false });
  });

  it("rejects with access_denied", async () => {
    const { fetch } = fakeFetchSequence([
      { status: 400, body: { error: "access_denied" } },
    ]);
    const sleep = async (ms: number) => {
      now += ms;
    };
    await expect(
      pollForToken(
        {
          baseUrl: "https://gitlab.example.com",
          clientId: "issuepilot-cli",
          deviceCode: "dev-abc",
          pollIntervalMs: 5_000,
          expiresAt: new Date(now + 600_000).toISOString(),
        },
        { fetch, sleep },
      ),
    ).rejects.toMatchObject({ category: "access_denied", retriable: false });
  });
});

describe("refreshAccessToken", () => {
  it("posts refresh_token grant and returns new tokens", async () => {
    const { fetch, calls } = fakeFetchSequence([
      {
        status: 200,
        body: {
          access_token: "oauth-test-rotated",
          refresh_token: "oauth-test-refresh-2",
          token_type: "Bearer",
          expires_in: 7_200,
          scope: "api",
        },
      },
    ]);

    const result = await refreshAccessToken(
      {
        baseUrl: "https://gitlab.example.com",
        clientId: "issuepilot-cli",
        refreshToken: "oauth-test-refresh",
      },
      { fetch },
    );

    expect(calls[0]!.body.get("grant_type")).toBe("refresh_token");
    expect(calls[0]!.body.get("refresh_token")).toBe("oauth-test-refresh");
    expect(result.accessToken).toBe("oauth-test-rotated");
    expect(result.refreshToken).toBe("oauth-test-refresh-2");
  });

  it("classifies invalid_grant as non-retriable", async () => {
    const { fetch } = fakeFetchSequence([
      { status: 400, body: { error: "invalid_grant" } },
    ]);
    await expect(
      refreshAccessToken(
        {
          baseUrl: "https://gitlab.example.com",
          clientId: "issuepilot-cli",
          refreshToken: "oauth-test-bad",
        },
        { fetch },
      ),
    ).rejects.toMatchObject({ category: "invalid_grant", retriable: false });
  });

  it("never embeds the refresh token in the error message", async () => {
    const { fetch } = fakeFetchSequence([
      { status: 400, body: { error: "invalid_grant" } },
    ]);
    try {
      await refreshAccessToken(
        {
          baseUrl: "https://gitlab.example.com",
          clientId: "issuepilot-cli",
          refreshToken: "oauth-test-supersecret-xyz",
        },
        { fetch },
      );
      throw new Error("should have rejected");
    } catch (err) {
      const e = err as OAuthError;
      expect(e.message).not.toContain("oauth-test-supersecret-xyz");
    }
  });
});
