import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { DevinQuotaProvider } from "./devin.js";

const GET_USER_STATUS_URL =
  "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const ENTERPRISE_GET_USER_STATUS_URL =
  "https://enterprise.example/exa.seat_management_pb.SeatManagementService/GetUserStatus";

function writeDevinCredentials(homeDir: string, contents: string): void {
  const dir = join(homeDir, ".local", "share", "devin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "credentials.toml"), contents);
}

function quotaResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    userStatus: {
      planStatus: {
        planInfo: { planName: "Pro", billingStrategy: "BILLING_STRATEGY_QUOTA" },
        planEnd: "2026-10-01T00:00:00Z",
        availablePromptCredits: -1,
        dailyQuotaRemainingPercent: 50,
        weeklyQuotaRemainingPercent: 75,
        dailyQuotaResetAtUnix: "1789372800",
        weeklyQuotaResetAtUnix: "1789891200",
        ...overrides,
      },
    },
  });
}

describe("DevinQuotaProvider", () => {
  let homeDir: string;
  let fetchApi: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "devin-quota-"));
    fetchApi = vi.fn<typeof fetch>();
    // Empty strings read as unset by the credential lookup.
    vi.stubEnv("WINDSURF_API_KEY", "");
    vi.stubEnv("XDG_DATA_HOME", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(homeDir, { recursive: true, force: true });
  });

  function provider(): DevinQuotaProvider {
    return new DevinQuotaProvider({
      logger: createTestLogger(),
      fetch: fetchApi,
      homeDir,
    });
  }

  it("reports unavailable without credentials and never calls the API", async () => {
    const usage = await provider().fetchUsage();

    expect(usage).toMatchObject({
      providerId: "devin",
      displayName: "Devin",
      status: "unavailable",
      planLabel: null,
    });
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("reads credentials.toml, honors api_server_url, and maps quota windows", async () => {
    writeDevinCredentials(
      homeDir,
      ['windsurf_api_key = "file-key"', 'api_server_url = "https://enterprise.example"'].join("\n"),
    );
    fetchApi.mockResolvedValue(quotaResponse());

    const usage = await provider().fetchUsage();

    expect(fetchApi).toHaveBeenCalledWith(
      ENTERPRISE_GET_USER_STATUS_URL,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Connect-Protocol-Version": "1" }),
      }),
    );
    const init = fetchApi.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      metadata: {
        apiKey: "file-key",
        ideName: "devin-cli",
        ideVersion: "3000.10.21",
        extensionName: "devin-cli",
        extensionVersion: "3000.10.21",
      },
    });

    expect(usage).toEqual({
      providerId: "devin",
      displayName: "Devin",
      status: "available",
      planLabel: "Pro",
      windows: [
        {
          id: "daily",
          label: "Daily",
          usedPct: 50,
          remainingPct: 50,
          resetsAt: "2026-09-14T08:00:00.000Z",
          tone: "ok",
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 25,
          remainingPct: 75,
          resetsAt: "2026-09-20T08:00:00.000Z",
          tone: "ok",
        },
      ],
      balances: [],
      details: [{ id: "plan_renews", label: "Plan renews", value: "2026-10-01T00:00:00Z" }],
      error: null,
    });
  });

  it("prefers WINDSURF_API_KEY over credentials.toml and uses the default host", async () => {
    writeDevinCredentials(
      homeDir,
      ['windsurf_api_key = "file-key"', 'api_server_url = "https://enterprise.example"'].join("\n"),
    );
    vi.stubEnv("WINDSURF_API_KEY", "env-key");
    fetchApi.mockResolvedValue(quotaResponse());

    const usage = await provider().fetchUsage();

    expect(usage.status).toBe("available");
    expect(fetchApi).toHaveBeenCalledWith(GET_USER_STATUS_URL, expect.anything());
    const init = fetchApi.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body)).metadata.apiKey).toBe("env-key");
  });

  it("maps prompt credit balances on credit-billed accounts", async () => {
    writeDevinCredentials(homeDir, 'windsurf_api_key = "file-key"');
    fetchApi.mockResolvedValue(
      quotaResponse({ availablePromptCredits: 120, planInfo: { monthlyPromptCredits: 500 } }),
    );

    const usage = await provider().fetchUsage();

    expect(usage.balances).toEqual([
      {
        id: "prompt_credits",
        label: "Prompt credits",
        used: 380,
        remaining: 120,
        limit: 500,
        unit: "credits",
        tone: "warning",
      },
    ]);
  });

  it("reports unavailable when the API rejects the key", async () => {
    writeDevinCredentials(homeDir, 'windsurf_api_key = "bad-key"');
    fetchApi.mockResolvedValue(
      new Response(JSON.stringify({ code: "unauthenticated" }), { status: 401 }),
    );

    const usage = await provider().fetchUsage();

    expect(usage.status).toBe("unavailable");
  });
});
