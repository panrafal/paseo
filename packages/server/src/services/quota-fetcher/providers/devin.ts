import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  ApiOptionalStringSchema,
  balanceToneFromRemaining,
  fetchProviderApi,
  toIsoStringOrNull,
  toneFromUsedPct,
  unavailableUsage,
  usedPctOf,
  windowFromUsedPct,
} from "../usage.js";

const DEFAULT_API_SERVER_URL = "https://server.codeium.com";
const GET_USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const CLIENT_VERSION = "3000.10.21";

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

interface DevinQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  /** Override home directory (tests). Production uses os.homedir(). */
  homeDir?: string;
}

function devinCredentialPaths(homeDir: string | undefined): string[] {
  const home = homeDir ?? homedir();
  const xdgDataHome = process.env["XDG_DATA_HOME"];
  const candidates = [
    join(xdgDataHome || join(home, ".local", "share"), "devin", "credentials.toml"),
  ];
  if (process.platform === "win32") {
    if (process.env["LOCALAPPDATA"]) {
      candidates.push(join(process.env["LOCALAPPDATA"], "devin", "credentials.toml"));
    }
    if (process.env["APPDATA"]) {
      candidates.push(join(process.env["APPDATA"], "devin", "credentials.toml"));
    }
  }
  return candidates;
}

export async function readDevinCredentials(
  homeDir: string | undefined,
): Promise<DevinCredentials | null> {
  const envApiKey = process.env["WINDSURF_API_KEY"];
  if (envApiKey) {
    return { apiKey: envApiKey, apiServerUrl: null };
  }

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

function devinQuotaWindow(input: {
  id: string;
  label: string;
  remainingPct: number | undefined;
  resetAtUnix: number | undefined;
}): ProviderUsageWindow | null {
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

function devinPromptCreditsBalance(planStatus: DevinPlanStatus): ProviderUsageBalance | null {
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
      limit !== null
        ? toneFromUsedPct(usedPctOf(used, limit))
        : balanceToneFromRemaining(remaining),
  };
}

export class DevinQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "devin";
  readonly displayName = "Devin";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly homeDir: string | undefined;

  constructor(options: DevinQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.homeDir = options.homeDir;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const credentials = await readDevinCredentials(this.homeDir);
    if (!credentials) return unavailableUsage(this);

    const apiServerUrl = credentials.apiServerUrl ?? DEFAULT_API_SERVER_URL;
    // The Codeium seat-management endpoint rejects requests missing any of the
    // five metadata fields (400 invalid_argument) and answers Connect-JSON when
    // asked for application/json with Connect-Protocol-Version: 1.
    const res = await fetchProviderApi(
      this.fetchApi,
      `${apiServerUrl.replace(/\/+$/, "")}${GET_USER_STATUS_PATH}`,
      {
        method: "POST",
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

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Devin usage fetch failed");
      return unavailableUsage(this);
    }

    const planStatus = DevinUserStatusResponseSchema.parse(await res.json()).userStatus?.planStatus;
    if (!planStatus) return unavailableUsage(this);

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
    ].filter((window): window is ProviderUsageWindow => window !== null);

    const balance = devinPromptCreditsBalance(planStatus);
    const details: ProviderUsageDetail[] = planStatus.planEnd
      ? [{ id: "plan_renews", label: "Plan renews", value: planStatus.planEnd }]
      : [];

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: planStatus.planInfo?.planName || null,
      windows,
      balances: balance ? [balance] : [],
      details,
      error: null,
    };
  }
}
