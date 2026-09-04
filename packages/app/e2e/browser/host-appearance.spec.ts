import { expect, test as base } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  addConnectedHostAndReload,
  chooseHostBadgeDisplay,
  chooseHostColor,
  expectHostAppearancePreview,
  expectHostBadgeIconOnly,
  expectHostBadgeName,
  expectHostBadgeTinted,
  expectNoHostBadge,
  leaveHostAppearanceSettings,
  openHostAppearanceSettings,
  reloadPreservingHostRegistry,
  renameHostFromSettings,
  waitForConnectedHost,
} from "../support/helpers/hosts";
import {
  type IsolatedHostDaemon,
  startIsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { openGlobalNewWorkspaceComposer } from "../support/helpers/new-workspace";
import {
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
} from "../support/helpers/workspace-ui";
import { identityForeground } from "@/styles/identity-colors";

const PRIMARY_HOST_LABEL = "Primary Host";
const SECONDARY_HOST_LABEL = "Secondary Host";

interface TwoHostSidebar {
  primaryServerId: string;
  primaryWorkspaceId: string;
  secondaryServerId: string;
  secondaryWorkspaceId: string;
}

// The host badge only appears once the visible sidebar spans more than one host, and that count
// runs over visible projects — so an offline host with no workspaces will not raise it. Two real
// daemons, each with a seeded workspace, is the minimum shape that exercises the feature.
const test = base.extend<{ twoHostSidebar: TwoHostSidebar }>({
  twoHostSidebar: async ({ page }, provide) => {
    const secondaryHost: IsolatedHostDaemon = await startIsolatedHostDaemon(
      "host-appearance-secondary",
    );
    let primary: SeededWorkspace | null = null;
    let secondary: SeededWorkspace | null = null;

    try {
      primary = await seedWorkspace({
        repoPrefix: "host-appearance-primary-",
        title: "Primary workspace",
      });
      secondary = await seedWorkspace({
        repoPrefix: "host-appearance-secondary-",
        title: "Secondary workspace",
        port: secondaryHost.port,
      });

      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: secondaryHost.serverId,
        label: SECONDARY_HOST_LABEL,
        port: secondaryHost.port,
        primaryLabel: PRIMARY_HOST_LABEL,
      });
      await waitForConnectedHost(page, {
        serverId: secondaryHost.serverId,
        endpoint: `localhost:${secondaryHost.port}`,
      });
      await waitForSidebarHydration(page);

      await provide({
        primaryServerId: getServerId(),
        primaryWorkspaceId: primary.workspaceId,
        secondaryServerId: secondaryHost.serverId,
        secondaryWorkspaceId: secondary.workspaceId,
      });
    } finally {
      await primary?.cleanup().catch(() => undefined);
      await secondary?.cleanup().catch(() => undefined);
      await secondaryHost.close().catch(() => undefined);
    }
  },
});

test.describe.configure({ timeout: 180_000 });

test("customizes a host badge and preserves its appearance after reload", async ({
  page,
  twoHostSidebar,
}) => {
  const badge = {
    serverId: twoHostSidebar.secondaryServerId,
    workspaceId: twoHostSidebar.secondaryWorkspaceId,
  };
  const hostName = "Developer MacBook Pro.local";

  await test.step("rename the host and use its available sidebar width", async () => {
    await expectHostBadgeName(page, { ...badge, hostName: SECONDARY_HOST_LABEL });
    await openHostAppearanceSettings(page, badge.serverId);
    await renameHostFromSettings(page, hostName);
    await leaveHostAppearanceSettings(page);
    await expectHostBadgeName(page, { ...badge, hostName });

    const row = page.getByTestId(`sidebar-workspace-row-${badge.serverId}:${badge.workspaceId}`);
    const hostBadge = row.getByTestId(`host-badge-${badge.serverId}`);
    const [badgeBox, rowBox] = await Promise.all([hostBadge.boundingBox(), row.boundingBox()]);
    expect(badgeBox).not.toBeNull();
    expect(rowBox).not.toBeNull();
    expect(badgeBox!.width).toBeGreaterThan(96);
    expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width);
    const widths = await hostBadge.getByText(hostName, { exact: true }).evaluate((label) => ({
      client: label.clientWidth,
      content: label.scrollWidth,
    }));
    expect(widths.content).toBeLessThanOrEqual(widths.client);
  });

  await test.step("preview a color and apply it to the sidebar badge", async () => {
    await openHostAppearanceSettings(page, badge.serverId);
    await chooseHostColor(page, "Teal");
    await expectHostAppearancePreview(page, { serverId: badge.serverId, hostName, color: "teal" });
    await leaveHostAppearanceSettings(page);
    await expectHostBadgeTinted(page, { ...badge, hostName, color: "teal" });
  });

  await test.step("keep the icon-only preference through reload", async () => {
    await openHostAppearanceSettings(page, badge.serverId);
    await chooseHostBadgeDisplay(page, "Icon only");
    await leaveHostAppearanceSettings(page);
    await expectHostBadgeIconOnly(page, { ...badge, hostName });
    await reloadPreservingHostRegistry(page);
    await waitForSidebarHydration(page);
    await expectHostBadgeIconOnly(page, { ...badge, hostName });
  });

  await test.step("hide this badge without hiding the other host", async () => {
    await openHostAppearanceSettings(page, badge.serverId);
    await chooseHostBadgeDisplay(page, "Hidden");
    await leaveHostAppearanceSettings(page);
    await expectNoHostBadge(page, { ...badge, hostName });
    await expectHostBadgeName(page, {
      serverId: twoHostSidebar.primaryServerId,
      workspaceId: twoHostSidebar.primaryWorkspaceId,
      hostName: PRIMARY_HOST_LABEL,
    });
  });
  // The wide layout keeps the sidebar open, but the header still names the host: it follows the
  // host's display mode alone, so Hidden removes it while the project name stays.
  test("the workspace header names the host on the wide layout", async ({
    page,
    twoHostSidebar,
  }) => {
    const target = {
      serverId: twoHostSidebar.secondaryServerId,
      workspaceId: twoHostSidebar.secondaryWorkspaceId,
    };
    const headerRow = () =>
      page.getByTestId("workspace-header-project-row").filter({ visible: true }).first();
    const headerBadge = () => headerRow().getByTestId(`host-badge-${target.serverId}`);

    await openHostAppearanceSettings(page, target.serverId);
    await chooseHostColor(page, "Teal");
    await leaveHostAppearanceSettings(page);

    await switchWorkspaceViaSidebar({ page, ...target });
    await expect(headerBadge()).toBeVisible({ timeout: 30_000 });
    await expect(headerBadge()).toHaveText(SECONDARY_HOST_LABEL);
    await expect(headerBadge().locator("svg")).toHaveAttribute(
      "stroke",
      identityForeground("teal", "light"),
    );

    await openHostAppearanceSettings(page, target.serverId);
    await chooseHostBadgeDisplay(page, "Hidden");
    await leaveHostAppearanceSettings(page);

    await switchWorkspaceViaSidebar({ page, ...target });
    await expect(headerRow().getByTestId("workspace-header-subtitle")).toBeVisible();
    await expect(headerBadge()).toHaveCount(0);
  });

  // Web paints the badge label from a registered style, so the pill is held to the same paint
  // as the sidebar badge for the same host rather than to a hex the two could drift from.
  test("the new-workspace host pill wears the host color", async ({ page, twoHostSidebar }) => {
    await openHostAppearanceSettings(page, twoHostSidebar.secondaryServerId);
    await chooseHostColor(page, "Teal");
    await leaveHostAppearanceSettings(page);

    await openGlobalNewWorkspaceComposer(page);
    const trigger = page.getByTestId("host-picker-trigger");
    const pillLabel = (label: string) => trigger.getByText(label, { exact: true });
    const pickHost = async (serverId: string) => {
      await trigger.click();
      await page.getByTestId(`new-workspace-host-picker-option-${serverId}`).click();
    };
    const computedColor = (locator: ReturnType<typeof pillLabel>) =>
      locator.evaluate((element) => getComputedStyle(element).color);

    // The primary host has no color, so its label is the pill's muted default.
    await pickHost(twoHostSidebar.primaryServerId);
    await expect(pillLabel(PRIMARY_HOST_LABEL)).toBeVisible();
    const mutedColor = await computedColor(pillLabel(PRIMARY_HOST_LABEL));

    await pickHost(twoHostSidebar.secondaryServerId);
    await expect(pillLabel(SECONDARY_HOST_LABEL)).toBeVisible();
    const sidebarLabel = page
      .getByTestId(
        `sidebar-workspace-row-${twoHostSidebar.secondaryServerId}:${twoHostSidebar.secondaryWorkspaceId}`,
      )
      .getByTestId(`host-badge-${twoHostSidebar.secondaryServerId}`)
      .getByText(SECONDARY_HOST_LABEL, { exact: true });
    const badgeColor = await computedColor(sidebarLabel);
    expect(badgeColor).not.toBe(mutedColor);
    await expect(pillLabel(SECONDARY_HOST_LABEL)).toHaveCSS("color", badgeColor);
  });
});
