import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { buildSchedulesRoute } from "../../src/utils/host-routes";

async function installSaveFailure(page: Page) {
  let failNextSave = false;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      const raw = typeof message === "string" ? message : message.toString("utf8");
      const envelope = JSON.parse(raw) as {
        type?: string;
        message?: { type?: string; requestId?: string };
      };
      const request = envelope.type === "session" ? envelope.message : undefined;
      if (failNextSave && request?.type === "schedule/update") {
        failNextSave = false;
        browser.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "rpc_error",
              payload: {
                requestId: request.requestId,
                requestType: request.type,
                error: "Schedule storage unavailable",
                code: "handler_error",
              },
            },
          }),
        );
      } else {
        server.send(message);
      }
    });
    server.onMessage((message) => browser.send(message));
  });
  return () => {
    failNextSave = true;
  };
}

for (const isolation of ["local", "worktree"] as const) {
  test(`schedule labels persist and apply to ${isolation} workspaces`, async ({ page }) => {
    test.setTimeout(120_000);
    const workspace = await seedWorkspace({
      repoPrefix: "schedule-labels-",
      git: isolation === "worktree",
    });
    const client = workspace.client as unknown as DaemonClient;
    const label = { name: "Scheduled review", color: "red" } as const;
    const secondLabel = { name: "Zebra automation", color: "sky" } as const;
    let labelName: string = label.name;
    let scheduleId: string | undefined;
    const failNextSave = await installSaveFailure(page);
    try {
      await client.setWorkspaceLabel({
        workspaceId: workspace.workspaceId,
        label: secondLabel,
        assigned: true,
      });
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await page.goto(buildSchedulesRoute());
      await page.getByTestId("schedules-empty-new").click();
      await page.getByRole("button", { name: /select project/i }).click();
      await page
        .getByTestId(`schedule-project-option-${projectEquivalenceViewKey(workspace.projectKey)}`)
        .click();
      await page.getByRole("button", { name: /select model/i }).click();
      await page.getByTestId("model-search-input").first().fill("Ten second stream");
      await page
        .getByTestId("combobox-desktop-container")
        .getByText("Ten second stream", { exact: true })
        .first()
        .click();
      if (isolation === "worktree") {
        await page.getByTestId("schedule-isolation-trigger").click();
        await page.getByTestId("schedule-isolation-worktree").click();
      }
      await page.getByTestId("schedule-archive-on-finish-switch").click();
      await page.getByTestId("schedule-labels-trigger").click();
      await page.getByTestId("workspace-label-picker-create").click();
      await page.getByTestId("workspace-label-picker-create-name").fill(label.name);
      await page.getByTestId(`workspace-label-swatch-${label.color}`).click();
      await page.getByTestId("workspace-label-picker-create-submit").click();
      await expect(page.getByTestId(`schedule-label-option-${label.name}`)).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(page.getByTestId(/^schedule-label-option-/)).toHaveText([
        label.name,
        secondLabel.name,
      ]);
      expect(
        (await client.fetchWorkspaces()).entries.find((entry) => entry.id === workspace.workspaceId)
          ?.labels,
      ).toEqual([secondLabel.name]);
      await page.getByTestId(`schedule-label-option-${secondLabel.name}`).click();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("schedule-labels-trigger")).toContainText(label.name);
      await page.getByLabel("Schedule name").fill("Labelled schedule");
      await page.getByLabel("Prompt").fill("Review this workspace.");
      await page.getByTestId("schedule-labels-trigger").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/schedule-labels-${isolation}-create.png` });
      await page.getByRole("button", { name: "Create schedule", exact: true }).click();
      await expect(page.getByTestId("schedule-form-sheet")).toHaveCount(0);

      const listed = await client.scheduleList();
      const schedule = listed.schedules.find((entry) => entry.name === "Labelled schedule");
      expect(schedule?.target).toMatchObject({
        config: { workspaceLabels: [labelName, secondLabel.name], isolation },
      });
      scheduleId = schedule!.id;
      const firstRun = await client.scheduleRunOnce({ id: scheduleId });
      expect(firstRun.error).toBeNull();
      expect(firstRun.schedule?.runs[0]).toMatchObject({ status: "succeeded" });
      const firstWorkspaceId = firstRun.schedule!.runs[0]!.workspaceId;
      expect(firstWorkspaceId).not.toBe(workspace.workspaceId);
      const afterFirstRun = await client.fetchWorkspaces();
      expect(afterFirstRun.entries.find((entry) => entry.id === firstWorkspaceId)?.labels).toEqual([
        label.name,
        secondLabel.name,
      ]);

      if (isolation === "worktree") await page.setViewportSize({ width: 390, height: 844 });
      await page.getByTestId(`schedule-row-${scheduleId}`).click();
      await expect(page.getByTestId("schedule-labels-trigger")).toContainText(label.name);
      await expect(page.getByTestId("schedule-labels-trigger")).toContainText(secondLabel.name);
      if (isolation === "local") {
        labelName = "Renamed review";
        await client.updateWorkspaceLabel({ name: label.name, newName: labelName });
        await expect(page.getByTestId("schedule-labels-trigger")).toContainText(labelName);
      }
      await page.getByTestId("schedule-labels-trigger").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/schedule-labels-${isolation}-edit.png` });
      await page.getByTestId("schedule-labels-trigger").click();
      await page.getByTestId(`schedule-label-option-${labelName}`).click();
      await page.getByTestId(`schedule-label-option-${secondLabel.name}`).click();
      if (isolation === "worktree") {
        await page
          .getByRole("button", { name: "Bottom sheet backdrop", exact: true })
          .last()
          .click();
      } else {
        await page.keyboard.press("Escape");
      }
      await expect(page.getByTestId("schedule-labels-trigger")).toContainText("Unlabelled");
      failNextSave();
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText(/Schedule storage unavailable/)).toBeVisible();
      await expect(page.getByTestId("schedule-labels-trigger")).toContainText("Unlabelled");
      expect((await client.scheduleInspect({ id: scheduleId })).schedule?.target).toMatchObject({
        config: { workspaceLabels: [labelName, secondLabel.name] },
      });
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByTestId("schedule-form-sheet")).toHaveCount(0);
      expect(
        (await client.scheduleInspect({ id: scheduleId })).schedule?.target,
      ).not.toHaveProperty("config.workspaceLabels");

      const secondRun = await client.scheduleRunOnce({ id: scheduleId });
      expect(secondRun.error).toBeNull();
      expect(secondRun.schedule?.runs[1]).toMatchObject({ status: "succeeded" });
      const afterSecondRun = await client.fetchWorkspaces();
      const secondWorkspace = afterSecondRun.entries.find(
        (entry) => entry.id === secondRun.schedule!.runs[1]!.workspaceId,
      );
      expect(secondWorkspace).toHaveProperty("id", secondRun.schedule!.runs[1]!.workspaceId);
      expect(secondWorkspace?.labels ?? []).toEqual([]);
      expect(afterSecondRun.entries.find((entry) => entry.id === firstWorkspaceId)?.labels).toEqual(
        [labelName, secondLabel.name],
      );
      await page.screenshot({ path: `/tmp/schedule-labels-${isolation}.png` });
    } finally {
      if (scheduleId) await client.scheduleDelete({ id: scheduleId });
      await client.deleteWorkspaceLabel({ name: labelName });
      await client.deleteWorkspaceLabel({ name: secondLabel.name });
      await workspace.cleanup();
    }
  });
}
