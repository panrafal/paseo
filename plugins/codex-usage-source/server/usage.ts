import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  balanceToneFromRemaining,
  toneFromUsedPct,
  windowFromUsedPct,
  type CodexBankedResets,
  type CodexBankedResetOutcome,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import type { CodexUsageInput } from "../shared/input.js";

const authSchema = z.object({
  tokens: z
    .object({
      access_token: z.string().optional(),
      account_id: z.string().optional(),
      id_token: z.string().optional(),
    })
    .optional(),
});
const number = z.coerce.number().finite();
const windowSchema = z.object({ used_percent: number.optional(), reset_at: number.optional() });
const resetCreditsResponseSchema = z.object({
  available_count: z.number().int().nonnegative(),
  credits: z.array(
    z.object({
      id: z.string().min(1),
      reset_type: z.string(),
      is_supported_by_plan: z.boolean().nullish(),
      status: z.string(),
      granted_at: z.iso.datetime({ offset: true }),
      expires_at: z.iso.datetime({ offset: true }).nullish(),
      title: z.string().nullish(),
      description: z.string().nullish(),
    }),
  ),
});
const resetConsumeResponseSchema = z.object({
  code: z.enum(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]),
});
const responseSchema = z.object({
  rate_limit_reset_credits: z.object({ available_count: z.number().int().nonnegative() }).nullish(),
  plan_type: z.string().optional(),
  email: z.string().optional(),
  rate_limit: z
    .object({ primary_window: windowSchema.nullish(), secondary_window: windowSchema.nullish() })
    .nullish(),
  code_review_rate_limit: z.object({ primary_window: windowSchema.nullish() }).nullish(),
  credits: z.object({ balance: number.optional() }).nullish(),
});

class CodexResetApiError extends Error {}

export async function readAuth(
  _input: CodexUsageInput,
): Promise<{ token: string; accountId?: string; idToken?: string } | null> {
  const candidates = [
    ...(process.env["CODEX_HOME"] ? [join(process.env["CODEX_HOME"], "auth.json")] : []),
    join(homedir(), ".config", "codex", "auth.json"),
    join(homedir(), ".codex", "auth.json"),
  ];
  for (const path of candidates) {
    try {
      const auth = authSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (auth.tokens?.access_token)
        return {
          token: auth.tokens.access_token,
          accountId: auth.tokens.account_id,
          idToken: auth.tokens.id_token,
        };
    } catch {
      continue;
    }
  }
  return null;
}

function usageWindow(
  spec: { id: string; label: string; shortLabel: string; summary?: boolean },
  value: z.infer<typeof windowSchema> | null | undefined,
): UsageWindow | null {
  if (!value) return null;
  const usedPct = value.used_percent ?? 0;
  return windowFromUsedPct({
    ...spec,
    utilizationPct: usedPct,
    resetsAt: value.reset_at != null ? new Date(value.reset_at * 1000).toISOString() : null,
    tone: toneFromUsedPct(usedPct),
  });
}

export async function fetchUsage(
  input: CodexUsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const auth = await readAuth(input);
  if (!auth) return { status: "unavailable", windows: [] };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  const response = await fetchApi("https://chatgpt.com/backend-api/wham/usage", {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403)
    return { status: "unavailable", windows: [] };
  if (!response.ok) throw new Error(`Codex usage API returned ${response.status}`);
  const text = await response.text();
  if (text.trim().startsWith("<")) return { status: "unavailable", windows: [] };
  const usage = responseSchema.parse(JSON.parse(text));
  const windows = [
    usageWindow(
      { id: "session", label: "Session", shortLabel: "5h", summary: true },
      usage.rate_limit?.primary_window,
    ),
    usageWindow(
      { id: "weekly", label: "Weekly", shortLabel: "wk", summary: true },
      usage.rate_limit?.secondary_window,
    ),
    usageWindow(
      { id: "code_review", label: "Code review", shortLabel: "review" },
      usage.code_review_rate_limit?.primary_window,
    ),
  ].filter((window): window is UsageWindow => window !== null);
  const balance = usage.credits?.balance;
  const report: UsageReport = {
    status: "available",
    planLabel: usage.plan_type,
    windows,
    balances:
      balance === undefined
        ? []
        : [
            {
              id: "credits",
              label: "Credits",
              remaining: balance,
              unit: "credits",
              tone: balanceToneFromRemaining(balance),
            },
          ],
    details: [],
  };
  if (usage.rate_limit_reset_credits) {
    report.bankedResets = await fetchBankedResets(fetchApi, {
      token: auth.token,
      accountId: auth.accountId,
      availableCount: usage.rate_limit_reset_credits.available_count,
    });
  }
  return report;
}

export async function consumeBankedReset(
  input: { creditId: string; idempotencyKey: string },
  fetchApi: typeof fetch = fetch,
): Promise<CodexBankedResetOutcome> {
  const auth = await readAuth({});
  if (!auth) throw new CodexResetApiError("Sign in to Codex on this host to use a banked reset.");
  const response = await callResetApi(fetchApi, {
    token: auth.token,
    accountId: auth.accountId,
    body: JSON.stringify({ credit_id: input.creditId, redeem_request_id: input.idempotencyKey }),
  });
  return resetConsumeResponseSchema.parse(response).code;
}

async function fetchBankedResets(
  fetchApi: typeof fetch,
  input: { token: string; accountId?: string; availableCount: number },
): Promise<CodexBankedResets> {
  try {
    const response = resetCreditsResponseSchema.parse(
      await callResetApi(fetchApi, { token: input.token, accountId: input.accountId }),
    );
    return {
      availableCount: response.available_count,
      credits: response.credits.map((credit) => ({
        id: credit.id,
        resetType: credit.reset_type,
        supportedByPlan: credit.is_supported_by_plan ?? null,
        status: credit.status,
        grantedAt: credit.granted_at,
        expiresAt: credit.expires_at ?? null,
        title: credit.title ?? null,
        description: credit.description ?? null,
      })),
      error: null,
    };
  } catch (error) {
    if (!(error instanceof CodexResetApiError)) throw error;
    return {
      availableCount: input.availableCount,
      credits: null,
      error: "Could not load banked reset details. Refresh usage to try again.",
    };
  }
}

async function callResetApi(
  fetchApi: typeof fetch,
  input: { token: string; accountId?: string; body?: string },
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.token}`,
    Accept: "application/json",
  };
  if (input.accountId) headers["ChatGPT-Account-Id"] = input.accountId;
  const consuming = input.body !== undefined;
  if (consuming) headers["Content-Type"] = "application/json";
  const response = await fetchApi(
    `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits${consuming ? "/consume" : ""}`,
    {
      method: consuming ? "POST" : "GET",
      headers,
      ...(consuming ? { body: input.body } : {}),
      signal: AbortSignal.timeout(15_000),
    },
  ).catch((error: unknown) => {
    if (
      (error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError")) ||
      (error instanceof TypeError && error.message === "fetch failed")
    ) {
      throw new CodexResetApiError("Codex request failed. Refresh usage before retrying.", {
        cause: error,
      });
    }
    throw error;
  });
  if (response.status === 401 || response.status === 403) {
    throw new CodexResetApiError("Sign in to Codex on this host to manage banked resets.");
  }
  if (!response.ok) {
    throw new CodexResetApiError(
      `Codex banked reset API returned ${response.status}. Refresh usage before retrying.`,
    );
  }
  return response.json();
}

/** JWT claims are decoded locally; no token or email becomes an account key. */
function jwtClaims(token: string | undefined): Record<string, unknown> | null {
  try {
    const payload = token?.split(".")[1];
    return payload
      ? (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function claimObject(
  claims: Record<string, unknown> | null,
  name: string,
): Record<string, unknown> | null {
  const value = claims?.[name];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function claimString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function identify(input: CodexUsageInput) {
  const auth = await readAuth(input);
  if (!auth) return null;
  const access = jwtClaims(auth.token);
  const id = jwtClaims(auth.idToken);
  const accessAuth = claimObject(access, "https://api.openai.com/auth");
  const idAuth = claimObject(id, "https://api.openai.com/auth");
  const key =
    auth.accountId ??
    claimString(accessAuth?.["chatgpt_account_id"]) ??
    claimString(access?.["chatgpt_account_id"]) ??
    claimString(idAuth?.["chatgpt_account_id"]);
  if (!key) return null;
  const label =
    claimString(claimObject(access, "https://api.openai.com/profile")?.["email"]) ??
    claimString(access?.["email"]) ??
    claimString(claimObject(id, "https://api.openai.com/profile")?.["email"]) ??
    claimString(id?.["email"]);
  return { key, ...(label ? { label } : {}) };
}
