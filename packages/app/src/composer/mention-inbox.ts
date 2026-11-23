import { useEffect, useRef } from "react";

export interface ComposerFileReferenceSelection {
  /** 1-based, matching how editors and agents talk about positions. */
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface ComposerFileReference {
  /** Absolute host path. The receiving composer makes it relative to its own cwd. */
  path: string;
  selection?: ComposerFileReferenceSelection;
}

/** Returns false when this composer could not take the references, so delivery keeps looking. */
export type ComposerMentionHandler = (references: readonly ComposerFileReference[]) => boolean;

interface Registration {
  handler: ComposerMentionHandler;
  isActive: () => boolean;
}

const registrations: Registration[] = [];

/**
 * Delivers file references to the composer the user is working in. Several composers are mounted
 * at once — the focused pane, the draft behind it, background tabs — so the focused one is asked
 * first and the most recently mounted one is the fallback. Mirrors how FileDropZone picks a sink.
 */
export function deliverComposerMentions(references: readonly ComposerFileReference[]): boolean {
  if (references.length === 0) {
    return false;
  }
  const ordered = [
    ...registrations.filter((entry) => entry.isActive()).toReversed(),
    ...registrations.filter((entry) => !entry.isActive()).toReversed(),
  ];
  for (const entry of ordered) {
    if (entry.handler(references)) {
      return true;
    }
  }
  return false;
}

export function registerComposerMentionHandler(registration: Registration): () => void {
  registrations.push(registration);
  return () => {
    const index = registrations.indexOf(registration);
    if (index !== -1) {
      registrations.splice(index, 1);
    }
  };
}

export function useComposerMentionInbox(handler: ComposerMentionHandler, active: boolean): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(
    () =>
      registerComposerMentionHandler({
        handler: (references) => handlerRef.current(references),
        isActive: () => activeRef.current,
      }),
    [],
  );
}

export function resetComposerMentionHandlersForTest(): void {
  registrations.length = 0;
}
