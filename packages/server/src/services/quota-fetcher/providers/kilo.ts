import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage, ProviderUsageBalance } from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import { balanceToneFromRemaining, fetchProviderApi, unavailableUsage } from "../usage.js";

const KILO_API_BASE = "https://api.kilo.ai";

const KiloBalanceResponseSchema = z.object({
  balance: z.coerce.number().finite().nullish(),
});

const KiloAuthSchema = z.object({
  access: z.string().nullish(),
});

interface KiloQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  homeDir?: string;
}

/**
 * Kilo's gateway has no limit/window endpoint yet (tracked upstream as
 * Kilo-Org/cloud#921), so this reports a single USD credit balance — the same
 * shape CursorQuotaProvider uses for its "Plan usage" balance. It also has no
 * way to scope the balance to a team/org from what the CLI's own auth file
 * exposes locally, so this always reports the personal balance.
 */
export class KiloQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "kilo";
  readonly displayName = "Kilo";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly homeDir: string;

  constructor(options: KiloQuotaProviderOptions) {
    this.logger = options.logger.child({ module: "kilo-quota-provider" });
    this.fetchApi = options.fetch ?? fetch;
    this.homeDir = options.homeDir ?? homedir();
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const token = await this.readToken();
    if (!token) return unavailableUsage(this);

    const res = await fetchProviderApi(this.fetchApi, `${KILO_API_BASE}/api/profile/balance`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      // Read-only on credentials; the Kilo CLI owns refresh. See docs/providers.md.
      this.logger.debug({ status: res.status }, "Kilo usage fetch failed");
      return unavailableUsage(this);
    }

    const { balance } = KiloBalanceResponseSchema.parse(await res.json());
    const balances: ProviderUsageBalance[] =
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
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: null,
      windows: [],
      balances,
      details: [],
      error: null,
    };
  }

  private async readToken(): Promise<string | null> {
    const environmentToken = process.env["KILOCODE_API_KEY"] || process.env["KILO_API_KEY"];
    if (environmentToken) return environmentToken;

    const authPath = join(this.homeDir, ".local", "share", "kilo", "auth.json");
    if (!existsSync(authPath)) return null;
    try {
      const parsed = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<string, unknown>;
      const kilo = KiloAuthSchema.safeParse(parsed["kilo"]);
      return kilo.success ? (kilo.data.access ?? null) : null;
    } catch (err) {
      this.logger.debug({ err, path: authPath }, "Failed to read Kilo auth.json");
      return null;
    }
  }
}
