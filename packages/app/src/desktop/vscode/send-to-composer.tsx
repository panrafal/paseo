import { useEffect } from "react";
import { getIsVscode } from "@/constants/platform";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost } from "@/desktop/host";
import {
  deliverComposerMentions,
  type ComposerFileReference,
  type ComposerFileReferenceSelection,
} from "@/composer/mention-inbox";

const SEND_TO_COMPOSER_EVENT = "send-to-composer";
const TAKE_PENDING_COMMAND = "composer.takePendingReferences";

function parseSelection(value: unknown): ComposerFileReferenceSelection | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const numbers = ["startLine", "startColumn", "endLine", "endColumn"].map((key) => record[key]);
  if (!numbers.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    return undefined;
  }
  const [startLine, startColumn, endLine, endColumn] = numbers as number[];
  return { startLine, startColumn, endLine, endColumn };
}

function parseReference(value: unknown): ComposerFileReference | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (!path) {
    return null;
  }
  const selection = parseSelection(record.selection);
  return selection ? { path, selection } : { path };
}

function parseReferences(value: unknown): ComposerFileReference[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry) => {
    const reference = parseReference(entry);
    return reference ? [reference] : [];
  });
}

/**
 * Receives VS Code's "Send to Paseo" command. The extension posts an event when a webview is
 * visible and queues the reference otherwise, so this also drains the queue once — the command
 * can reveal a Paseo view that has no app running yet.
 */
export function VscodeSendToComposerListener() {
  useEffect(() => {
    if (!getIsVscode()) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    const deliver = (payload: unknown) => {
      const references = parseReferences(payload);
      if (references.length === 0) {
        return;
      }
      if (!deliverComposerMentions(references)) {
        console.warn("[Paseo] No composer took the file reference from VS Code.");
      }
    };

    void listenToDesktopEvent(SEND_TO_COMPOSER_EVENT, deliver)
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        return;
      })
      .catch((error) => {
        console.warn("[Paseo] Failed to listen for VS Code file references:", error);
      });

    // The composer mounts after this effect, so let it register its inbox first.
    const drainTimer = setTimeout(() => {
      const invoke = getDesktopHost()?.invoke;
      if (typeof invoke !== "function") {
        return;
      }
      void invoke(TAKE_PENDING_COMMAND)
        .then((pending) => {
          if (!disposed) {
            deliver(pending);
          }
          return;
        })
        .catch(() => {
          // An older extension host has no such command; nothing was queued for us.
        });
    }, 500);

    return () => {
      disposed = true;
      clearTimeout(drainTimer);
      unlisten?.();
    };
  }, []);

  return null;
}
