import { describe, expect, it } from "vitest";
import { createDesktopWindowOwner, type OwnedDesktopWindow } from "./desktop-window-owner.js";

interface Target {
  id: string;
}

function harness() {
  const windows: OwnedDesktopWindow<Target>[] = [];
  const launches: Array<{ initialRoute: string | null; restoreWindowState: boolean }> = [];
  const sent: Array<{ webContentsId: number; target: Target }> = [];
  let nextId = 1;
  let focused: OwnedDesktopWindow<Target> | null = null;
  let closeWindow = (_id: number) => {};
  const owner = createDesktopWindowOwner<Target>({
    async create(input) {
      launches.push({
        initialRoute: input.initialRoute,
        restoreWindowState: input.restoreWindowState,
      });
      const id = nextId++;
      closeWindow = input.onClosed;
      const window: OwnedDesktopWindow<Target> = {
        webContentsId: id,
        isDestroyed: () => false,
        isVisible: () => true,
        isMinimized: () => false,
        restore: () => {},
        show: () => {},
        focus: () => {},
        send: (target) => sent.push({ webContentsId: id, target }),
      };
      windows.push(window);
      input.onCreated(id);
      return window;
    },
    windows: () => windows,
    focusedWindow: () => focused,
    route: (target) => `/agent/${target.id}`,
    deliver: (_id, target) => target,
  });
  return {
    owner,
    launches,
    sent,
    windows,
    setFocused: (window: OwnedDesktopWindow<Target>) => {
      focused = window;
    },
    close: (id: number) => closeWindow(id),
  };
}

describe("desktop window owner", () => {
  it("restores only primary launches and routes pending projects per window", async () => {
    const h = harness();
    await h.owner.openPrimary({ pendingProjectPath: " /project/a " });
    await h.owner.openAdditional({ pendingProjectPath: "/project/b" });
    expect(h.launches).toEqual([
      { initialRoute: null, restoreWindowState: true },
      { initialRoute: null, restoreWindowState: false },
    ]);
    expect(h.owner.takePendingProject(1)).toBe("/project/a");
    expect(h.owner.takePendingProject(2)).toBe("/project/b");
  });

  it("focuses an existing window and delivers routing through its inbox", async () => {
    const h = harness();
    await h.owner.openPrimary();
    await h.owner.openAdditional();
    h.setFocused(h.windows[1]);
    await h.owner.openOrFocus({ id: "agent-7" });
    expect(h.launches).toHaveLength(2);
    expect(h.sent).toEqual([{ webContentsId: 2, target: { id: "agent-7" } }]);
  });

  it("opens a window at the target route when none exists", async () => {
    const h = harness();
    await h.owner.openOrFocus({ id: "agent-7" });
    expect(h.launches).toEqual([{ initialRoute: "/agent/agent-7", restoreWindowState: true }]);
    expect(h.sent).toEqual([]);
  });

  it("removes pending routing state when a window closes", async () => {
    const h = harness();
    await h.owner.openAdditional({ pendingProjectPath: "/project/a" });
    h.close(1);
    expect(h.owner.takePendingProject(1)).toBeNull();
  });
});
