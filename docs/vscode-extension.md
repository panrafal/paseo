# VS Code Extension

The VS Code extension surfaces Paseo agent chat and agent management inside VS
Code. It connects from the VS Code extension host to the Paseo daemon running on
the same machine, WSL environment, SSH host, Codespace, or other remote host
where VS Code is running workspace extensions.

The package contributes a Paseo Activity Bar webview, the `Paseo: Open` panel
command, password management commands, and the `paseo.endpoint` setting.

## Install

The extension is sideload-first for now. Build the `.vsix` from the repo root:

```bash
npm run build:vscode
```

Then install it into VS Code:

```bash
code --install-extension packages/vscode/paseo.vsix
```

For Remote SSH, WSL, and Codespaces, install the extension on the **remote**
host. In VS Code, use the Extensions view and choose the remote install action
such as "Install in WSL" or "Install in SSH". The package declares
`extensionKind: ["workspace"]`, so VS Code runs the extension host where the
workspace lives. That is also where the Paseo daemon and `~/.paseo` state are
expected to live, so installing locally while editing a remote workspace puts the
extension on the wrong side of the daemon boundary.

## Daemon Discovery

The extension resolves the daemon endpoint in the Node extension host before the
webview app starts. Resolution order is:

1. `paseo.endpoint` VS Code setting.
2. `PASEO_VSCODE_ENDPOINT` environment variable.
3. `~/.paseo/config.json` `daemon.listen` value.
4. `127.0.0.1:6767`.

Each candidate is parsed as a TCP host and port, then probed with
`GET /api/status`. The first reachable daemon, including a daemon that returns
`401` because it requires a password, wins. If no candidate is reachable, the
first valid candidate is still used as the fallback endpoint for the webview.

The extension dials the resolved listen host. It does not rewrite a concrete LAN
IP to loopback; for example, `192.168.1.50:6767` remains
`192.168.1.50:6767`. VS Code v1 supports TCP daemon listens only. Socket and
pipe listen targets such as Unix sockets, Windows pipes, `unix:`, `pipe:`, and
`ws+unix:` are rejected as unsupported.

## Workspace Matching

The extension sends VS Code's open folder paths into the webview, and the app resolves
the workspace to open from the first usable folder. Matching runs in three tiers against
the daemon's workspaces: workspace directory, then project root, then the cwd of any
agent living inside the folder. Remote folders need no special handling — `uri.fsPath`
on a `vscode-remote://` folder is the path on the remote, which is where the extension
host and daemon both run.

One folder can match several workspaces: two checkouts registered on the same directory,
or a project root whose work all happens in worktrees. Take the most recently active
one (`activityAt`), and fall back to the first workspace the daemon listed when none of
them report activity. Do not resolve an ambiguous folder to the host alone. That sends
startup through the host index, which restores the last remembered workspace and drops
the user into an unrelated project — the folder VS Code has open is better evidence than
navigation history. The host-only match is left for the one case that has no workspace
to name: an agent inside the folder belongs to a workspace the daemon has not sent.

A match redirects straight to the workspace route. A folder that matches nothing is
opened as a new project instead.

## Password Handling

If the daemon responds with `401`, the extension prompts for the daemon password
and stores it in VS Code `SecretStorage`. The key includes the extension-host
machine identity, remote kind, and daemon endpoint. A local daemon and SSH, WSL,
or Codespaces daemons can therefore use different passwords even when each one
listens on `127.0.0.1:6767`. Users can manage the secret for the daemon reached by
the current VS Code window with these commands:

- `Paseo: Set Daemon Password`
- `Paseo: Clear Daemon Password`

The plaintext password stays in the Node extension host. It is used there to
validate the password and authenticate the daemon WebSocket connection; it is not
written into the webview HTML, runtime config, or postMessage payloads.
Endpoint-only secrets written by extension versions before 0.7.2 are not reused;
each extension host prompts once before writing its scoped secret.

## VS Code-Owned Surfaces

The extension intentionally does not provide Paseo's duplicate workspace
surfaces when VS Code already owns them:

- File explorer
- Git changes
- Diff view
- Browser pane
- Voice and dictation

Chat file links open in the VS Code editor, including line navigation when a
line is present.

## Keyboard and Clipboard

Basic editing shortcuts (select all / copy / cut / paste / undo / redo) in Paseo
text fields are handled by the webview bootstrap itself
(`src/webview-preload/editing-shortcuts.ts`), not by VS Code. react-native-web's
`TextInput` stops keydown propagation, so keystrokes typed in Paseo inputs never
reach the bubble-phase window listener VS Code's webview host uses to forward
keys to the workbench. On macOS there is no native renderer fallback for
Cmd+A/C/V/X/Z (they are menu key equivalents in Cocoa, and VS Code suppresses
menu shortcuts while a webview is focused), so without the bootstrap handler
basic editing in the composer breaks entirely. The handler is a capture-phase
window listener (runs before React can swallow the event) that executes
`document.execCommand`, so real `input`/`paste` events still fire and image
paste keeps working. The event is only consumed when `execCommand` reports
success; in browser-hosted webviews (Codespaces web, code-server), where
programmatic paste is refused, the event stays untouched and the browser's
native handling applies as before. The terminal is excluded — xterm owns its
keystrokes.

For the same propagation reason, VS Code workbench keybindings (for example
Cmd+Shift+P) do not fire while focus is inside a Paseo text field. That is a
known limitation; focus outside the input first.

## Dropping Files

**Hold Shift to drag anything out of VS Code into Paseo.** For the length of any
drag that starts in the workbench — an Explorer item, an editor tab — VS Code
sets `pointer-events: none` on the entire webview iframe, and releases it only
while Shift is down. The blocking happens in the workbench before the pointer
reaches the webview, so no extension code can undo it.

A drag that starts outside VS Code (Finder, File Explorer) is blocked by a
second mechanism, and that one the extension can undo. The webview preamble asks
the workbench to block the iframe as soon as an OS file drag enters, and skips
the request when the event is already `defaultPrevented` or Shift is down.
`src/webview-preload/file-drag.ts` takes those events at the window, so a plain
drop of a Finder file lands in Paseo instead of doing nothing.

Shift being the entry ticket rules it out as the modifier that picks an
attachment over a prompt reference. Option/Alt does that instead, in VS Code and
everywhere else (`packages/app/src/components/file-drop/intent.ts`).

What the drop carries decides what Paseo can do with it. Verified against real
drags with [cdp-drag-probe.mjs](../packages/vscode/scripts/cdp-drag-probe.mjs);
rerun it when a drop stops producing a reference:

| Dragged from       | Types on the DataTransfer                                                                                                 | Result                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| VS Code Explorer   | `text/plain`, `downloadurl`, `resourceurls`, `codeeditors`, `text/uri-list`, `application/vnd.code.uri-list`, `codefiles` | Reference, attachment on Option |
| VS Code editor tab | `resourceurls`, `codeeditors`, `application/vnd.code.uri-list`                                                            | Reference, attachment on Option |
| OS file manager    | `Files` — bytes, no path                                                                                                  | Attachment                      |

Three of those types carry paths and Paseo reads all three, because no single one
covers both sources: `text/uri-list` holds only the **first** dragged resource and
an editor tab omits it entirely, `application/vnd.code.uri-list` holds every
resource but is undocumented workbench internals, and `resourceurls` is the JSON
array that older VS Code versions set. Chromium lowercases custom drag types, so
read `resourceurls`, not the `ResourceURLs` the workbench writes.

An OS drag reaches the webview as a `File` with no path — `webUtils.getPathForFile`
is Electron's, and the webview is not Electron — so those can only be attached.

## Send to Paseo

Right-click in a text editor and choose **Send to Paseo** to put the file in the
composer without dragging anything. A selection becomes
`"src/app.ts:12:5-20:3"`; a bare caret becomes `"src/app.ts"`. The range format
is the one `assistant-file-links/parse.ts` reads back, so what the command writes
stays a link Paseo can open. A buffer with no file on disk — untitled, a diff's
virtual side — is refused rather than mentioned as a path the agent cannot read.

The extension resolves the reference and hands it to a running Paseo
(`src/webview/webview-registry.ts`), revealing that surface without taking focus
off the editor. A visible surface wins over a hidden one, and the most recently
opened wins among equals, so the sidebar view and a `Paseo: Open` panel do not
fight. With no webview resolved yet, the reference is queued and the view is
revealed; the app drains the queue over the bridge as it mounts, since a webview
that has just been created has no app to receive a message.

The path arrives absolute. The composer makes it relative to its own cwd
(`resolveDroppedFileMentionPath`), so multi-root windows and agents running in a
worktree get a reference that resolves.

## Known Limitations

Socket and pipe daemon listen targets are not supported in VS Code v1. Use a TCP
listen target for the daemon endpoint.

## Security Model

Treat the webview as untrusted input to the Node extension host. Agent output and
daemon content can reach the React UI, so the bridge avoids turning webview
postMessage into an unbounded local primitive.

The webview document gets a CSP built in `src/webview/html-rewrite.ts`. It replaces
whatever CSP the bundled `index.html` shipped with, defaults to `default-src 'none'`,
and admits scripts by nonce, so a `<script>` tag injected through rendered agent output
does not run. `script-src` also carries `'unsafe-eval'`: the app evaluates every plugin
client bundle from source ([plugins.md](plugins.md)), and without it each installed
plugin fails to load with a CSP violation. The nonce keeps working regardless — eval is
reachable only from scripts that already run.

The bridge pins daemon transport connections to the Node-resolved endpoint and
ignores any endpoint supplied by the webview. `opener.openUrl` only accepts
`http:`, `https:`, and `mailto:` URLs. Attachment copy commands accept regular
source files, reject directories and non-files, and only write into
VS Code-managed attachment storage. The `PASEO_VSCODE_TEST_PASSWORD` automation
seam is ignored in production extension mode. The daemon password never enters
the webview.

## Developer Notes

For CI and e2e workflow details, see [vscode-ci.md](vscode-ci.md).

The extension bundles the Expo web app from `packages/app/dist` into
`packages/vscode/media/app-dist`, then serves it inside one VS Code webview
document. `webview-host.ts` rewrites the static asset URLs into same-origin VS
Code webview resource URIs and injects a small runtime config plus
`dist/webview-bootstrap.js`.

Inside the webview, the bootstrap script installs a `window.paseoDesktop` shim.
The app calls that shim the same way it calls the Electron desktop bridge. The
shim sends `postMessage` invocations to the Node extension host, where
`BridgeRouter` handles the local daemon WebSocket proxy and the editor, opener,
dialog, and attachment bridge commands.

When app web assets change, rebuild `packages/app/dist` and copy it into the
extension. From `packages/vscode`, run:

```bash
npm run copy:app-dist
```

From the repo root, `npm run build:vscode` performs the app web build, copies
`app-dist`, builds the extension/preload bundles, and packages `paseo.vsix`.

`packages/vscode/scripts/cdp-debug.mjs` launches a real VS Code instance with the
development extension and connects Playwright over CDP. Useful environment knobs
include `PASEO_VSCODE_ENDPOINT`, `PASEO_VSCODE_TEST_PASSWORD`, `PASEO_CDP_PORT`,
`PASEO_CDP_WORKSPACE`, `PASEO_CDP_RESIZE_PROBE`, `PASEO_CDP_EDITOR_PROBE`,
`PASEO_CDP_EDITOR_PROBE_LINE`, `PASEO_CDP_DIALOG_PROBE`, and
`PASEO_CDP_PICK_IMAGE_PROBE`.

The package also has an `@vscode/test-electron` smoke test at
`src/test/run-vscode-smoke.mjs`. Test VS Code must launch as Electron, not as a
Node child process. Delete `ELECTRON_RUN_AS_NODE` before launching VS Code; the
smoke test and CDP harness do this explicitly.

The deterministic workspace-open and editing-shortcuts CDP spec normally runs
under Xvfb:

```bash
xvfb-run -a node packages/vscode/scripts/vscode-e2e.mjs
```

On a displayless Linux host without `xvfb-run`, use the harness's native
Electron headless mode. It also expands the CDP viewport so the visible composer
is exercised rather than a retained responsive-layout copy:

```bash
PASEO_VSCODE_E2E_HEADLESS=1 node packages/vscode/scripts/vscode-e2e.mjs
```
