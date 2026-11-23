import { posix } from "node:path";

import type { EditorTargetRuntime, RemoteDestinationKind } from "./target.js";

const SSH_ONLY: readonly RemoteDestinationKind[] = ["ssh"];
const LOCAL_ONLY: readonly RemoteDestinationKind[] = [];

/**
 * A remote path describes the daemon machine's filesystem, so it is judged by POSIX rules
 * rather than this desktop's. `path.isAbsolute` follows the platform it runs on, which would
 * make a macOS or Linux client reject a path its own daemon never produced.
 */
export function isAbsoluteRemotePath(path: string): boolean {
  return posix.isAbsolute(path);
}

/**
 * Percent-encode a POSIX path for a remote URI. Each segment is encoded separately so the
 * separators and the leading slash survive, and so a space or `&` in a directory name never
 * reaches a shell as itself. Explicitly POSIX: the separator is the daemon's, not this
 * machine's, and remote paths are validated as POSIX before they get here.
 */
export function encodeRemotePath(path: string): string {
  return path.split(posix.sep).map(encodeURIComponent).join(posix.sep);
}

/**
 * Remote opens go through the editor's CLI: `--folder-uri` and `ssh://` URLs have no
 * `open -a` equivalent, so an installed application is not on its own enough. On macOS the
 * app is commonly present without the shell command — VS Code ships it behind "Shell
 * Command: Install 'code' command in PATH" — and advertising SSH there would offer an entry
 * that can only fail once the user has configured a host and clicked it.
 */
export function cliRemoteDestinationKinds(
  runtime: EditorTargetRuntime,
  commands: readonly string[],
): readonly RemoteDestinationKind[] {
  return runtime.resolveCommand(commands) === null ? LOCAL_ONLY : SSH_ONLY;
}
