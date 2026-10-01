import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openCommandCenter } from "../support/helpers/command-center";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { buildSettingsHostSectionRoute } from "../../src/utils/host-routes";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

// Where the progress arc is painted, as its centroid relative to the ring's centre in pixels.
// Reads the rendered pixels, so any rotation that does not reach the screen counts as none.
async function progressArcCentroid(meter: Locator): Promise<{ x: number; y: number }> {
  const ring = meter.locator("svg");
  const progressColor = await ring
    .locator("circle")
    .last()
    .evaluate((circle) => getComputedStyle(circle).stroke);
  const screenshot = await ring.screenshot();
  return ring.evaluate(
    async (_svg, { png, color }) => {
      const image = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${png}`)).blob(),
      );
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      const [r, g, b] = color.match(/\d+/g)!.map(Number);
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          const i = (y * image.width + x) * 4;
          const distance =
            Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b);
          if (distance < 40) {
            sumX += x;
            sumY += y;
            count += 1;
          }
        }
      }
      if (count === 0) {
        throw new Error(`No pixels painted in the progress colour ${color}`);
      }
      return { x: sumX / count - image.width / 2, y: sumY / count - image.height / 2 };
    },
    { png: screenshot.toString("base64"), color: progressColor },
  );
}

async function openMockAgent(page: Page) {
  await page.setViewportSize(MOBILE_VIEWPORT);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "context-window-meter-usage-",
    title: "Context window meter usage e2e",
    initialPrompt: "emit 1 coalesced agent stream update for context window meter usage.",
  });
  await openAgentRoute(page, session);
  await expectComposerVisible(page);
  await expect(page.getByTestId("context-window-meter")).toBeVisible({ timeout: 30_000 });
  return session;
}

test.describe("context window meter", () => {
  test("draws usage clockwise from twelve o'clock", async ({ page }) => {
    test.setTimeout(180_000);
    // 32,000 of the mock's 128,000-token window: a quarter, from twelve to three o'clock.
    const session = await seedMockAgentWorkspace({
      repoPrefix: "context-window-meter-",
      title: "Context window meter e2e",
      initialPrompt: "emit 32000 byte file agent stream payload",
    });
    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      const meter = page.getByTestId("context-window-meter");
      await expect(meter).toHaveAccessibleName(/25%/, { timeout: 30_000 });

      const centroid = await progressArcCentroid(meter);
      expect(centroid.x).toBeGreaterThan(1);
      expect(centroid.y).toBeLessThan(-1);
    } finally {
      await session.cleanup();
    }
  });

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
});
