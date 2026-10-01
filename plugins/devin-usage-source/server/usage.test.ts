import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUsage, identify } from "./usage.js";

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

describe("Devin usage source", () => {
  let homeDir: string;
  let fetchApi: ReturnType<typeof vi.fn<typeof fetch>>;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "devin-usage-"));
    originalEnv = { ...process.env };
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
    process.env["XDG_DATA_HOME"] = "";
    delete process.env["WINDSURF_API_KEY"];
    fetchApi = vi.fn<typeof fetch>();
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    for (const key in originalEnv) process.env[key] = originalEnv[key];
  });

  it("is unavailable without credentials and does not call the API", async () => {
    const usage = await fetchUsage({}, fetchApi);

    expect(usage).toEqual({ status: "unavailable", windows: [], balances: [], details: [] });
    expect(fetchApi).not.toHaveBeenCalled();
    expect(await identify()).toBeNull();
  });

  it("reads credentials.toml, honors api_server_url, and maps quota windows", async () => {
    writeDevinCredentials(
      homeDir,
      ['windsurf_api_key = "file-key"', 'api_server_url = "https://enterprise.example"'].join(
        "\n",
      ),
    );
    fetchApi.mockResolvedValue(quotaResponse());

    const usage = await fetchUsage({}, fetchApi);

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
    });
  });

  it("prefers WINDSURF_API_KEY over credentials.toml and uses the default host", async () => {
    writeDevinCredentials(
      homeDir,
      ['windsurf_api_key = "file-key"', 'api_server_url = "https://enterprise.example"'].join(
        "\n",
      ),
    );
    process.env["WINDSURF_API_KEY"] = "env-key";
    fetchApi.mockResolvedValue(quotaResponse());

    await fetchUsage({}, fetchApi);

    expect(fetchApi).toHaveBeenCalledWith(GET_USER_STATUS_URL, expect.anything());
    const init = fetchApi.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body)).metadata.apiKey).toBe("env-key");
  });

  it("maps prompt credit balances on credit-billed accounts", async () => {
    writeDevinCredentials(homeDir, 'windsurf_api_key = "file-key"');
    fetchApi.mockResolvedValue(
      quotaResponse({ availablePromptCredits: 120, planInfo: { monthlyPromptCredits: 500 } }),
    );

    const usage = await fetchUsage({}, fetchApi);

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

    const usage = await fetchUsage({}, fetchApi);

    expect(usage.status).toBe("unavailable");
  });
});
