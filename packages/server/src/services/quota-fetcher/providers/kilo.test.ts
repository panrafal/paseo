import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KiloQuotaProvider } from "./kilo.js";

function createLogger() {
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger as never;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function writeKiloAuth(homeDir: string, access: string): void {
  const dir = join(homeDir, ".local", "share", "kilo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ kilo: { type: "oauth", access } }));
}

describe("KiloQuotaProvider", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "kilo-quota-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    delete process.env["KILOCODE_API_KEY"];
    delete process.env["KILO_API_KEY"];
    vi.restoreAllMocks();
  });

  it("reports the balance from the CLI auth.json access token", async () => {
    writeKiloAuth(homeDir, "kilo_access_token");
    const fetchApi = vi.fn(async () => jsonResponse({ balance: 12.5 }));
    const provider = new KiloQuotaProvider({ logger: createLogger(), fetch: fetchApi, homeDir });

    const usage = await provider.fetchUsage();

    expect(fetchApi).toHaveBeenCalledWith(
      "https://api.kilo.ai/api/profile/balance",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer kilo_access_token" }),
      }),
    );
    expect(usage).toMatchObject({
      providerId: "kilo",
      status: "available",
      balances: [
        {
          id: "balance",
          label: "Balance",
          remaining: 12.5,
          unit: "usd",
          tone: "ok",
        },
      ],
    });
  });

  it("reports a danger tone once the balance is spent", async () => {
    writeKiloAuth(homeDir, "kilo_access_token");
    const fetchApi = vi.fn(async () => jsonResponse({ balance: 0 }));
    const provider = new KiloQuotaProvider({ logger: createLogger(), fetch: fetchApi, homeDir });

    const usage = await provider.fetchUsage();

    expect(usage.balances?.[0]).toMatchObject({ remaining: 0, tone: "danger" });
  });

  it("prefers the KILOCODE_API_KEY environment variable over auth.json", async () => {
    writeKiloAuth(homeDir, "kilo_access_token");
    process.env["KILOCODE_API_KEY"] = "env_token";
    const fetchApi = vi.fn(async () => jsonResponse({ balance: 1 }));
    const provider = new KiloQuotaProvider({ logger: createLogger(), fetch: fetchApi, homeDir });

    await provider.fetchUsage();

    expect(fetchApi).toHaveBeenCalledWith(
      "https://api.kilo.ai/api/profile/balance",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer env_token" }),
      }),
    );
  });

  it("is unavailable when there is no credential", async () => {
    const fetchApi = vi.fn();
    const provider = new KiloQuotaProvider({ logger: createLogger(), fetch: fetchApi, homeDir });

    const usage = await provider.fetchUsage();

    expect(usage.status).toBe("unavailable");
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("is unavailable when the API call fails", async () => {
    writeKiloAuth(homeDir, "kilo_access_token");
    const fetchApi = vi.fn(async () => jsonResponse({}, 401));
    const provider = new KiloQuotaProvider({ logger: createLogger(), fetch: fetchApi, homeDir });

    const usage = await provider.fetchUsage();

    expect(usage.status).toBe("unavailable");
  });
});
