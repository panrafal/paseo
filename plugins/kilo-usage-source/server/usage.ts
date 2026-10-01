import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  balanceToneFromRemaining,
  unavailableUsage,
  type UsageBalance,
  type UsageReport,
} from "@getpaseo/plugin/server/usage";
import type { UsageInput } from "../shared/input.js";

const KILO_API_URL = "https://api.kilo.ai/api/profile/balance";

const KiloBalanceResponseSchema = z.object({
  balance: z.coerce.number().finite().nullish(),
});

const KiloAuthSchema = z.object({
  access: z.string().nullish(),
});

async function readAccessToken(
  homeDir = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const environmentToken = env["KILOCODE_API_KEY"]?.trim() || env["KILO_API_KEY"]?.trim();
  if (environmentToken) return environmentToken;

  try {
    const parsed = JSON.parse(
      await readFile(join(homeDir, ".local", "share", "kilo", "auth.json"), "utf8"),
    ) as Record<string, unknown>;
    const kilo = KiloAuthSchema.safeParse(parsed["kilo"]);
    return kilo.success ? (kilo.data.access?.trim() || null) : null;
  } catch {
    return null;
  }
}

export async function discover(
  homeDir = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<{}>> {
  return (await readAccessToken(homeDir, env)) ? [{}] : [];
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
  homeDir = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<UsageReport> {
  void input;
  const token = await readAccessToken(homeDir, env);
  if (!token) return unavailableUsage();

  const response = await fetchApi(KILO_API_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) return unavailableUsage();

  const { balance } = KiloBalanceResponseSchema.parse(await response.json());
  const balances: UsageBalance[] =
    typeof balance === "number"
      ? [
          {
            id: "balance",
            label: "Balance",
            used: null,
            remaining: balance,
            limit: null,
            unit: "usd",
            resetsAt: null,
            tone: balanceToneFromRemaining(balance),
          },
        ]
      : [];

  return {
    status: "available",
    windows: [],
    balances,
    details: [],
  };
}

export async function identify(
  input: UsageInput,
  homeDir = homedir(),
  env: NodeJS.ProcessEnv = process.env,
) {
  void input;
  return (await readAccessToken(homeDir, env)) ? { key: "default" } : null;
}
