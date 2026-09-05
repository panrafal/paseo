// Records what a real VS Code drag puts on the DataTransfer.
//
// Paseo can only turn a drop into a prompt reference when the drag carries a path, and VS Code
// decides which mime types it sets per drag source. This launches the downloaded VS Code on a
// throwaway workspace, drags an Explorer row and an editor tab, and prints every type with its
// value. Run it when a drop stops producing a reference and you need to know whether the payload
// or Paseo's handling is at fault.
//
// Usage (node 22):
//   node packages/vscode/scripts/cdp-drag-probe.mjs
import { chromium } from "playwright";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchVsCode, sleep, waitForCdp, waitForWorkbench } from "./lib/cdp-harness.mjs";

const CDP_PORT = Number(process.env.PASEO_CDP_PORT ?? 9223);
const log = (...args) => console.log("[drag-probe]", ...args);

const RECORDER = () => {
  const probe = { events: [] };
  window.__paseoDragProbe = probe;
  // Bubble phase on window: VS Code fills the DataTransfer in the tree/tab handler below us.
  window.addEventListener("dragstart", (event) => {
    const transfer = event.dataTransfer;
    if (!transfer) {
      probe.events.push({ types: null });
      return;
    }
    const data = {};
    for (const type of transfer.types) {
      try {
        data[type] = transfer.getData(type);
      } catch (error) {
        data[type] = `<getData threw: ${String(error)}>`;
      }
    }
    probe.events.push({
      types: Array.from(transfer.types),
      itemKinds: Array.from(transfer.items ?? []).map((item) => item.kind),
      fileCount: transfer.files?.length ?? 0,
      data,
    });
  });
};

function createWorkspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-drag-probe-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "alpha.ts"), "export const alpha = 1;\n");
  writeFileSync(path.join(dir, "src", "beta.ts"), "export const beta = 2;\n");
  return dir;
}

async function runCommand(workbench, command) {
  await workbench.keyboard.press("Meta+Shift+P");
  const quickInput = workbench.locator(".quick-input-widget input").first();
  await quickInput.waitFor({ state: "visible", timeout: 10000 });
  await workbench.keyboard.type(command);
  await sleep(700);
  await workbench.keyboard.press("Enter");
  await sleep(1000);
  log("ran command:", command);
}

async function dragFrom(page, locator, label) {
  const before = await page.evaluate(() => window.__paseoDragProbe?.events.length ?? 0);
  const target = page.locator(".monaco-workbench").first();
  await locator.dragTo(target, { timeout: 15000, force: true }).catch((error) => {
    log(`${label}: dragTo reported`, error.message.split("\n")[0]);
  });
  await sleep(500);
  const events = await page.evaluate(() => window.__paseoDragProbe?.events ?? []);
  const recorded = events.slice(before);
  if (recorded.length === 0) {
    log(`${label}: no dragstart recorded`);
    return;
  }
  for (const event of recorded) {
    log(`${label}:`, JSON.stringify(event, null, 2));
  }
}

// @vscode/test-electron still points at Contents/MacOS/Electron; VS Code renamed it to Code.
function resolveExecutable(executable) {
  if (existsSync(executable)) {
    return executable;
  }
  const renamed = path.join(path.dirname(executable), "Code");
  if (existsSync(renamed)) {
    return renamed;
  }
  return executable;
}

async function main() {
  const executable = resolveExecutable(await downloadAndUnzipVSCode());
  const workspaceDir = createWorkspace();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "paseo-drag-probe-user-"));
  log("workspace", workspaceDir);

  const extensionsDir = mkdtempSync(path.join(tmpdir(), "paseo-drag-probe-ext-"));
  const child = launchVsCode(executable, {
    cdpPort: CDP_PORT,
    userDataDir,
    workspaceDir,
    // Without this VS Code loads the developer's own extensions, whose notifications steal focus.
    extraArgs: [`--extensions-dir=${extensionsDir}`],
    logLaunch: ({ args }) => log("launching", args.join(" ")),
  });

  let browser;
  try {
    await waitForCdp(CDP_PORT, 60000, { errorMessage: (port) => `No CDP on ${port}` });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const workbench = await waitForWorkbench(browser, 60000);
    await sleep(2000);
    await workbench.evaluate(RECORDER);

    await runCommand(workbench, "File: Focus on Files Explorer");
    await sleep(2000);
    log(
      "workbench shell:",
      JSON.stringify(
        await workbench.evaluate(() => ({
          activityBar: Array.from(document.querySelectorAll(".activitybar [aria-label]")).map(
            (item) => item.getAttribute("aria-label"),
          ),
          hasExplorerView: !!document.querySelector(".explorer-folders-view"),
          listCount: document.querySelectorAll(".monaco-list-row").length,
        })),
      ),
    );
    const listRows = async () =>
      await workbench.evaluate(() =>
        Array.from(document.querySelectorAll(".monaco-list-row")).map((row) => ({
          label: row.getAttribute("aria-label"),
          text: (row.textContent ?? "").trim().slice(0, 40),
        })),
      );
    log("rows after opening explorer:", JSON.stringify(await listRows()));

    await workbench
      .locator(".monaco-list-row", { hasText: "src" })
      .first()
      .click({ timeout: 10000 })
      .catch(() => log("could not expand src"));
    await sleep(1500);
    log("rows after expanding src:", JSON.stringify(await listRows()));

    await dragFrom(
      workbench,
      workbench.locator(".monaco-list-row", { hasText: "alpha.ts" }).first(),
      "explorer row",
    );

    await workbench
      .locator(".monaco-list-row", { hasText: "alpha.ts" })
      .first()
      .dblclick({ timeout: 10000 })
      .catch(() => log("could not open editor"));
    await sleep(1500);
    await dragFrom(workbench, workbench.locator(".tabs-container .tab").first(), "editor tab");
  } finally {
    await browser?.close().catch(() => {});
    child.kill("SIGTERM");
    await sleep(500);
    child.kill("SIGKILL");
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[drag-probe] failed:", error);
  process.exit(1);
});
