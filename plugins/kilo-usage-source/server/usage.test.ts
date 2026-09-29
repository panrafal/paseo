import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage, identify } from "./usage.js";

const originalKilocodeApiKey = process.env["KILOCODE_API_KEY"];
const originalKiloApiKey = process.env["KILO_API_KEY"];

afterEach(() => {
  if (originalKilocodeApiKey === undefined) delete process.env["KILOCODE_API_KEY"];
  else process.env["KILOCODE_API_KEY"] = originalKilocodeApiKey;
  if (originalKiloApiKey === undefined) delete process.env["KILO_API_KEY"];
  else process.env["KILO_API_KEY"] = originalKiloApiKey;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function writeKiloAuth(homeDir: string, access: string): Promise<void> {
  const directory = join(homeDir, ".local", "share", "kilo");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "auth.json"),
    JSON.stringify({ kilo: { type: "oauth", access, refresh: "keep-me" } }),
  );
}

describe("Kilo usage source", () => {
  let homeDir: string;

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("reports the balance from the CLI auth.json access token", async () => {
    homeDir = await mkdtemp(join(tmpdir(), "kilo-usage-"));
    await writeKiloAuth(homeDir, "kilo_access_token");
    const fetchApi = vi.fn(async () => jsonResponse({ balance: 12.5 }));

    const usage = await fetchUsage({}, fetchApi, homeDir);

    expect(fetchApi).toHaveBeenCalledWith(
      "https://api.kilo.ai/api/profile/balance",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer kilo_access_token" }),
      }),
    );
    expect(usage).toMatchObject({
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

  it("keeps the auth file unchanged and reports a danger tone at zero", async () => {
    homeDir = await mkdtemp(join(tmpdir(), "kilo-usage-"));
    await writeKiloAuth(homeDir, "kilo_access_token");
    const authPath = join(homeDir, ".local", "share", "kilo", "auth.json");
    const before = await readFile(authPath, "utf8");
    const fetchApi = vi.fn(async () => jsonResponse({ balance: 0 }));

    const usage = await fetchUsage({}, fetchApi, homeDir);

    expect(usage.balances?.[0]).toMatchObject({ remaining: 0, tone: "danger" });
    expect(await readFile(authPath, "utf8")).toBe(before);
  });

  it("prefers KILOCODE_API_KEY over auth.json", async () => {
    homeDir = await mkdtemp(join(tmpdir(), "kilo-usage-"));
    await writeKiloAuth(homeDir, "file_token");
    process.env["KILOCODE_API_KEY"] = "env_token";
    const fetchApi = vi.fn(async () => jsonResponse({ balance: 1 }));

    await fetchUsage({}, fetchApi, homeDir);

    expect(fetchApi).toHaveBeenCalledWith(
      "https://api.kilo.ai/api/profile/balance",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer env_token" }),
      }),
    );
  });

  it("is unavailable without credentials and does not fetch", async () => {
    homeDir = await mkdtemp(join(tmpdir(), "kilo-usage-"));
    const fetchApi = vi.fn();

    await expect(fetchUsage({}, fetchApi, homeDir)).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(fetchApi).not.toHaveBeenCalled();
    await expect(identify({}, homeDir)).resolves.toBeNull();
  });

  it("is unavailable when the API call fails", async () => {
    homeDir = await mkdtemp(join(tmpdir(), "kilo-usage-"));
    await writeKiloAuth(homeDir, "kilo_access_token");
    const fetchApi = vi.fn(async () => jsonResponse({}, 401));

    await expect(fetchUsage({}, fetchApi, homeDir)).resolves.toMatchObject({
      status: "unavailable",
    });
  });
});
