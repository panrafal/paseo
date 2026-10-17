import { describe, expect, it, vi } from "vitest";
import { installFileDragGuard, isFileDragEvent } from "./file-drag";

type Listener = (event: unknown) => void;

function createWindowStub() {
  const listeners = new Map<string, Listener[]>();
  const target = {
    addEventListener(type: string, listener: Listener) {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    },
  } as unknown as Window;
  return {
    target,
    dispatch(type: string, event: unknown) {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
    count(type: string) {
      return (listeners.get(type) ?? []).length;
    },
  };
}

function createDragEvent(type: string, types: string[]) {
  return {
    type,
    dataTransfer: types.length > 0 ? { types, dropEffect: "copy" } : null,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  };
}

describe("isFileDragEvent", () => {
  it("recognizes OS files, standard URIs, and VS Code's own drag type", () => {
    expect(isFileDragEvent(createDragEvent("dragover", ["Files"]))).toBe(true);
    expect(isFileDragEvent(createDragEvent("dragover", ["text/uri-list"]))).toBe(true);
    expect(isFileDragEvent(createDragEvent("dragover", ["application/vnd.code.uri-list"]))).toBe(
      true,
    );
  });

  it("ignores drags with nothing to drop", () => {
    expect(isFileDragEvent(createDragEvent("dragover", ["text/plain"]))).toBe(false);
    expect(isFileDragEvent(createDragEvent("dragover", []))).toBe(false);
  });
});

describe("installFileDragGuard", () => {
  it("keeps a file drag from reaching VS Code's forwarding listener", () => {
    const host = createWindowStub();
    installFileDragGuard(host.target);

    const event = createDragEvent("dragenter", ["Files"]);
    host.dispatch("dragenter", event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
  });

  it("rejects a drop that reached the window instead of a drop zone", () => {
    const host = createWindowStub();
    installFileDragGuard(host.target);

    const event = createDragEvent("dragover", ["text/uri-list"]);
    host.dispatch("dragover", event);

    // preventDefault without this would claim the drop and navigate the webview to the file.
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.dataTransfer?.dropEffect).toBe("none");
  });

  it("blocks a stray drop without consuming it, so the app's own window listeners still run", () => {
    const host = createWindowStub();
    installFileDragGuard(host.target);

    const event = createDragEvent("drop", ["Files"]);
    host.dispatch("drop", event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it("leaves drags that carry no files alone", () => {
    const host = createWindowStub();
    installFileDragGuard(host.target);

    const event = createDragEvent("dragover", ["text/plain"]);
    host.dispatch("dragover", event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it("leaves the drag event alone, so a drag started inside Paseo is never canceled", () => {
    const host = createWindowStub();
    installFileDragGuard(host.target);

    expect(host.count("drag")).toBe(0);
  });

  it("removes every listener on dispose", () => {
    const host = createWindowStub();
    const dispose = installFileDragGuard(host.target);
    dispose();

    for (const type of ["dragenter", "dragover", "drop"]) {
      expect(host.count(type)).toBe(0);
    }
  });
});
