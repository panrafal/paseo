import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { openCompactSettings, openSettingsHostSection } from "../support/helpers/settings";
import {
  installUsageReportsFixture,
  type UsageReportsFixture,
} from "../support/helpers/usage-reports";
import {
  openUsageFromIcon,
  refreshAllUsage,
  showUsageAs,
} from "../support/helpers/usage-sidebar-item";

const ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="currentColor"/></svg>';

function forcedRefreshCount(usage: UsageReportsFixture): number {
  return usage.listRequests().filter((request) => request.forceRefresh).length;
}

function report(input: {
  sourceId: string;
  sourceLabel: string;
  report:
    | Partial<Extract<UsageReportEntry["report"], { status: "available" }>>
    | Exclude<UsageReportEntry["report"], { status: "available" }>;
}): UsageReportEntry {
  return {
    id: `${input.sourceId}:account`,
    account: { label: input.sourceId === "alpha" ? "dev@example.com" : undefined },
    fetchedAt: "2026-01-01T00:00:00.000Z",
    sourceId: input.sourceId,
    sourceLabel: input.sourceLabel,
    icon: ICON,
    report:
      input.report.status === "error" || input.report.status === "unavailable"
        ? input.report
        : {
            status: "available",
            windows: [],
            ...input.report,
          },
  };
}

const bankedReset = {
  id: "reset-1",
  resetType: "codex_rate_limits",
  supportedByPlan: true,
  status: "available",
  grantedAt: "2026-09-01T00:00:00Z",
  expiresAt: "2099-10-01T00:00:00Z",
  title: "Referral reward",
  description: "One Codex usage reset",
};

function codexReport(used: boolean): UsageReportEntry {
  return report({
    sourceId: "codex",
    sourceLabel: "Codex",
    report: {
      planLabel: "Pro",
      windows: [{ id: "weekly", label: "Weekly", usedPct: used ? 0 : 100 }],
      bankedResets: {
        availableCount: used ? 0 : 1,
        error: null,
        credits: [{ ...bankedReset, status: used ? "redeemed" : "available" }],
      },
    },
  });
}

test.describe("usage settings", () => {
  test("renders every report returned by usage.list_reports", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const usage = await installUsageReportsFixture(page, {
      lists: [
        [
          report({
            sourceId: "alpha",
            sourceLabel: "Alpha plan",
            report: {
              planLabel: "Max",
              windows: [{ id: "session", label: "Session", usedPct: 7 }],
            },
          }),
          report({
            sourceId: "beta",
            sourceLabel: "Beta plan",
            report: {
              planLabel: "Coding plan",
              windows: [
                { id: "biweekly", label: "Biweekly", usedPct: 23 },
                { id: "daily", label: "Daily", remainingPct: 30 },
              ],
              balances: [
                { id: "credits", label: "Credits", remaining: 1234, unit: "credits" },
                { id: "extra", label: "Extra usage", used: 5, limit: 20, unit: "usd" },
              ],
              details: [{ id: "valid", label: "Valid until", value: "2026-12-31" }],
            },
          }),
          report({
            sourceId: "gamma",
            sourceLabel: "Gamma plan",
            report: { status: "error", error: "Gamma auth expired" },
          }),
        ],
      ],
    });

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "usage");
    await usage.waitForListRequests(1);

    const card = page.getByTestId("usage-card");
    await expect(card.getByText("Alpha plan", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText("dev@example.com", { exact: true })).toBeVisible();
    await expect(card.getByText("Beta plan", { exact: true })).toBeVisible();
    await expect(card.getByText("70%")).toBeVisible();
    await expect(card.getByText("1,234 left", { exact: true })).toBeVisible();
    await expect(card.getByText("$5.00 / $20.00", { exact: true })).toBeVisible();
    await expect(card.getByText("2026-12-31", { exact: true })).toBeVisible();
    await expect(card.getByText("Gamma auth expired", { exact: true })).toBeVisible();

    // The shared percentages setting applies to the host section.
    await expect(page.getByTestId("usage-options-menu")).toBeVisible();
    const hostUsageUrl = page.url();
    await gotoAppShell(page);
    await openUsageFromIcon(page);
    await showUsageAs(page, "remaining");
    await page.goto(hostUsageUrl);
    await expect(card.getByText("30% left")).toBeVisible();
    await expect(card.getByText("93% left")).toBeVisible();
  });

  test("refresh forces a fresh report", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const windows = (usedPct: number) => [{ id: "w", label: "Weekly", usedPct }];
    // The sidebar summary and the section each load reports; only Refresh forces one.
    const usage = await installUsageReportsFixture(page, {
      lists: [
        (request) => [
          report({
            sourceId: "alpha",
            sourceLabel: "Alpha plan",
            report: { windows: windows(request.forceRefresh ? 64 : 23) },
          }),
        ],
      ],
    });

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "usage");
    const card = page.getByTestId("usage-card");
    await expect(card.getByText("23%")).toBeVisible({ timeout: 10_000 });

    await refreshAllUsage(page);
    await expect.poll(() => forcedRefreshCount(usage)).toBe(1);
    await expect(card.getByText("64%")).toBeVisible();
  });

  test("asks to update a host without usage support and never calls it", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const usage = await installUsageReportsFixture(page, { usageSupported: false });

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "usage");

    await expect(
      // Names the host: "Update Laptop to see usage".
      page.getByTestId("usage-card").getByText(/^Update (?!the host ).+ to see usage$/),
    ).toBeVisible({ timeout: 10_000 });
    expect(usage.listRequests()).toHaveLength(0);
  });

  test("confirms banked reset use, prevents duplicates, and refreshes usage", async ({ page }) => {
    test.setTimeout(120_000);
    const consumed: string[] = [];
    let finishConsume!: () => void;
    const pendingConsume = new Promise<void>((resolve) => {
      finishConsume = resolve;
    });
    const fixture = await installUsageReportsFixture(page, {
      lists: [[codexReport(false)], [codexReport(true)]],
      consume: async ({ creditId }) => {
        consumed.push(creditId);
        await pendingConsume;
        return { outcome: "reset" };
      },
    });
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, getServerId(), "usage");
    const card = page.getByTestId("usage-card");
    await expect(card.getByText("1 available", { exact: true })).toBeVisible();
    await expect(card.getByText("Referral reward", { exact: true })).toBeVisible();

    page.once("dialog", (dialog) => dialog.dismiss());
    await card.getByRole("button", { name: "Use reset", exact: true }).click();
    expect(consumed).toEqual([]);

    page.once("dialog", (dialog) => dialog.accept());
    await card.getByRole("button", { name: "Use reset", exact: true }).click();
    await expect.poll(() => consumed).toEqual(["reset-1"]);
    await expect(card.getByRole("button", { name: "Use reset", exact: true })).toBeDisabled();
    finishConsume();
    await fixture.waitForListRequests(2);
    await expect(
      card.getByText("Banked reset used. Codex usage limits have been reset."),
    ).toBeVisible();
    await expect(card.getByText("0 available", { exact: true })).toBeVisible();
    await expect(card.getByText("Used", { exact: true })).toBeVisible();
    await expect(card.getByText("0%", { exact: true })).toBeVisible();
  });

  test("retries a failed banked reset with the same idempotency key", async ({ page }) => {
    test.setTimeout(120_000);
    const requests: Array<{ creditId: string; idempotencyKey: string }> = [];
    await installUsageReportsFixture(page, {
      lists: [[codexReport(false)]],
      consume: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? { error: "Codex request timed out. Refresh usage before retrying." }
          : { outcome: "already_redeemed" };
      },
    });
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, getServerId(), "usage");
    const card = page.getByTestId("usage-card");
    page.once("dialog", (dialog) => dialog.accept());
    await card.getByRole("button", { name: "Use reset", exact: true }).click();
    await expect(
      card.getByText("Codex request timed out. Refresh usage before retrying."),
    ).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await card.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(card.getByText("This banked reset has already been used.")).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
  });

  test("does not offer unavailable, expired, or plan-ineligible resets", async ({ page }) => {
    test.setTimeout(120_000);
    const entry = codexReport(false);
    if (entry.report.status !== "available" || !entry.report.bankedResets)
      throw new Error("Expected available Codex reset details");
    entry.report.bankedResets.credits = [
      { ...bankedReset, expiresAt: "2000-01-01T00:00:00Z" },
      { ...bankedReset, id: "reset-2", resetType: "future_reset" },
      { ...bankedReset, id: "reset-3", status: "redeeming" },
      { ...bankedReset, id: "reset-4", supportedByPlan: false },
    ];
    await installUsageReportsFixture(page, { lists: [[entry]] });
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, getServerId(), "usage");
    const card = page.getByTestId("usage-card");
    await expect(card.getByText("Expired", { exact: true })).toBeVisible();
    await expect(card.getByText("Unsupported", { exact: true })).toBeVisible();
    await expect(card.getByText("Processing", { exact: true })).toBeVisible();
    await expect(card.getByText("Not supported by plan", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Use reset", exact: true })).toHaveCount(0);
  });

  test("gates redemption on the host capability", async ({ page }) => {
    test.setTimeout(120_000);
    await installUsageReportsFixture(page, {
      lists: [[codexReport(false)]],
      supportsBankedResets: false,
    });
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, getServerId(), "usage");
    const card = page.getByTestId("usage-card");
    await expect(card.getByText("Update this host to manage banked resets.")).toBeVisible();
    await expect(card.getByRole("button", { name: "Use reset", exact: true })).toHaveCount(0);
  });

  test("keeps redemption errors actionable when the usage refresh also fails", async ({ page }) => {
    test.setTimeout(120_000);
    await installUsageReportsFixture(page, {
      lists: [
        [codexReport(false)],
        [
          report({
            sourceId: "codex",
            sourceLabel: "Codex",
            report: { status: "error", error: "Usage temporarily unavailable" },
          }),
        ],
      ],
      consume: async () => ({ error: "Reset request timed out" }),
    });
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, getServerId(), "usage");
    const card = page.getByTestId("usage-card");
    page.once("dialog", (dialog) => dialog.accept());
    await card.getByRole("button", { name: "Use reset", exact: true }).click();
    await expect(card.getByText("Usage temporarily unavailable")).toBeVisible();
    await expect(card.getByText("Reset request timed out")).toBeVisible();
    await expect(card.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  });

  test("banked reset controls fit a narrow screen", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await installUsageReportsFixture(page, { lists: [[codexReport(false)]] });
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());
    await openSettingsHostSection(page, getServerId(), "usage");
    const card = page.getByTestId("usage-card");
    await expect(card.getByText("Referral reward", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Use reset", exact: true })).toBeVisible();
    const bounds = await card.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  });
});
