import { PendingOpenProjectStore } from "../pending-open-project-store.js";

export interface OwnedDesktopWindow<TTarget> {
  webContentsId: number;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  send(target: TTarget): void;
}

interface DesktopWindowOwnerPort<TTarget> {
  create(input: {
    initialRoute: string | null;
    restoreWindowState: boolean;
    onCreated(webContentsId: number): void;
    onClosed(webContentsId: number): void;
  }): Promise<OwnedDesktopWindow<TTarget>>;
  windows(): OwnedDesktopWindow<TTarget>[];
  focusedWindow(): OwnedDesktopWindow<TTarget> | null;
  route(target: TTarget): string;
  deliver(webContentsId: number, target: TTarget): TTarget | null;
}

export interface DesktopWindowOwner<TTarget> {
  openPrimary(input?: {
    initialRoute?: string | null;
    pendingProjectPath?: string | null;
  }): Promise<void>;
  openAdditional(input?: { pendingProjectPath?: string | null }): Promise<void>;
  openOrFocus(target: TTarget): Promise<void>;
  restoreWhenActivated(): Promise<void>;
  takePendingProject(webContentsId: number): string | null;
}

export function createDesktopWindowOwner<TTarget>(
  port: DesktopWindowOwnerPort<TTarget>,
): DesktopWindowOwner<TTarget> {
  const pendingProjects = new PendingOpenProjectStore();
  let targetWindowCreation: Promise<void> | null = null;

  const open = async (input: {
    initialRoute: string | null;
    pendingProjectPath: string | null;
    restoreWindowState: boolean;
  }): Promise<void> => {
    await port.create({
      initialRoute: input.initialRoute,
      restoreWindowState: input.restoreWindowState,
      onCreated: (webContentsId) => pendingProjects.set(webContentsId, input.pendingProjectPath),
      onClosed: (webContentsId) => pendingProjects.delete(webContentsId),
    });
  };

  const owner: DesktopWindowOwner<TTarget> = {
    openPrimary: (input = {}) =>
      open({
        initialRoute: input.initialRoute ?? null,
        pendingProjectPath: input.pendingProjectPath ?? null,
        restoreWindowState: true,
      }),
    openAdditional: (input = {}) =>
      open({
        initialRoute: null,
        pendingProjectPath: input.pendingProjectPath ?? null,
        restoreWindowState: false,
      }),
    async openOrFocus(target) {
      const windows = port.windows();
      const window =
        port.focusedWindow() ?? windows.find((candidate) => candidate.isVisible()) ?? windows[0];
      if (!window || window.isDestroyed()) {
        if (!targetWindowCreation) {
          targetWindowCreation = owner
            .openPrimary({ initialRoute: port.route(target) })
            .finally(() => {
              targetWindowCreation = null;
            });
          await targetWindowCreation;
          return;
        }
        await targetWindowCreation;
        await owner.openOrFocus(target);
        return;
      }
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      const deliverable = port.deliver(window.webContentsId, target);
      if (deliverable) window.send(deliverable);
    },
    async restoreWhenActivated() {
      if (port.windows().length === 0) await owner.openPrimary();
    },
    takePendingProject: (webContentsId) => pendingProjects.take(webContentsId),
  };
  return owner;
}
