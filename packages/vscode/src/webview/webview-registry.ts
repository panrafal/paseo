import { createEventEnvelope } from "./messaging";
import type { ComposerFileReference } from "../editor/file-reference";

export const SEND_TO_COMPOSER_EVENT = "send-to-composer";

export interface RegisteredWebview {
  post: (message: unknown) => PromiseLike<boolean> | boolean;
  isVisible: () => boolean;
  /** Bring this surface into view without taking focus off the editor. */
  reveal: () => PromiseLike<unknown> | unknown;
}

const registered: RegisteredWebview[] = [];
let pendingReferences: ComposerFileReference[] = [];

export function registerWebview(entry: RegisteredWebview): { dispose: () => void } {
  registered.push(entry);
  return {
    dispose: () => {
      const index = registered.indexOf(entry);
      if (index !== -1) {
        registered.splice(index, 1);
      }
    },
  };
}

export function hasRegisteredWebview(): boolean {
  return registered.length > 0;
}

function findTarget(): RegisteredWebview | null {
  // A visible surface wins, newest first: with the sidebar view and a panel both open, the one
  // opened last is the one being worked in. Otherwise take the newest and reveal it.
  return (
    registered.toReversed().find((entry) => entry.isVisible()) ??
    registered[registered.length - 1] ??
    null
  );
}

/**
 * Hands a reference to a running Paseo app. Returns false when there is none, in which case the
 * reference is queued: a webview that has never been resolved has no app to receive a message,
 * and one that was just created has not booted yet. The app drains the queue over the bridge when
 * it mounts, so the caller's job in that case is only to open Paseo.
 */
export async function deliverComposerReference(reference: ComposerFileReference): Promise<boolean> {
  const target = findTarget();
  if (!target) {
    pendingReferences.push(reference);
    return false;
  }
  await target.reveal();
  await target.post(createEventEnvelope(SEND_TO_COMPOSER_EVENT, reference));
  return true;
}

/** Drained by the app through the bridge when it mounts. */
export function takePendingComposerReferences(): ComposerFileReference[] {
  const references = pendingReferences;
  pendingReferences = [];
  return references;
}

export function resetWebviewRegistryForTest(): void {
  registered.length = 0;
  pendingReferences = [];
}
