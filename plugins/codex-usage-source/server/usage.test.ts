import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { consumeBankedReset, fetchUsage, identify } from "./usage.js";

const originalHome = process.env["CODEX_HOME"];
afterEach(() => {
  if (originalHome === undefined) delete process.env["CODEX_HOME"];
  else process.env["CODEX_HOME"] = originalHome;
});

function response(headers: HeadersInit, accountId?: string): Promise<Response> {
  const request = new Headers(headers);
  expect(request.get("Authorization")).toMatch(/^Bearer fixture-/);
  expect(request.get("ChatGPT-Account-Id")).toBe(accountId ?? null);
  return Promise.resolve(
    new Response(
      JSON.stringify({
        plan_type: "plus",
        rate_limit: { primary_window: { used_percent: 30, reset_at: 1700000000 } },
      }),
      { status: 200 },
    ),
  );
}

test("default input reads CODEX_HOME auth and preserves the usage request", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-codex-"));
  try {
    process.env["CODEX_HOME"] = home;
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify({
        tokens: { access_token: "fixture-default", account_id: "account-default" },
      }),
    );
    const report = await fetchUsage({}, (_url, init) =>
      response(init?.headers ?? {}, "account-default"),
    );
    expect(report).toMatchObject({
      status: "available",
      planLabel: "plus",
      windows: [{ id: "session", usedPct: 30, headline: true }],
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("explicit codexHome reads only that auth file", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-codex-"));
  try {
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify({ tokens: { access_token: "fixture-home", account_id: "account-home" } }),
    );
    await fetchUsage({ codexHome: home }, (_url, init) =>
      response(init?.headers ?? {}, "account-home"),
    );
    expect(await identify({ codexHome: home })).toEqual({ key: "account-home" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("identify returns a key when fetch finds Codex token credentials", async () => {
  await fetchUsage(
    { accessToken: "fixture-supplied", accountId: "account-supplied" },
    (_url, init) => response(init?.headers ?? {}, "account-supplied"),
  );
  expect(
    await identify({ accessToken: "fixture-supplied", accountId: "account-supplied" }),
  ).toEqual({ key: "account-supplied" });
});

test("coerces credit balance and marks a 96 percent window dangerous", async () => {
  const report = await fetchUsage(
    { accessToken: "fixture-supplied" },
    async () =>
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 12 },
            secondary_window: { used_percent: 96 },
          },
          credits: { balance: "0" },
        }),
        { status: 200 },
      ),
  );
  expect(report.windows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "session", tone: "ok" }),
      expect.objectContaining({ id: "weekly", tone: "danger" }),
    ]),
  );
  expect(report.balances).toEqual([expect.objectContaining({ remaining: 0, tone: "danger" })]);
});

test("HTML usage body is unavailable", async () => {
  const report = await fetchUsage(
    { accessToken: "fixture-supplied" },
    async () => new Response("<html>Login</html>", { status: 200 }),
  );
  expect(report.status).toBe("unavailable");
});

test("401 leaves auth.json byte for byte unchanged and makes no refresh request", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-codex-"));
  try {
    const authPath = join(home, "auth.json");
    const before = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "fixture-id",
        access_token: "fixture-stale",
        refresh_token: "fixture-refresh",
        account_id: "fixture-account",
      },
      last_refresh: "2026-07-04T20:35:00Z",
    });
    await writeFile(authPath, before);
    let calls = 0;
    const report = await fetchUsage({ codexHome: home }, async (url) => {
      expect(String(url)).toBe("https://chatgpt.com/backend-api/wham/usage");
      calls++;
      return new Response(null, { status: 401 });
    });
    expect(report.status).toBe("unavailable");
    expect(calls).toBe(1);
    expect(await readFile(authPath, "utf8")).toBe(before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("token-only account claim survives token rotation", async () => {
  const token = (suffix: string) =>
    `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "work-id" }, suffix })).toString("base64url")}.signature`;
  expect(await identify({ accessToken: token("first") })).toEqual({ key: "work-id" });
  expect(await identify({ accessToken: token("second") })).toEqual({ key: "work-id" });
  expect(await identify({ accessToken: "opaque-token" })).toBeNull();
});

test("identify reads an email label from auth id_token when access token has no profile", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-codex-label-"));
  try {
    const idToken = `header.${Buffer.from(JSON.stringify({ email: "id-owner@example.test" })).toString("base64url")}.signature`;
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify({
        tokens: { account_id: "account-id", access_token: "opaque-token", id_token: idToken },
      }),
    );
    expect(await identify({ codexHome: home })).toEqual({
      key: "account-id",
      label: "id-owner@example.test",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("loads banked reset details alongside quota usage", async () => {
  const fetchApi = vi.fn<typeof fetch>(async (url) => {
    if (url.toString().endsWith("/usage")) {
      return Response.json({
        rate_limit: { primary_window: { used_percent: 42 } },
        rate_limit_reset_credits: { available_count: 1 },
      });
    }
    return Response.json({
      available_count: 1,
      credits: [
        {
          id: "reset-1",
          reset_type: "codex_rate_limits",
          status: "available",
          granted_at: "2026-09-01T00:00:00Z",
          expires_at: "2026-10-01T00:00:00Z",
          title: "Referral reward",
          description: null,
        },
      ],
    });
  });
  const usage = await fetchUsage(
    { accessToken: "fixture-token", accountId: "fixture-account" },
    fetchApi,
  );
  expect(usage.bankedResets).toEqual({
    availableCount: 1,
    credits: [
      {
        id: "reset-1",
        resetType: "codex_rate_limits",
        supportedByPlan: null,
        status: "available",
        grantedAt: "2026-09-01T00:00:00Z",
        expiresAt: "2026-10-01T00:00:00Z",
        title: "Referral reward",
        description: null,
      },
    ],
    error: null,
  });
  expect(fetchApi).toHaveBeenLastCalledWith(
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "Bearer fixture-token",
        "ChatGPT-Account-Id": "fixture-account",
      }),
    }),
  );
});

test("reset detail schema errors propagate while expected transport failures preserve usage", async () => {
  for (const error of [
    new TypeError("Unexpected reset adapter defect"),
    new SyntaxError("invalid"),
  ]) {
    const fetchApi: typeof fetch = async (url) => {
      if (url.toString().endsWith("/usage"))
        return Response.json({ rate_limit_reset_credits: { available_count: 1 } });
      throw error;
    };
    await expect(fetchUsage({ accessToken: "fixture-token" }, fetchApi)).rejects.toBe(error);
  }

  const expectedFailures = [
    new TypeError("fetch failed"),
    new DOMException("Request timed out", "TimeoutError"),
    new DOMException("Request aborted", "AbortError"),
  ];
  for (const error of expectedFailures) {
    const fetchApi: typeof fetch = async (url) => {
      if (url.toString().endsWith("/usage")) {
        return Response.json({
          rate_limit: { primary_window: { used_percent: 75 } },
          rate_limit_reset_credits: { available_count: 1 },
        });
      }
      throw error;
    };
    await expect(fetchUsage({ accessToken: "fixture-token" }, fetchApi)).resolves.toMatchObject({
      windows: [expect.objectContaining({ usedPct: 75 })],
      bankedResets: {
        availableCount: 1,
        credits: null,
        error: "Could not load banked reset details. Refresh usage to try again.",
      },
    });
  }

  const invalidDetails = async (url: RequestInfo | URL) => {
    if (url.toString().endsWith("/usage"))
      return Response.json({ rate_limit_reset_credits: { available_count: 1 } });
    return Response.json({ available_count: 1, credits: "invalid" });
  };
  await expect(fetchUsage({ accessToken: "fixture-token" }, invalidDetails)).rejects.toThrow();
});

test("redeems a banked reset once and preserves the idempotency key", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-codex-reset-"));
  try {
    process.env["CODEX_HOME"] = home;
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify({ tokens: { access_token: "fixture-token", account_id: "fixture-account" } }),
    );
    const fetchApi = vi.fn<typeof fetch>(async () => Response.json({ code: "reset" }));
    await expect(
      consumeBankedReset({ creditId: "reset-1", idempotencyKey: "attempt-1" }, fetchApi),
    ).resolves.toBe("reset");
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(fetchApi).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ credit_id: "reset-1", redeem_request_id: "attempt-1" }),
      }),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("expected consume transport failures are actionable and are not retried", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-codex-reset-"));
  try {
    process.env["CODEX_HOME"] = home;
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify({ tokens: { access_token: "fixture-token" } }),
    );
    const fetchApi = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      consumeBankedReset({ creditId: "reset-1", idempotencyKey: "attempt-1" }, fetchApi),
    ).rejects.toThrow("Codex request failed. Refresh usage before retrying.");
    expect(fetchApi).toHaveBeenCalledTimes(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
