import type { FileDropIntent } from "./types";

/**
 * Which modifier asks for an attachment instead of a prompt reference.
 *
 * Shift is the one to hold, except in VS Code, where the workbench has already claimed it: it
 * blanks the webview's pointer events for the length of any drag, and Shift is the only thing
 * that hands the drop to the webview instead. Every VS Code drop therefore arrives with Shift
 * down, so Option is the modifier that can still carry a meaning there — and it works everywhere,
 * which is what makes it safe to teach.
 */
export function resolveFileDropIntent(input: {
  altKey: boolean;
  shiftKey: boolean;
  isVscode: boolean;
}): FileDropIntent {
  if (input.altKey) {
    return "attach";
  }
  return input.shiftKey && !input.isVscode ? "attach" : "reference";
}
