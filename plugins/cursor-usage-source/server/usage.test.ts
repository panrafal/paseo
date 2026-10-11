import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discover, fetchUsage } from "./usage.js";
import type { UsageReport } from "@getpaseo/plugin/server/usage";

// node:sqlite has no @types/node@20 typings; require it with a narrow local type.
const testRequire = createRequire(import.meta.url);
interface TestSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): void };
  close(): void;
}

// Cursor builds have stored ItemTable values as both TEXT and BLOB. Keys map to the
// real layouts: a plain modern token or the legacy JSON object.
function writeCursorStateDb(homeDir: string, rows: Record<string, string | Uint8Array>): void {
  const dir = join(homeDir, ".config", "Cursor", "User", "globalStorage");
  mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = testRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => TestSqliteDb;
  };
  const db = new DatabaseSync(join(dir, "state.vscdb"));
  db.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(rows)) {
    insert.run(key, value);
  }
  db.close();
}

function writeCursorAuthJson(homeDir: string, accessToken: string): void {
  const dir = join(homeDir, ".config", "cursor");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ accessToken }));
}

function mockFetch(handlers: Map<string, () => Response>): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL) => {
    const key = url.toString();
    const handler = handlers.get(key);
    if (!handler) throw new Error(`Unmocked fetch: ${key}`);
    return handler();
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("cursor usage source", () => {
  let homeDir: string;
  let fetchApi: typeof fetch;
  let originalEnv: Record<string, string | undefined>;
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "usage-home-"));
    originalEnv = { ...process.env };
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
    for (const key of [
      "APPDATA",
      "COPILOT_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_PAT",
      "CURSOR_ACCESS_TOKEN",
      "CURSOR_TOKEN",
      "ZAI_API_KEY",
      "GLM_API_KEY",
      "GROK_API_KEY",
      "GROK_TOKEN",
      "KIMI_TOKEN",
      "KIMI_API_KEY",
      "KIMI_CODE_HOME",
      "MINIMAX_API_KEY",
      "MINIMAX_BASE_URL",
    ])
      delete process.env[key];
    fetchApi = mockFetch(new Map());
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    for (const key in originalEnv) process.env[key] = originalEnv[key];
  });
  function service(
    _options: {
      platform?: typeof process.platform;
      keychain?: () => Promise<unknown | null>;
      cursorHomeDir?: string;
      kimiHomeDir?: string;
    } = {},
  ) {
    return {
      listUsage: async () => {
        const report = await fetchFirst((url, init) => fetchApi(url, init));
        return {
          providers: [
            {
              providerId: "cursor",
              ...report,
              error: report.status === "error" ? report.error : null,
              planLabel: report.status === "available" ? (report.planLabel ?? null) : null,
            },
          ],
        };
      },
    };
  }
  function findProvider(
    result: { providers: Array<{ providerId: string } & UsageReport> },
    id: string,
  ) {
    const report = result.providers.find((item) => item.providerId === id);
    if (!report) throw new Error(`Missing usage source ${id}`);
    return report;
  }
  it("fetches Cursor usage and normalizes malformed billing dates to null", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          () =>
            jsonResponse({
              planUsage: {
                totalSpend: "1500",
                includedSpend: "1000",
                bonusSpend: "500",
                remaining: "2500",
                limit: "4000",
              },
              billingCycleStart: "2026-01-14T12:42:14.000Z",
              billingCycleEnd: "not-a-date",
            }),
        ],
      ]),
    );

    const cursor = findProvider(await service().listUsage(), "cursor");

    expect(cursor).toMatchObject({
      status: "available",
      balances: [
        expect.objectContaining({
          id: "included_usage",
          used: 15,
          remaining: 25,
          limit: 40,
          resetsAt: null,
        }),
      ],
    });
  });

  it("maps a personal Cursor plan to Cursor Models and Other Models percentages", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          () =>
            jsonResponse({
              billingCycleStart: "1786552121000",
              billingCycleEnd: "1789230521000",
              planUsage: {
                totalSpend: 13500,
                includedSpend: 2000,
                bonusSpend: 11500,
                limit: 2000,
                autoPercentUsed: 44.88,
                apiPercentUsed: 0.8,
                totalPercentUsed: 39.13,
              },
              spendLimitUsage: { limitType: "user" },
              autoModelSelectedDisplayMessage: "You've used 39% of your included total usage",
              namedModelSelectedDisplayMessage: "You've used 1% of your included API usage",
            }),
        ],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo",
          () => jsonResponse({ planInfo: { planName: "Pro" } }),
        ],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetHardLimit",
          () => jsonResponse({ noUsageBasedAllowed: true }),
        ],
      ]),
    );

    const cursor = findProvider(await service().listUsage(), "cursor");

    expect(cursor).toMatchObject({
      status: "available",
      planLabel: "Pro",
      windows: [
        expect.objectContaining({
          id: "cursor_models",
          label: "Cursor Models",
          usedPct: 44.88,
        }),
        expect.objectContaining({
          id: "other_models",
          label: "Other Models",
          usedPct: 0.8,
        }),
      ],
      balances: [],
      details: [
        expect.objectContaining({
          id: "on_demand",
          label: "On-Demand Spending",
          value: "Disabled",
        }),
      ],
    });
  });

  it("maps enabled Cursor on-demand spending to a dollar amount", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          () =>
            jsonResponse({
              billingCycleEnd: "2026-02-14T12:42:14.000Z",
              planUsage: {
                autoPercentUsed: 20,
                apiPercentUsed: 5,
              },
              spendLimitUsage: {
                limitType: "user",
                individualUsed: 1234,
                individualRemaining: 3766,
                individualLimit: 5000,
              },
            }),
        ],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo",
          () => jsonResponse({ planInfo: { planName: "Pro" } }),
        ],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetHardLimit",
          () => jsonResponse({ hardLimit: 50 }),
        ],
      ]),
    );

    const cursor = findProvider(await service().listUsage(), "cursor");

    expect(cursor).toMatchObject({
      status: "available",
      windows: [
        expect.objectContaining({ id: "cursor_models", usedPct: 20 }),
        expect.objectContaining({ id: "other_models", usedPct: 5 }),
      ],
      balances: [
        expect.objectContaining({
          id: "on_demand",
          label: "On-Demand Spending",
          used: 12.34,
          remaining: 37.66,
          limit: 50,
        }),
      ],
      details: [],
    });
  });

  it("maps unlimited Cursor on-demand spending to used dollars without a cap", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          () =>
            jsonResponse({
              billingCycleEnd: "2026-02-14T12:42:14.000Z",
              planUsage: { autoPercentUsed: 10, apiPercentUsed: 2 },
              spendLimitUsage: { limitType: "user", individualUsed: 500 },
            }),
        ],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo",
          () => jsonResponse({ planInfo: { planName: "Pro+" } }),
        ],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetHardLimit",
          () => jsonResponse({ hardLimit: 100_000_000 }),
        ],
      ]),
    );

    const cursor = findProvider(await service().listUsage(), "cursor");

    expect(cursor).toMatchObject({
      status: "available",
      balances: [
        expect.objectContaining({
          id: "on_demand",
          label: "On-Demand Spending",
          used: 5,
          limit: null,
        }),
      ],
      details: [],
    });
  });

  it("maps a team Cursor plan to the same two model-pool percentages as personal", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          () =>
            jsonResponse({
              billingCycleStart: "2026-01-14T12:42:14.000Z",
              billingCycleEnd: "2026-02-14T12:42:14.000Z",
              planUsage: {
                totalSpend: 13400,
                remaining: 6600,
                limit: 20000,
                autoPercentUsed: 42,
                apiPercentUsed: 15,
              },
              spendLimitUsage: {
                limitType: "team",
                pooledUsed: 34798,
                pooledRemaining: 25202,
                pooledLimit: 60000,
              },
            }),
        ],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo",
          () => jsonResponse({ planInfo: { planName: "Team" } }),
        ],
      ]),
    );

    const cursor = findProvider(await service().listUsage(), "cursor");

    expect(cursor).toMatchObject({
      status: "available",
      planLabel: "Team",
      windows: [
        expect.objectContaining({ id: "cursor_models", usedPct: 42 }),
        expect.objectContaining({ id: "other_models", usedPct: 15 }),
      ],
      balances: [],
    });
  });

  it("maps a Cursor Start plan to a single Monthly usage percentage", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          () =>
            jsonResponse({
              billingCycleEnd: "2026-02-14T12:42:14.000Z",
              planUsage: {
                autoPercentUsed: 12,
                apiPercentUsed: 3,
                totalPercentUsed: 18.4,
              },
            }),
        ],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo",
          () => jsonResponse({ planInfo: { planName: "Start" } }),
        ],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetHardLimit",
          () => jsonResponse({ noUsageBasedAllowed: true }),
        ],
      ]),
    );

    const cursor = findProvider(await service().listUsage(), "cursor");

    expect(cursor).toMatchObject({
      status: "available",
      planLabel: "Start",
      windows: [expect.objectContaining({ id: "monthly_usage", usedPct: 18.4 })],
      balances: [],
      details: [],
    });
  });

  it("maps pooled Cursor spend to dollars when the API has no percentages", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          () =>
            jsonResponse({
              billingCycleEnd: "2026-02-14T12:42:14.000Z",
              planUsage: {
                totalSpend: 13400,
                remaining: 6600,
                limit: 20000,
              },
              spendLimitUsage: {
                limitType: "team",
                pooledUsed: 34798,
                pooledRemaining: 25202,
                pooledLimit: 60000,
              },
            }),
        ],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo",
          () => jsonResponse({ planInfo: { planName: "Enterprise" } }),
        ],
      ]),
    );

    const cursor = findProvider(await service().listUsage(), "cursor");

    expect(cursor).toMatchObject({
      status: "available",
      planLabel: "Enterprise",
      windows: [],
      balances: [
        expect.objectContaining({
          id: "included_usage",
          label: "Your included usage",
          used: 134,
          remaining: 66,
          limit: 200,
        }),
      ],
    });
  });

  it("maps an old request-based Cursor team seat to Included-Request Usage", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetTeams",
          () =>
            jsonResponse({
              teams: [
                {
                  id: 42,
                  name: "Acme",
                  role: "TEAM_ROLE_MEMBER",
                  requestQuotaPerSeat: 1,
                  selfServeTieredPricingEnabled: false,
                },
              ],
            }),
        ],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          () =>
            jsonResponse({
              billingCycleStart: "1785884859130",
              billingCycleEnd: "1785884859130",
              displayThreshold: 100,
            }),
        ],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo",
          () => jsonResponse({ planInfo: { planName: "Business" } }),
        ],
      ]),
    );

    const cursor = findProvider(await service().listUsage(), "cursor");

    expect(cursor).toMatchObject({
      status: "available",
      planLabel: "Business",
      windows: [],
      balances: [
        expect.objectContaining({
          id: "included_requests",
          label: "Included-Request Usage",
          used: 0,
          remaining: 500,
          limit: 500,
          unit: "requests",
          resetsAt: "2026-08-04T23:07:39.130Z",
        }),
      ],
    });
  });

  it("maps a current token Team with no planUsage to official 0% / 0% bars", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetTeams",
          () =>
            jsonResponse({
              teams: [
                {
                  id: 7,
                  role: "TEAM_ROLE_MEMBER",
                  selfServeTieredPricingEnabled: true,
                },
              ],
            }),
        ],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          () => jsonResponse({ billingCycleEnd: "2026-02-14T12:42:14.000Z" }),
        ],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo",
          () => jsonResponse({ planInfo: { planName: "Team" } }),
        ],
      ]),
    );

    const cursor = findProvider(await service().listUsage(), "cursor");

    expect(cursor).toMatchObject({
      status: "available",
      planLabel: "Team",
      windows: [
        expect.objectContaining({ id: "cursor_models", usedPct: 0 }),
        expect.objectContaining({ id: "other_models", usedPct: 0 }),
      ],
      balances: [],
    });
  });

  it("converts request-based team planUsage included spend into request counts", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetTeams",
          () =>
            jsonResponse({
              teams: [
                {
                  id: 42,
                  requestQuotaPerSeat: 2,
                  selfServeTieredPricingEnabled: false,
                },
              ],
            }),
        ],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          () =>
            jsonResponse({
              billingCycleEnd: "2026-02-14T12:42:14.000Z",
              planUsage: { includedSpend: 804, totalSpend: 5000 },
            }),
        ],
      ]),
    );

    const cursor = findProvider(await service().listUsage(), "cursor");

    expect(cursor.balances).toEqual([
      expect.objectContaining({
        id: "included_requests",
        used: 201,
        limit: 1000,
        unit: "requests",
      }),
    ]);
  });

  it("sends teamId on GetCurrentPeriodUsage the way the official dashboard does", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    let usageBody: unknown = null;
    fetchApi = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const key = url.toString();
      if (key.endsWith("/GetTeams")) {
        return jsonResponse({
          teams: [{ id: 99, selfServeTieredPricingEnabled: true }],
        });
      }
      if (key.endsWith("/GetCurrentPeriodUsage")) {
        usageBody = JSON.parse(String(init?.body ?? "{}"));
        return jsonResponse({
          planUsage: { autoPercentUsed: 10, apiPercentUsed: 2 },
        });
      }
      if (key.endsWith("/GetPlanInfo")) {
        return jsonResponse({ planInfo: { planName: "Team" } });
      }
      if (key.endsWith("/GetHardLimit")) {
        return jsonResponse({});
      }
      throw new Error(`Unmocked fetch: ${key}`);
    }) as unknown as typeof fetch;

    const cursor = findProvider(await service().listUsage(), "cursor");

    expect(usageBody).toEqual({ teamId: 99 });
    expect(cursor.windows).toEqual([
      expect.objectContaining({ id: "cursor_models", usedPct: 10 }),
      expect.objectContaining({ id: "other_models", usedPct: 2 }),
    ]);
  });

  it("reads Cursor model-pool percentages from display messages when numeric fields are absent", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          () =>
            jsonResponse({
              billingCycleEnd: "2026-02-14T12:42:14.000Z",
              autoModelSelectedDisplayMessage: "You've used 42% of your included total usage",
              namedModelSelectedDisplayMessage: "You've used 15% of your included API usage",
            }),
        ],
      ]),
    );

    const cursor = findProvider(await service().listUsage(), "cursor");

    expect(cursor).toMatchObject({
      status: "available",
      windows: [
        expect.objectContaining({ id: "cursor_models", usedPct: 42 }),
        expect.objectContaining({ id: "other_models", usedPct: 15 }),
      ],
      balances: [],
    });
  });

  it("reads the Cursor token from the modern cursorAuth/accessToken key in state.vscdb", async () => {
    writeCursorStateDb(homeDir, { "cursorAuth/accessToken": "cursor_state_jwt" });
    let authorization: string | null = null;
    fetchApi = (async (url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        planUsage: {
          totalSpend: "1500",
          includedSpend: "1000",
          bonusSpend: "500",
          remaining: "2500",
          limit: "4000",
        },
        billingCycleStart: "2026-01-14T12:42:14.000Z",
        billingCycleEnd: "2026-02-14T12:42:14.000Z",
      });
    }) as unknown as typeof fetch;

    const cursor = findProvider(await service({ cursorHomeDir: homeDir }).listUsage(), "cursor");

    expect(authorization).toBe("Bearer cursor_state_jwt");
    expect(cursor).toMatchObject({
      status: "available",
      balances: [
        expect.objectContaining({ id: "included_usage", used: 15, remaining: 25, limit: 40 }),
      ],
    });
  });

  it("falls back to the legacy cursorAuthStatus JSON blob when the modern key is absent", async () => {
    writeCursorStateDb(homeDir, {
      cursorAuthStatus: Buffer.from(JSON.stringify({ accessToken: "cursor_legacy_jwt" }), "utf8"),
    });
    let authorization: string | null = null;
    fetchApi = (async (url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        planUsage: { totalSpend: "0", remaining: "100", limit: "100" },
        billingCycleStart: null,
        billingCycleEnd: null,
      });
    }) as unknown as typeof fetch;

    const cursor = findProvider(await service({ cursorHomeDir: homeDir }).listUsage(), "cursor");

    expect(authorization).toBe("Bearer cursor_legacy_jwt");
    expect(cursor.status).toBe("available");
  });

  it("reads the Cursor token from cursor-agent ~/.config/cursor/auth.json when desktop state is absent", async () => {
    writeCursorAuthJson(homeDir, "cursor_cli_jwt");
    let authorization: string | null = null;
    fetchApi = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        planUsage: {
          totalSpend: "1500",
          includedSpend: "1000",
          bonusSpend: "500",
          remaining: "2500",
          limit: "4000",
        },
        billingCycleStart: "2026-01-14T12:42:14.000Z",
        billingCycleEnd: "2026-02-14T12:42:14.000Z",
      });
    }) as unknown as typeof fetch;

    const cursor = findProvider(await service({ cursorHomeDir: homeDir }).listUsage(), "cursor");

    expect(authorization).toBe("Bearer cursor_cli_jwt");
    expect(cursor).toMatchObject({
      status: "available",
      balances: [
        expect.objectContaining({ id: "included_usage", used: 15, remaining: 25, limit: 40 }),
      ],
    });
  });

  it("prefers the desktop state.vscdb token over cursor-agent auth.json", async () => {
    writeCursorStateDb(homeDir, { "cursorAuth/accessToken": "cursor_desktop_jwt" });
    writeCursorAuthJson(homeDir, "cursor_cli_jwt");
    let authorization: string | null = null;
    fetchApi = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        planUsage: { totalSpend: "0", remaining: "100", limit: "100" },
        billingCycleStart: null,
        billingCycleEnd: null,
      });
    }) as unknown as typeof fetch;

    const cursor = findProvider(await service({ cursorHomeDir: homeDir }).listUsage(), "cursor");

    expect(authorization).toBe("Bearer cursor_desktop_jwt");
    expect(cursor.status).toBe("available");
  });

  it("omits unreadable state.vscdb", async () => {
    const directory = join(homeDir, ".config", "Cursor", "User", "globalStorage");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "state.vscdb"), "invalid database");
    expect(await discover()).toEqual([]);
  });
});

it("discovery returns a locator when fetch finds cursor credentials", async () => {
  const previous = process.env["CURSOR_ACCESS_TOKEN"];
  try {
    process.env["CURSOR_ACCESS_TOKEN"] = "fixture-token";
    let requested = false;
    await fetchFirst(async () => {
      requested = true;
      return new Response(null, { status: 401 });
    });
    expect(requested).toBe(true);
    expect(await discover()).toEqual([
      { key: "default", input: { store: "env", locator: "CURSOR_ACCESS_TOKEN" } },
    ]);
  } finally {
    if (previous === undefined) delete process.env["CURSOR_ACCESS_TOKEN"];
    else process.env["CURSOR_ACCESS_TOKEN"] = previous;
  }
});

describe("account discovery", () => {
  it.each(["empty home", "unrelated files"])("returns no accounts for %s", async (scenario) => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const directory = await mkdtemp(join(tmpdir(), "usage-empty-"));
    const original = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      process.env.HOME = directory;
      process.env.USERPROFILE = directory;
      if (scenario === "unrelated files") await writeFile(join(directory, "unrelated.json"), "{}");
      expect(await discover()).toEqual([]);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, original);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function fetchFirst(fetchApi: typeof fetch) {
  const accounts = await discover();
  const account = accounts[0];
  if (!account) throw new Error("No configured account");
  return fetchUsage(account.input as Parameters<typeof fetchUsage>[0], fetchApi);
}

it.each([401, 403])("reports an existing login rejected with HTTP %i", async (status) => {
  const previous = process.env["CURSOR_ACCESS_TOKEN"];
  try {
    process.env["CURSOR_ACCESS_TOKEN"] = "fixture-rejected-login";
    const report = await fetchUsage(
      { store: "env", locator: "CURSOR_ACCESS_TOKEN" },
      async () => new Response(null, { status }),
    );
    expect(report).toEqual({ status: "unavailable", problem: { kind: "rejected", status } });
  } finally {
    if (previous === undefined) delete process.env["CURSOR_ACCESS_TOKEN"];
    else process.env["CURSOR_ACCESS_TOKEN"] = previous;
  }
});
