import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deliverComposerReference,
  hasRegisteredWebview,
  registerWebview,
  resetWebviewRegistryForTest,
  takePendingComposerReferences,
  SEND_TO_COMPOSER_EVENT,
} from "./webview-registry";

const reference = { path: "/repo/src/a.ts" };

function webview(isVisible: boolean) {
  return { post: vi.fn(() => true), isVisible: () => isVisible, reveal: vi.fn(() => undefined) };
}

afterEach(() => {
  resetWebviewRegistryForTest();
});

describe("deliverComposerReference", () => {
  it("reveals and posts to the visible webview", async () => {
    const target = webview(true);
    registerWebview(target);

    await expect(deliverComposerReference(reference)).resolves.toBe(true);
    expect(target.reveal).toHaveBeenCalled();
    expect(target.post).toHaveBeenCalledWith({
      kind: "event",
      event: SEND_TO_COMPOSER_EVENT,
      payload: reference,
    });
  });

  it("prefers a visible surface over a newer hidden one", async () => {
    const visible = webview(true);
    const hidden = webview(false);
    registerWebview(visible);
    registerWebview(hidden);

    await deliverComposerReference(reference);

    expect(visible.post).toHaveBeenCalled();
    expect(hidden.post).not.toHaveBeenCalled();
  });

  it("reveals the newest surface when everything is hidden", async () => {
    const older = webview(false);
    const newer = webview(false);
    registerWebview(older);
    registerWebview(newer);

    await deliverComposerReference(reference);

    expect(newer.reveal).toHaveBeenCalled();
    expect(newer.post).toHaveBeenCalled();
    expect(older.post).not.toHaveBeenCalled();
  });

  it("queues for the app to drain when Paseo is not running yet", async () => {
    expect(hasRegisteredWebview()).toBe(false);

    await expect(deliverComposerReference(reference)).resolves.toBe(false);

    expect(takePendingComposerReferences()).toEqual([reference]);
    expect(takePendingComposerReferences()).toEqual([]);
  });

  it("drops its registration on dispose", async () => {
    const target = webview(true);
    registerWebview(target).dispose();

    await expect(deliverComposerReference(reference)).resolves.toBe(false);
    expect(target.post).not.toHaveBeenCalled();
  });
});
