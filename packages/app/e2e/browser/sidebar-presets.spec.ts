import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openCommandCenter } from "../support/helpers/command-center";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { expectSidebarGrouping } from "../support/helpers/sidebar";

async function openPresetsMenu(page: Page): Promise<void> {
  await page.getByTestId("sidebar-presets-menu").click();
  await expect(page.getByTestId("sidebar-presets-content")).toBeVisible({ timeout: 30_000 });
}

async function savePresetFromMenu(page: Page, name: string): Promise<void> {
  await openPresetsMenu(page);
  await page.getByTestId("sidebar-presets-save").click();
  const input = page.getByTestId("sidebar-preset-name-dialog-input");
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill(name);
  await page.getByTestId("sidebar-preset-name-dialog-submit").click();
  await expect(input).not.toBeVisible({ timeout: 30_000 });
}

test.describe("Sidebar presets", () => {
  test.describe.configure({ timeout: 120_000 });
  let workspace: SeededWorkspace | null = null;

  test.afterEach(async () => {
    const seeded = workspace;
    workspace = null;
    await seeded?.cleanup();
  });

  test("saves, drifts from, updates, re-applies and clears a preset", async ({ page }) => {
    workspace = await seedWorkspace({ repoPrefix: "sidebar-presets-" });
    await gotoAppShell(page);
    await expectSidebarGrouping(page, "project");

    // Nothing selected: a plain icon, and an empty list.
    await expect(page.getByTestId("sidebar-presets-icon")).toBeVisible();
    await openPresetsMenu(page);
    await expect(page.getByTestId("sidebar-presets-empty")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByTestId("sidebar-grouping-toggle").click();
    await expectSidebarGrouping(page, "status");
    await savePresetFromMenu(page, "By status");

    await expect(page.getByTestId("sidebar-presets-icon-active")).toBeVisible();
    await expect(page.getByTestId("sidebar-presets-modified")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-presets-menu")).toHaveAttribute(
      "aria-label",
      "Sidebar preset: By status",
    );

    // Drift: the dot appears and Update becomes available.
    await page.getByTestId("sidebar-grouping-toggle").click();
    await expectSidebarGrouping(page, "project");
    await expect(page.getByTestId("sidebar-presets-modified")).toBeVisible();

    // Re-applying the active preset throws the drift away.
    await openPresetsMenu(page);
    await page
      .getByTestId("sidebar-presets-content")
      .getByText("By status", { exact: true })
      .click();
    await expectSidebarGrouping(page, "status");
    await expect(page.getByTestId("sidebar-presets-modified")).toHaveCount(0);

    // Update overwrites the preset with the current view.
    await page.getByTestId("sidebar-grouping-toggle").click();
    await expectSidebarGrouping(page, "project");
    await openPresetsMenu(page);
    await page.getByTestId("sidebar-presets-update").click();
    await expect(page.getByTestId("sidebar-presets-modified")).toHaveCount(0);

    // Clear filters drops the active preset.
    await openPresetsMenu(page);
    await page.getByTestId("sidebar-presets-clear-filters").click();
    await expect(page.getByTestId("sidebar-presets-icon")).toBeVisible();

    // The command center lists the preset and applies it.
    await page.getByTestId("sidebar-grouping-toggle").click();
    await expectSidebarGrouping(page, "status");
    const panel = await openCommandCenter(page);
    await panel.getByTestId("command-center-input").fill("preset");
    await expect(panel.getByText("Save sidebar preset…", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await panel.getByText("By status", { exact: true }).click();
    await expect(panel).not.toBeVisible({ timeout: 30_000 });
    await expectSidebarGrouping(page, "project");
    await expect(page.getByTestId("sidebar-presets-icon-active")).toBeVisible();

    // Presets survive a reload.
    await page.reload();
    await expect(page.getByTestId("sidebar-presets-icon-active")).toBeVisible({ timeout: 30_000 });
  });
});
