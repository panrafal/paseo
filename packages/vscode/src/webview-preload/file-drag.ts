// VS Code hands a drag to a webview only grudgingly. Two mechanisms take it away:
//
//   1. The webview preamble listens for `dragenter` on the webview window and, for a drag whose
//      items are all OS files, posts `drag-start` to the workbench. The workbench answers by
//      setting `pointer-events: none` on the whole webview iframe, so nothing inside Paseo ever
//      sees the drop. The preamble skips this when the event is already `defaultPrevented` or
//      when Shift is down — which is why a plain drag of a Finder file into Paseo does nothing
//      and holding Shift makes it work.
//   2. Its `dragover` listener keeps posting `drag` to the workbench, which re-blocks the iframe
//      on every event that has no Shift. That one does not honour `defaultPrevented`, so the only
//      way to stop it is to keep the event from reaching the window listener at all.
//
// This guard handles (1) and (2) for drags Paseo wants: it runs before the preamble registers
// (the bootstrap is injected ahead of the app bundle) and stops those events at the window, after
// every listener below has already run. FileDropZone stops propagation on drags over the drop
// area itself, so this only sees the ones that would otherwise be forwarded.
//
// What it cannot fix: a drag started inside the workbench (Explorer item, editor tab) blocks the
// iframe from `dragstart`, before the pointer is anywhere near the webview. Only the workbench can
// undo that, and Shift is the only thing that tells it to. Those drops still need Shift held.

const FILE_DRAG_TYPES = ["Files", "text/uri-list", "application/vnd.code.uri-list"];

export interface FileDragEventLike {
  dataTransfer?: { types?: readonly string[] } | null;
}

export function isFileDragEvent(event: FileDragEventLike): boolean {
  const types = event.dataTransfer?.types;
  if (!types) {
    return false;
  }
  return FILE_DRAG_TYPES.some((type) => types.includes(type));
}

export function installFileDragGuard(target: Window): () => void {
  const keepDragInWebview = (event: DragEvent) => {
    if (!isFileDragEvent(event)) {
      return;
    }
    // The preamble's `dragover` handler is also what marks the document as a drop target, so
    // taking the event over means owning that: without preventDefault a stray drop outside the
    // drop zone navigates the webview to the dropped file and the app is gone.
    event.preventDefault();
    if (event.type === "dragover" && event.dataTransfer) {
      // Nothing here accepts the drop — FileDropZone would have stopped the event.
      event.dataTransfer.dropEffect = "none";
    }
    event.stopImmediatePropagation();
  };

  const blockStrayDrop = (event: DragEvent) => {
    if (isFileDragEvent(event)) {
      event.preventDefault();
    }
  };

  // `drag` is deliberately left alone. It only fires for a drag whose source is in this document
  // — Paseo's own file drags, which VS Code does not forward anyway — and canceling it aborts the
  // drag operation outright.
  target.addEventListener("dragenter", keepDragInWebview);
  target.addEventListener("dragover", keepDragInWebview);
  target.addEventListener("drop", blockStrayDrop);

  return () => {
    target.removeEventListener("dragenter", keepDragInWebview);
    target.removeEventListener("dragover", keepDragInWebview);
    target.removeEventListener("drop", blockStrayDrop);
  };
}
