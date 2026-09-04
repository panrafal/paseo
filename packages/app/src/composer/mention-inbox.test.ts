import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deliverComposerMentions,
  registerComposerMentionHandler,
  resetComposerMentionHandlersForTest,
} from "./mention-inbox";

const references = [{ path: "/repo/src/a.ts" }];

afterEach(() => {
  resetComposerMentionHandlersForTest();
});

describe("deliverComposerMentions", () => {
  it("prefers the active composer over one that mounted later", () => {
    const active = vi.fn(() => true);
    const background = vi.fn(() => true);
    registerComposerMentionHandler({ handler: active, isActive: () => true });
    registerComposerMentionHandler({ handler: background, isActive: () => false });

    expect(deliverComposerMentions(references)).toBe(true);
    expect(active).toHaveBeenCalledWith(references);
    expect(background).not.toHaveBeenCalled();
  });

  it("falls back to the most recent composer when none is active", () => {
    const older = vi.fn(() => true);
    const newer = vi.fn(() => true);
    registerComposerMentionHandler({ handler: older, isActive: () => false });
    registerComposerMentionHandler({ handler: newer, isActive: () => false });

    expect(deliverComposerMentions(references)).toBe(true);
    expect(newer).toHaveBeenCalled();
    expect(older).not.toHaveBeenCalled();
  });

  it("keeps looking when a composer declines", () => {
    const declining = vi.fn(() => false);
    const accepting = vi.fn(() => true);
    registerComposerMentionHandler({ handler: accepting, isActive: () => false });
    registerComposerMentionHandler({ handler: declining, isActive: () => true });

    expect(deliverComposerMentions(references)).toBe(true);
    expect(declining).toHaveBeenCalled();
    expect(accepting).toHaveBeenCalled();
  });

  it("reports failure with no composer mounted, and ignores an empty delivery", () => {
    expect(deliverComposerMentions(references)).toBe(false);

    const handler = vi.fn(() => true);
    registerComposerMentionHandler({ handler, isActive: () => true });
    expect(deliverComposerMentions([])).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("unregisters on dispose", () => {
    const handler = vi.fn(() => true);
    registerComposerMentionHandler({ handler, isActive: () => true })();

    expect(deliverComposerMentions(references)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
