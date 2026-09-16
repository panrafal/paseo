import { expect, test, type Page } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openCommandCenter } from "../support/helpers/command-center";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { installProviderUsageFixture } from "../support/helpers/provider-usage";
import { getServerId } from "../support/helpers/server-id";
import { buildSettingsHostSectionRoute } from "../../src/utils/host-routes";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function openMockAgent(page: Page) {
  await page.setViewportSize(MOBILE_VIEWPORT);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "provider-usage-tooltip-",
    title: "Provider usage tooltip e2e",
    initialPrompt: "emit 1 coalesced agent stream update for provider usage tooltip.",
  });
  await openAgentRoute(page, session);
  await expectComposerVisible(page);
  await expect(page.getByTestId("context-window-meter")).toBeVisible({ timeout: 30_000 });
  return session;
}

test.describe("provider usage tooltip", () => {
  test.describe("touch input", () => {
    test.use({ hasTouch: true });

    test("single and long touches stay put; the second tap can finish after the inter-tap delay", async ({
      page,
    }) => {
      test.setTimeout(180_000);
      const session = await openMockAgent(page);
      try {
        const agentUrl = page.url();
        const meter = page.getByTestId("context-window-meter");
        await meter.tap();
        await expect(page.getByText("Context window", { exact: true })).toBeVisible();
        await page.waitForTimeout(500);
        await expect(page).toHaveURL(agentUrl);

        const bounds = await meter.boundingBox();
        if (!bounds) throw new Error("Context meter has no bounds");
        const cdp = await page.context().newCDPSession(page);
        const touchPoints = [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }];
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints });
        await page.waitForTimeout(600);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect(page).toHaveURL(agentUrl);
        await page.waitForTimeout(350);

        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(100);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints });
        await page.waitForTimeout(300);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        const usageRoute = buildSettingsHostSectionRoute(getServerId(), "usage");
        await expect(page).toHaveURL(new RegExp(`${usageRoute}$`));
      } finally {
        await session.cleanup();
      }
    });
  });

  test("compact single taps show the tooltip and only double taps open host usage", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const session = await openMockAgent(page);
    const usageRoute = buildSettingsHostSectionRoute(getServerId(), "usage");
    try {
      const agentUrl = page.url();
      const meter = page.getByTestId("context-window-meter");
      await meter.click();
      await expect(page.getByText("Context window", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(agentUrl);

      await page.mouse.move(0, 0);
      await page.waitForTimeout(500);
      await expect(page.getByText("Context window", { exact: true })).toBeHidden();
      await meter.click({ delay: 600 });
      await expect(page).toHaveURL(agentUrl);

      await meter.dblclick({ delay: 80 });
      await expect(page).toHaveURL(new RegExp(`${usageRoute}$`));
      await expect(page.getByText("Context window", { exact: true })).toBeHidden();
    } finally {
      await session.cleanup();
    }
  });

  test("desktop navigation requires a double click and Usage follows the current host route", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const session = await openMockAgent(page);
    const usageRoute = buildSettingsHostSectionRoute(getServerId(), "usage");
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      const agentUrl = page.url();
      const meter = page.getByTestId("context-window-meter");
      await meter.click();
      await page.waitForTimeout(500);
      await expect(page).toHaveURL(agentUrl);
      await meter.click({ delay: 600 });
      await expect(page).toHaveURL(agentUrl);
      await meter.dblclick({ delay: 80 });
      await expect(page).toHaveURL(new RegExp(`${usageRoute}$`));

      await openAgentRoute(page, session);
      const panel = await openCommandCenter(page);
      await panel.getByTestId("command-center-input").fill("Usage");
      await expect(panel.getByText("Usage", { exact: true })).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`${usageRoute}$`));
      await expect(panel).toBeHidden();

      await page.goto("/new?serverId=stale-host");
      const newWorkspacePanel = await openCommandCenter(page);
      await newWorkspacePanel.getByTestId("command-center-input").fill("Usage");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`${usageRoute}$`));
    } finally {
      await session.cleanup();
    }
  });

  test("fetches usage when the context tooltip opens and renders the active provider", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [
              {
                id: "session",
                label: "Session",
                usedPct: 42,
                remainingPct: 58,
                resetsAt: "2026-06-19T05:00:00.000Z",
              },
            ],
          },
        ],
      },
    ]);
    const session = await openMockAgent(page);
    try {
      expect(usageFixture.requestCount()).toBe(0);

      await page.getByTestId("context-window-meter").hover();
      await usageFixture.waitForRequestCount(1);

      await expect(page.getByText("Mock provider", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Test plan")).toBeVisible();
      await expect(page.getByText("Session", { exact: true })).toBeVisible();
      await expect(page.getByText("42%")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("refreshes usage again each time the tooltip is shown", async ({ page }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [{ id: "session", label: "Session", usedPct: 41 }],
          },
        ],
      },
      {
        fetchedAt: "2026-06-19T00:01:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [{ id: "session", label: "Session", usedPct: 64 }],
          },
        ],
      },
    ]);
    const session = await openMockAgent(page);
    try {
      const meter = page.getByTestId("context-window-meter");

      await meter.hover();
      await usageFixture.waitForRequestCount(1);
      await expect(page.getByText("41%")).toBeVisible({ timeout: 10_000 });

      await page.mouse.move(0, 0);
      await expect(page.getByText("Mock provider", { exact: true })).toHaveCount(0);

      await meter.hover();
      await usageFixture.waitForRequestCount(2);
      expect(usageFixture.requestCount()).toBe(2);
      await expect(page.getByText("64%")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });
});
