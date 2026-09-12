import { rename } from "node:fs/promises";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  openNewWorkspaceComposer,
  selectWorkspaceIsolation,
} from "../support/helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

function recordCreations(page: Page) {
  const prompts: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const envelope = JSON.parse(payload);
      if (envelope.type === "session" && envelope.message?.type === "create_agent_request") {
        prompts.push(envelope.message.initialPrompt);
      }
    });
  });
  return prompts;
}

async function openDraft(page: Page, workspace: SeededWorkspace, prompt: string) {
  await openNewWorkspaceComposer(page, {
    projectKey: workspace.projectKey,
    projectDisplayName: workspace.projectDisplayName,
  });
  await selectWorkspaceIsolation(page, "local");
  await page.getByRole("textbox", { name: "Message agent..." }).fill(prompt);
  const create = page.getByTestId("workspace-create-submit");
  await expect(create).toBeEnabled();
  return create;
}

test("New Workspace submits one chat before React renders the pending state", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "duplicate-workspace-submit-" });
  const prompts = recordCreations(page);
  const prompt = "One new workspace chat";
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const create = await openDraft(page, workspace, prompt);
    // Deliver both events in one task, before preference writes and React's
    // pending render finish. This reproduces reentry without relying on timing.
    await create.evaluate((button: HTMLElement) => {
      button.click();
      button.click();
    });

    await expect(page.getByTestId(/^workspace-tab-agent_/).first()).toBeVisible({
      timeout: 30_000,
    });
    expect(prompts).toEqual([prompt]);
    const agents = await workspace.client.fetchAgents({ scope: "active" });
    expect(agents.entries.map(({ agent }) => agent.cwd)).toEqual([workspace.repoPath]);

    const nextCreate = await openDraft(page, workspace, "A separate new workspace chat");
    await nextCreate.click();
    await expect(
      page
        .getByTestId(/^workspace-tab-agent_/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    expect(prompts).toEqual([prompt, "A separate new workspace chat"]);
  } finally {
    await workspace.cleanup();
  }
});

test("New Workspace allows retry after creation fails", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "retry-workspace-submit-" });
  const prompts = recordCreations(page);
  const prompt = "Retry this new workspace chat";
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const create = await openDraft(page, workspace, prompt);
    const movedPath = `${workspace.repoPath}-unavailable`;
    await rename(workspace.repoPath, movedPath);
    try {
      await create.click();
      await expect(
        page.getByText(`Directory not found: ${workspace.repoPath}`, { exact: true }).first(),
      ).toBeVisible();
      await expect(create).toBeEnabled();
      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await expect(composer).toBeEditable();
      await expect(composer).toHaveValue(prompt);
      expect(prompts).toEqual([]);
    } finally {
      await rename(movedPath, workspace.repoPath);
    }

    await create.click();
    await expect(page.getByTestId(/^workspace-tab-agent_/).first()).toBeVisible({
      timeout: 30_000,
    });
    expect(prompts).toEqual([prompt]);
  } finally {
    await workspace.cleanup();
  }
});
