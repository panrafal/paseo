import { chromium } from "playwright";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  answerPasswordPrompt,
  launchVsCode,
  openPaseo,
  sleep,
  waitForAppFrame,
  waitForCdp,
  waitForWorkbench,
} from "./lib/cdp-harness.mjs";
import { startDaemon } from "./lib/daemon-harness.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const vscodeVersion = process.env.PASEO_VSCODE_TEST_VERSION ?? "1.124.2";
const daemonPort = Number(process.env.PASEO_VSCODE_E2E_DAEMON_PORT ?? 6788);
const cdpPort = Number(process.env.PASEO_VSCODE_E2E_CDP_PORT ?? 9230);
const runHeadless = process.env.PASEO_VSCODE_E2E_HEADLESS === "1";
const artifactDir =
  process.env.PASEO_VSCODE_E2E_ARTIFACT_DIR ?? path.join(packageRoot, "artifacts", "vscode-e2e");
const workspaceMarkerSelector = '[data-testid="workspace-header-title"]';
const splashSelector = '[data-testid="startup-splash"]';

const log = (...args) => console.log("[vscode-e2e]", ...args);

async function readWorkspaceState(frame) {
  return frame.evaluate(
    (selectors) => {
      const workspaceMarker = document.querySelector(selectors.workspaceMarker);
      return {
        bodyTextHead: (document.body?.innerText ?? "").slice(0, 1200),
        hasMessageInputRoot: !!document.querySelector('[data-testid="message-input-root"]'),
        hasSplash: !!document.querySelector(selectors.splash),
        hasWorkspaceMarker: !!workspaceMarker,
        hasWorkspaceTabsRow: !!document.querySelector('[data-testid="workspace-tabs-row"]'),
        rootChildCount: document.querySelector("#root")?.childElementCount ?? -1,
        url: location.href,
        workspaceTitle: workspaceMarker?.textContent?.trim() ?? "",
      };
    },
    { splash: splashSelector, workspaceMarker: workspaceMarkerSelector },
  );
}

async function waitForWorkspace(frame, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await readWorkspaceState(frame).catch((error) => ({ error: error.message }));
    if (
      !lastState.hasSplash &&
      (lastState.hasWorkspaceMarker ||
        lastState.hasMessageInputRoot ||
        lastState.hasWorkspaceTabsRow)
    ) {
      return lastState;
    }
    await sleep(300);
  }
  throw new Error(
    `Paseo workspace did not render before timeout. Last state: ${JSON.stringify(lastState)}`,
  );
}

async function readMessageInputState(frame) {
  return frame.evaluate(() => {
    const textarea = Array.from(
      document.querySelectorAll('[data-testid="message-input-root"] textarea'),
    ).find(
      (candidate) =>
        candidate instanceof HTMLTextAreaElement &&
        candidate.getClientRects().length > 0 &&
        getComputedStyle(candidate).visibility !== "hidden",
    );
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return { present: false };
    }
    return {
      present: true,
      focused: document.activeElement === textarea,
      value: textarea.value,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    };
  });
}

async function waitForMessageInputState(frame, timeoutMs, predicate, label) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await readMessageInputState(frame).catch((error) => ({ error: error.message }));
    if (predicate(lastState)) {
      return lastState;
    }
    await sleep(150);
  }
  throw new Error(
    `editing-shortcuts: ${label} not reached. Last state: ${JSON.stringify(lastState)}`,
  );
}

// Guards the bootstrap's capture-phase editing-shortcut handler
// (webview-preload/editing-shortcuts.ts). The modifier has to match the host: the handler takes
// Cmd on macOS and Ctrl elsewhere, and sending the wrong one reaches no handler at all.
async function runEditingShortcutsProbe(appFrame) {
  const isMac = process.platform === "darwin";
  const probeText = `paseo edit probe ${Date.now()}`;
  const textarea = appFrame.locator('[data-testid="message-input-root"] textarea:visible').first();
  await textarea.click();
  await waitForMessageInputState(appFrame, 10_000, (s) => s.present && s.focused, "composer focus");

  const keyboard = appFrame.page().keyboard;
  await keyboard.type(probeText);
  await waitForMessageInputState(
    appFrame,
    10_000,
    (s) => s.value === probeText,
    "typed probe text",
  );

  // A synthetic (untrusted) select-all cannot trigger the browser's native
  // select-all, so a full selection here proves the bootstrap handler itself
  // handled the combo. This is what fails if the capture listener is removed.
  await appFrame.evaluate((useMeta) => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        ctrlKey: !useMeta,
        metaKey: useMeta,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, isMac);
  await waitForMessageInputState(
    appFrame,
    5_000,
    (s) => s.selectionStart === 0 && s.selectionEnd === probeText.length,
    "select-all selection",
  );

  // Real keystrokes: the handler preventDefaults the native editing path, so a
  // successful cut/paste round-trip proves document.execCommand("cut"/"paste")
  // works against the real clipboard inside the webview.
  const modifier = isMac ? "Meta" : "Control";
  await keyboard.press(`${modifier}+x`);
  await waitForMessageInputState(appFrame, 5_000, (s) => s.value === "", "cut emptied composer");

  await keyboard.press(`${modifier}+v`);
  await waitForMessageInputState(
    appFrame,
    5_000,
    (s) => s.value === probeText,
    "paste restored probe text",
  );

  log("editing-shortcuts passed");
}

// Guards the drop-to-reference path (use-drop-listeners.ts -> composer). VS Code blanks the
// webview iframe's pointer events for the length of a workbench drag unless Shift is held, which
// a synthetic drag cannot reproduce, so this dispatches the drop with the exact payload a real
// VS Code drag carries — captured by scripts/cdp-drag-probe.mjs — and checks the composer text.
// Two payloads, because the Explorer and an editor tab do not agree on which types they set.
async function runComposerDropProbe(appFrame, workspaceDir) {
  const droppedPath = path.join(workspaceDir, "src", "alpha.ts");
  const fileUri = `file://${droppedPath.split(path.sep).map(encodeURIComponent).join("/")}`;
  const sources = [
    {
      label: "explorer row",
      data: {
        "text/plain": droppedPath,
        resourceurls: JSON.stringify([fileUri]),
        "text/uri-list": fileUri,
        "application/vnd.code.uri-list": fileUri,
      },
    },
    { label: "editor tab", data: { "application/vnd.code.uri-list": fileUri } },
    { label: "older VS Code", data: { resourceurls: JSON.stringify([fileUri]) } },
  ];

  const textarea = appFrame.locator('[data-testid="message-input-root"] textarea:visible').first();
  for (const source of sources) {
    await textarea.click();
    await appFrame.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement) {
        active.select();
      }
    });
    await appFrame.page().keyboard.press("Backspace");
    await waitForMessageInputState(appFrame, 5_000, (s) => s.value === "", "composer cleared");

    await appFrame.evaluate((data) => {
      const transfer = new DataTransfer();
      for (const [type, value] of Object.entries(data)) {
        transfer.setData(type, value);
      }
      const target = document.querySelector('[data-testid="message-input-root"]') ?? document.body;
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      }
    }, source.data);

    const state = await waitForMessageInputState(
      appFrame,
      10_000,
      (s) => typeof s.value === "string" && s.value.includes("alpha.ts"),
      `${source.label} drop referenced the file`,
    );
    log(`composer-drop ${source.label} passed:`, JSON.stringify(state.value));
  }

  log("composer-drop passed");
}

// Workbench keybindings do not fire while focus sits in a Paseo text field (see
// docs/vscode-extension.md), so anything driving the palette has to leave the webview first.
// Guards the webview half of "Send to Paseo": the event the extension host posts once it has
// resolved an editor reference, through the bootstrap bridge, the app's listener, the mention
// inbox, and into the composer. The extension-host half — resolving the reference, picking a
// webview, queueing when Paseo is not running — is unit-tested, and the command's registration
// is asserted in the smoke test. Driving the real editor menu is not possible here: the palette
// needs workbench focus, and this probe runs with focus in the composer.
async function runSendToPaseoProbe(appFrame, workspaceDir) {
  const droppedPath = path.join(workspaceDir, "src", "alpha.ts");
  const cases = [
    {
      label: "whole file",
      reference: { path: droppedPath },
      expect: (value) => value.includes("alpha.ts") && !/alpha\.ts:\d/.test(value),
    },
    {
      label: "selected range",
      reference: {
        path: droppedPath,
        selection: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 4 },
      },
      expect: (value) => /alpha\.ts:1:1-2:4/.test(value),
    },
  ];

  const textarea = appFrame.locator('[data-testid="message-input-root"] textarea:visible').first();
  for (const testCase of cases) {
    await textarea.click();
    await appFrame.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement) {
        active.select();
      }
    });
    await appFrame.page().keyboard.press("Backspace");
    await waitForMessageInputState(appFrame, 5_000, (s) => s.value === "", "composer cleared");

    await appFrame.evaluate((reference) => {
      window.postMessage({ kind: "event", event: "send-to-composer", payload: reference }, "*");
    }, testCase.reference);

    const state = await waitForMessageInputState(
      appFrame,
      10_000,
      (s) => typeof s.value === "string" && testCase.expect(s.value),
      `send-to-paseo ${testCase.label}`,
    );
    log(`send-to-paseo ${testCase.label} passed:`, JSON.stringify(state.value));
  }

  log("send-to-paseo passed");
}

async function screenshot(workbench, name) {
  mkdirSync(artifactDir, { recursive: true });
  const file = path.join(artifactDir, `${name}.png`);
  await workbench.screenshot({ path: file }).catch((error) => {
    log("screenshot failed", error.message);
  });
  log("screenshot", file);
}

function writeArtifact(name, data) {
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(path.join(artifactDir, name), `${data}\n`);
}

async function terminateVsCode(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      return undefined;
    }),
  ]);
}

async function runWorkspaceOpenSpec() {
  log("playwright resolves to", import.meta.resolve("playwright"));

  const password = randomBytes(16).toString("hex");
  const daemonHome = mkdtempSync(path.join(os.tmpdir(), "paseo-vscode-e2e-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "paseo-vscode-e2e-workspace-"));
  mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
  writeFileSync(path.join(workspaceDir, "src", "alpha.ts"), "export const alpha = 1;\n");
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "paseo-vscode-e2e-user-"));
  const extensionsDir = mkdtempSync(path.join(os.tmpdir(), "paseo-vscode-e2e-extensions-"));
  const daemon = startDaemon({
    port: daemonPort,
    password,
    home: daemonHome,
    logPrefix: "[vscode-e2e-daemon]",
  });
  let browser = null;
  let workbench = null;
  let vscodeProcess = null;

  try {
    log(`starting password-protected daemon on ${daemon.listen}`);
    await daemon.waitForHealth({ timeoutMs: 30_000 });

    const executable = await downloadAndUnzipVSCode(vscodeVersion);
    vscodeProcess = launchVsCode(executable, {
      cdpPort,
      env: {
        PASEO_VSCODE_ENDPOINT: daemon.listen,
        PASEO_VSCODE_TEST_PASSWORD: password,
      },
      // Isolate extensions: on a developer machine VS Code otherwise loads the user's own, and
      // waitForAppFrame happily latches onto the first webview it finds — someone else's.
      extraArgs: ["--password-store=basic", `--extensions-dir=${extensionsDir}`],
      extraArgsAfterGpu: [
        "--disable-dev-shm-usage",
        ...(runHeadless
          ? ["--headless", "--ozone-platform=headless", "--window-size=1440,900"]
          : []),
      ],
      logLaunch: () =>
        log("launching VS Code", { workspaceDir, cdpPort, daemonListen: daemon.listen }),
      userDataDir,
      workspaceDir,
    });
    const cdpVersion = await waitForCdp(cdpPort, 60_000, {
      errorMessage: (port) => `CDP endpoint did not become ready on port ${port}.`,
    });
    log("CDP ready", cdpVersion.Browser);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    workbench = await waitForWorkbench(browser, 30_000);
    if (runHeadless) {
      await workbench.setViewportSize({ width: 1440, height: 900 });
    }
    workbench.on("console", (message) => log(`workbench:${message.type()}`, message.text()));
    workbench.on("pageerror", (error) => log("workbench pageerror", error.message));

    await openPaseo(workbench);
    await answerPasswordPrompt(workbench, password, { log });
    const appFrame = await waitForAppFrame(browser, 45_000, { artifactDir });
    const state = await waitForWorkspace(appFrame, 45_000);

    log("workspace-open passed", JSON.stringify(state));

    await runEditingShortcutsProbe(appFrame);
    await runComposerDropProbe(appFrame, workspaceDir);
    await runSendToPaseoProbe(appFrame, workspaceDir);
  } catch (error) {
    if (workbench) await screenshot(workbench, "workspace-open-failure");
    writeArtifact("workspace-open-error.txt", error.stack || error.message || String(error));
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await terminateVsCode(vscodeProcess);
    await daemon.terminate();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(extensionsDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(daemonHome, { recursive: true, force: true });
  }
}

async function runFileLinkClickSpec() {
  // TODO(WS4 spec2): add this once the test can seed a durable agent timeline fixture through
  // the daemon's supported JSON persistence/API. The manual CDP harness assumes an already-seeded
  // live daemon; guessing at private agent/timeline files here would make the CI job flaky.
  log("skipping file-link click spec; deterministic agent seeding fixture is not available yet");
}

await runWorkspaceOpenSpec();
await runFileLinkClickSpec();
