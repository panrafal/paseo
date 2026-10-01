import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  balanceToneFromRemaining,
  hashAccountKey,
  toneFromUsedPct,
  unavailableUsage,
  usedPctOf,
  windowFromUsedPct,
  type UsageBalance,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import type { UsageInput } from "../shared/input.js";

const DEFAULT_API_SERVER_URL = "https://server.codeium.com";
const GET_USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const CLIENT_VERSION = "3000.10.21";

const ApiNumberSchema = z.coerce.number().finite();
const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

const DevinUserStatusResponseSchema = z.object({
  userStatus: z
    .object({
      planStatus: z
        .object({
          planInfo: z
            .object({
              planName: ApiOptionalStringSchema,
              monthlyPromptCredits: ApiNumberSchema.optional(),
            })
            .nullish(),
          planEnd: ApiOptionalStringSchema,
          availablePromptCredits: ApiNumberSchema.optional(),
          dailyQuotaRemainingPercent: ApiNumberSchema.optional(),
          weeklyQuotaRemainingPercent: ApiNumberSchema.optional(),
          dailyQuotaResetAtUnix: ApiNumberSchema.optional(),
          weeklyQuotaResetAtUnix: ApiNumberSchema.optional(),
        })
        .nullish(),
    })
    .nullish(),
});

type DevinPlanStatus = NonNullable<
  NonNullable<z.infer<typeof DevinUserStatusResponseSchema>["userStatus"]>["planStatus"]
>;

interface DevinCredentials {
  apiKey: string;
  apiServerUrl: string | null;
}

function devinCredentialPaths(homeDir: string = homedir()): string[] {
  const xdgDataHome = process.env["XDG_DATA_HOME"];
  const candidates = [
    join(xdgDataHome || join(homeDir, ".local", "share"), "devin", "credentials.toml"),
  ];
  if (process.platform === "win32") {
    if (process.env["LOCALAPPDATA"])
      candidates.push(join(process.env["LOCALAPPDATA"], "devin", "credentials.toml"));
    if (process.env["APPDATA"])
      candidates.push(join(process.env["APPDATA"], "devin", "credentials.toml"));
  }
  return candidates;
}

export async function readDevinCredentials(
  homeDir: string = homedir(),
): Promise<DevinCredentials | null> {
  const envApiKey = process.env["WINDSURF_API_KEY"];
  if (envApiKey) return { apiKey: envApiKey, apiServerUrl: null };

  for (const path of devinCredentialPaths(homeDir)) {
    if (!existsSync(path)) continue;
    try {
      const raw = await fs.readFile(path, "utf8");
      const apiKey = raw.match(/^\s*windsurf_api_key\s*=\s*"([^"]+)"/m)?.[1];
      if (!apiKey) continue;
      const apiServerUrl = raw.match(/^\s*api_server_url\s*=\s*"([^"]+)"/m)?.[1] ?? null;
      return { apiKey, apiServerUrl };
    } catch {
      continue;
    }
  }
  return null;
}

function toIsoStringOrNull(timestampMs: number): string | null {
  if (!Number.isFinite(timestampMs)) return null;
  try {
    return new Date(timestampMs).toISOString();
  } catch {
    return null;
  }
}

function devinQuotaWindow(input: {
  id: string;
  label: string;
  remainingPct: number | undefined;
  resetAtUnix: number | undefined;
}): UsageWindow | null {
  if (typeof input.remainingPct !== "number") return null;
  const usedPct = 100 - input.remainingPct;
  return windowFromUsedPct({
    id: input.id,
    label: input.label,
    utilizationPct: usedPct,
    resetsAt: input.resetAtUnix != null ? toIsoStringOrNull(input.resetAtUnix * 1000) : null,
    tone: toneFromUsedPct(usedPct),
  });
}

function devinPromptCreditsBalance(planStatus: DevinPlanStatus): UsageBalance | null {
  const remaining = planStatus.availablePromptCredits;
  if (typeof remaining !== "number" || remaining < 0) return null;
  const monthly = planStatus.planInfo?.monthlyPromptCredits;
  const limit = typeof monthly === "number" && monthly >= 0 ? monthly : null;
  const used = limit !== null ? Math.max(0, limit - remaining) : null;
  return {
    id: "prompt_credits",
    label: "Prompt credits",
    used,
    remaining,
    limit,
    unit: "credits",
    tone:
      limit !== null ? toneFromUsedPct(usedPctOf(used, limit)) : balanceToneFromRemaining(remaining),
  };
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  void input;
  const credentials = await readDevinCredentials();
  if (!credentials) return unavailableUsage();

  const apiServerUrl = credentials.apiServerUrl ?? DEFAULT_API_SERVER_URL;
  const response = await fetchApi(
    `${apiServerUrl.replace(/\/+$/, "")}${GET_USER_STATUS_PATH}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: JSON.stringify({
        metadata: {
          apiKey: credentials.apiKey,
          ideName: "devin-cli",
          ideVersion: CLIENT_VERSION,
          extensionName: "devin-cli",
          extensionVersion: CLIENT_VERSION,
        },
      }),
    },
  );

  if (!response.ok) return unavailableUsage();

  const planStatus = DevinUserStatusResponseSchema.parse(
    await response.json(),
  ).userStatus?.planStatus;
  if (!planStatus) return unavailableUsage();

  const windows = [
    devinQuotaWindow({
      id: "daily",
      label: "Daily",
      remainingPct: planStatus.dailyQuotaRemainingPercent,
      resetAtUnix: planStatus.dailyQuotaResetAtUnix,
    }),
    devinQuotaWindow({
      id: "weekly",
      label: "Weekly",
      remainingPct: planStatus.weeklyQuotaRemainingPercent,
      resetAtUnix: planStatus.weeklyQuotaResetAtUnix,
    }),
  ].filter((window): window is UsageWindow => window !== null);

  const balance = devinPromptCreditsBalance(planStatus);
  return {
    status: "available",
    planLabel: planStatus.planInfo?.planName || undefined,
    windows,
    balances: balance ? [balance] : [],
    details: planStatus.planEnd
      ? [{ id: "plan_renews", label: "Plan renews", value: planStatus.planEnd }]
      : [],
  };
}

export async function identify() {
  const credentials = await readDevinCredentials();
  return credentials
    ? {
        key: hashAccountKey(
          `${credentials.apiServerUrl ?? DEFAULT_API_SERVER_URL}:${credentials.apiKey}`,
        ),
      }
    : null;
}
