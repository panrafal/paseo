import { describe, expect, it } from "vitest";

import { listAvailableEditorTargets, openEditorTarget } from "./registry.js";
import type {
  EditorTargetDirectoryEntry,
  EditorTargetIcon,
  EditorTargetRuntime,
} from "./target.js";
import { cursorTarget } from "./targets/cursor.js";
import { explorerTarget, fileManagerTarget, finderTarget } from "./targets/file-manager.js";
import { intellijIdeaTarget } from "./targets/intellij-idea.js";
import { pycharmTarget } from "./targets/pycharm.js";
import { vscodeTarget } from "./targets/vscode.js";

const sshDestination = { kind: "ssh", host: "dev" } as const;
import { webstormTarget } from "./targets/webstorm.js";
import { xcodeTarget } from "./targets/xcode.js";
import { zedTarget } from "./targets/zed.js";

interface RecordedLaunch {
  command: string;
  args: string[];
}

function testDirectoryEntry(name: string): EditorTargetDirectoryEntry {
  if (name === "Package.swift") return { name, kind: "file" };
  if (name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace")) {
    return { name, kind: "directory" };
  }
  return { name, kind: "other" };
}

class FakeEditorTargets implements EditorTargetRuntime {
  readonly launches: RecordedLaunch[] = [];
  readonly openedPaths: string[] = [];
  readonly revealedPaths: string[] = [];
  readonly openedMacApplications: Array<{
    applicationName: string;
    paths: string[];
  }> = [];

  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  private readonly paths = new Set<string>();
  private readonly commands = new Map<string, string>();
  private readonly macApplications = new Set<string>();
  private readonly directories = new Map<string, EditorTargetDirectoryEntry[]>();
  private readonly directoryErrors = new Map<string, Error>();

  constructor(platform: NodeJS.Platform = "linux", env: NodeJS.ProcessEnv = {}) {
    this.platform = platform;
    this.env = env;
  }

  addPath(targetPath: string): void {
    this.paths.add(targetPath);
  }

  installCommand(command: string, executable = `/bin/${command}`): void {
    this.commands.set(command, executable);
  }

  installMacApplication(applicationName: string): void {
    this.macApplications.add(applicationName);
  }

  addDirectory(targetPath: string, entries: readonly string[]): void {
    this.paths.add(targetPath);
    this.directories.set(targetPath, entries.map(testDirectoryEntry));
  }

  addDirectoryEntries(targetPath: string, entries: readonly EditorTargetDirectoryEntry[]): void {
    this.paths.add(targetPath);
    this.directories.set(targetPath, [...entries]);
  }

  listDirectory(targetPath: string): EditorTargetDirectoryEntry[] {
    const error = this.directoryErrors.get(targetPath);
    if (error) throw error;
    return this.directories.get(targetPath) ?? [];
  }

  failDirectoryRead(targetPath: string, error: Error): void {
    this.directoryErrors.set(targetPath, error);
  }

  pathExists(targetPath: string): boolean {
    return this.paths.has(targetPath);
  }

  isAbsolutePath(targetPath: string): boolean {
    return targetPath.startsWith("/") || /^[A-Z]:\//u.test(targetPath);
  }

  resolveCommand(commands: readonly string[]): string | null {
    for (const command of commands) {
      const executable = this.commands.get(command);
      if (executable) return executable;
    }
    return null;
  }

  async spawnDetached(input: { command: string; args: readonly string[] }): Promise<void> {
    this.launches.push({ command: input.command, args: [...input.args] });
  }

  async openPath(targetPath: string): Promise<void> {
    this.openedPaths.push(targetPath);
  }

  revealPath(targetPath: string): void {
    this.revealedPaths.push(targetPath);
  }

  async loadIcon(fileName: string): Promise<EditorTargetIcon> {
    return { kind: "image", dataUrl: `data:image/png;base64,${fileName}` };
  }

  hasMacApplication(applicationName: string): boolean {
    return this.macApplications.has(applicationName);
  }

  getMacApplicationBundle(applicationName: string): string | null {
    return this.hasMacApplication(applicationName) ? `/Applications/${applicationName}.app` : null;
  }

  async openMacApplication(input: {
    applicationName: string;
    applicationPath?: string;
    paths: readonly string[];
  }): Promise<void> {
    this.openedMacApplications.push({
      applicationName: input.applicationName,
      paths: [...input.paths],
    });
  }
}

describe("editor target registry", () => {
  it("lists installed target implementations in registration order", async () => {
    const runtime = new FakeEditorTargets();
    runtime.installCommand("code");
    runtime.installCommand("webstorm");

    const targets = await listAvailableEditorTargets(runtime, [
      cursorTarget,
      vscodeTarget,
      webstormTarget,
      fileManagerTarget,
    ]);

    expect(targets).toEqual([
      {
        id: "vscode",
        label: "VS Code",
        kind: "editor",
        icon: { kind: "image", dataUrl: "data:image/png;base64,vscode.png" },
        remoteDestinationKinds: ["ssh"],
      },
      {
        id: "webstorm",
        label: "WebStorm",
        kind: "editor",
        icon: { kind: "image", dataUrl: "data:image/png;base64,webstorm.png" },
        remoteDestinationKinds: [],
      },
      {
        id: "file-manager",
        label: "Files",
        kind: "file-manager",
        icon: { kind: "symbol", name: "folder" },
        remoteDestinationKinds: [],
      },
    ]);
  });

  it("opens a selected file at its position through the target implementation", async () => {
    const runtime = new FakeEditorTargets();
    runtime.installCommand("code");
    runtime.addPath("/repo");
    runtime.addPath("/repo/src/app.ts");

    await openEditorTarget(
      {
        editorId: "vscode",
        workspacePath: "/repo",
        filePath: "/repo/src/app.ts",
        line: 12,
        column: 4,
      },
      runtime,
      [vscodeTarget],
    );

    expect(runtime.launches).toEqual([
      {
        command: "/bin/code",
        args: ["/repo", "--goto", "/repo/src/app.ts:12:4"],
      },
    ]);
  });

  it("lets each target choose its own command and arguments", async () => {
    const runtime = new FakeEditorTargets();
    runtime.installCommand("zeditor");
    runtime.installCommand("webstorm");
    runtime.installCommand("idea");

    await zedTarget.launch(
      { workspacePath: "/repo", filePath: "/repo/src/app.ts", line: 7, column: 2 },
      runtime,
    );
    await webstormTarget.launch(
      { workspacePath: "/repo", filePath: "/repo/src/app.ts", line: 7, column: 2 },
      runtime,
    );
    await intellijIdeaTarget.launch({ workspacePath: "/repo" }, runtime);

    expect(runtime.launches).toEqual([
      { command: "/bin/zeditor", args: ["/repo", "/repo/src/app.ts:7:2"] },
      {
        command: "/bin/webstorm",
        args: ["--line", "7", "--column", "2", "/repo", "/repo/src/app.ts"],
      },
      { command: "/bin/idea", args: ["/repo"] },
    ]);
  });

  it("recognizes Windows 64-bit project IDE launchers", async () => {
    const runtime = new FakeEditorTargets("win32");
    runtime.installCommand("pycharm64", "C:/Tools/PyCharm/bin/pycharm64.exe");

    expect(await pycharmTarget.isInstalled(runtime)).toBe(true);
    await pycharmTarget.launch(
      { workspacePath: "C:/repo", filePath: "C:/repo/src/app.py", line: 6 },
      runtime,
    );

    expect(runtime.launches).toEqual([
      {
        command: "C:/Tools/PyCharm/bin/pycharm64.exe",
        args: ["--line", "6", "C:/repo", "C:/repo/src/app.py"],
      },
    ]);
  });

  it("detects and launches the macOS application when the command is absent", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Cursor");

    expect(await cursorTarget.isInstalled(runtime)).toBe(true);
    await cursorTarget.launch({ workspacePath: "/repo", filePath: "/repo/src/app.ts" }, runtime);

    expect(runtime.openedMacApplications).toEqual([
      {
        applicationName: "Cursor",
        paths: ["/repo", "/repo/src/app.ts"],
      },
    ]);
  });

  it("uses Cursor's bundled macOS command so file positions survive application detection", async () => {
    const runtime = new FakeEditorTargets("darwin");
    const bundledCommand = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";
    runtime.installCommand(bundledCommand, bundledCommand);

    expect(await cursorTarget.isInstalled(runtime)).toBe(true);
    await cursorTarget.launch(
      { workspacePath: "/repo", filePath: "/repo/src/app.ts", line: 18, column: 3 },
      runtime,
    );

    expect(runtime.launches).toEqual([
      {
        command: bundledCommand,
        args: ["/repo", "--goto", "/repo/src/app.ts:18:3"],
      },
    ]);
  });

  it("lists and opens Android Studio through its bundled macOS launcher", async () => {
    const runtime = new FakeEditorTargets("darwin", { HOME: "/Users/me" });
    const bundledCommand = "/Users/me/Applications/Android Studio.app/Contents/MacOS/studio";
    runtime.installCommand(bundledCommand, bundledCommand);
    runtime.addPath("/repo");
    runtime.addPath("/repo/app/src/main/MainActivity.kt");

    const targets = await listAvailableEditorTargets(runtime);

    expect(targets).toContainEqual({
      id: "android-studio",
      label: "Android Studio",
      kind: "editor",
      icon: { kind: "image", dataUrl: "data:image/png;base64,android-studio.png" },
      remoteDestinationKinds: [],
    });

    await openEditorTarget(
      {
        editorId: "android-studio",
        workspacePath: "/repo",
        filePath: "/repo/app/src/main/MainActivity.kt",
        line: 18,
        column: 3,
      },
      runtime,
    );

    expect(runtime.launches).toEqual([
      {
        command: bundledCommand,
        args: ["/repo", "--line", "18", "--column", "3", "/repo/app/src/main/MainActivity.kt"],
      },
    ]);
  });

  it("lists Xcode only for workspaces that hold something Xcode can open", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Xcode");
    runtime.addDirectory("/repo/ios-app", ["ios-app.xcodeproj", "Sources"]);
    runtime.addDirectory("/repo/web-app", ["package.json", "src"]);

    const iosTargets = await listAvailableEditorTargets(runtime, [xcodeTarget], {
      workspacePath: "/repo/ios-app",
    });
    const webTargets = await listAvailableEditorTargets(runtime, [xcodeTarget], {
      workspacePath: "/repo/web-app",
    });
    const unscopedTargets = await listAvailableEditorTargets(runtime, [xcodeTarget]);

    expect(iosTargets).toEqual([
      {
        id: "xcode",
        label: "Xcode",
        kind: "editor",
        icon: { kind: "image", dataUrl: "data:image/png;base64,xcode.png" },
      },
    ]);
    expect(webTargets).toEqual([]);
    expect(unscopedTargets).toEqual([]);
  });

  it("does not mistake similarly named files and directories for Xcode documents", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Xcode");
    runtime.addDirectoryEntries("/repo/not-an-xcode-project", [
      { name: "Notes.xcodeproj", kind: "file" },
      { name: "App.xcworkspace", kind: "file" },
      { name: "Package.swift", kind: "directory" },
    ]);

    await expect(
      listAvailableEditorTargets(runtime, [xcodeTarget], {
        workspacePath: "/repo/not-an-xcode-project",
      }),
    ).resolves.toEqual([]);
  });

  it("hands Xcode the umbrella workspace and the requested file", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Xcode");
    runtime.addDirectory("/repo/Tickets", [
      "Package.swift",
      "Widgets.xcworkspace",
      "Tickets.xcworkspace",
      "Tickets.xcodeproj",
    ]);
    runtime.addPath("/repo/Tickets/Sources/App.swift");

    await openEditorTarget(
      {
        editorId: "xcode",
        workspacePath: "/repo/Tickets",
        filePath: "/repo/Tickets/Sources/App.swift",
        line: 12,
      },
      runtime,
      [xcodeTarget],
    );

    expect(runtime.openedMacApplications).toEqual([
      {
        applicationName: "Xcode",
        paths: ["/repo/Tickets/Tickets.xcworkspace", "/repo/Tickets/Sources/App.swift"],
      },
    ]);
  });

  it("falls back from Xcode workspaces to projects to Swift packages", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Xcode");
    runtime.addDirectory("/repo/project-only", ["Beta.xcodeproj", "Alpha.xcodeproj"]);
    runtime.addDirectory("/repo/package-only", ["Package.swift", "Sources"]);

    await openEditorTarget({ editorId: "xcode", workspacePath: "/repo/project-only" }, runtime);
    await openEditorTarget({ editorId: "xcode", workspacePath: "/repo/package-only" }, runtime);

    expect(runtime.openedMacApplications.map((entry) => entry.paths)).toEqual([
      ["/repo/project-only/Alpha.xcodeproj"],
      ["/repo/package-only/Package.swift"],
    ]);
  });

  it("refuses to launch Xcode for a directory it cannot open", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Xcode");
    runtime.addDirectory("/repo/web-app", ["package.json"]);

    await expect(
      openEditorTarget({ editorId: "xcode", workspacePath: "/repo/web-app" }, runtime),
    ).rejects.toThrow(/No Xcode project/u);
    expect(runtime.openedMacApplications).toEqual([]);
  });

  it("keeps installed editors in registration order when Xcode matches", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installCommand("code");
    runtime.installMacApplication("Xcode");
    runtime.addDirectory("/repo", ["App.xcodeproj"]);

    const targets = await listAvailableEditorTargets(runtime, [vscodeTarget, xcodeTarget], {
      workspacePath: "/repo",
    });

    expect(targets.map((target) => target.id)).toEqual(["vscode", "xcode"]);
  });

  it.each(["EACCES", "EPERM", "ENOENT", "ENOTDIR"])(
    "keeps general editor targets when Xcode discovery fails with %s",
    async (code) => {
      const runtime = new FakeEditorTargets("darwin");
      runtime.installCommand("code");
      runtime.installMacApplication("Xcode");
      runtime.addPath("/repo");
      const error = Object.assign(new Error("Cannot read directory"), { code });
      runtime.failDirectoryRead("/repo", error);

      const targets = await listAvailableEditorTargets(
        runtime,
        [vscodeTarget, xcodeTarget, finderTarget],
        {
          workspacePath: "/repo",
        },
      );

      expect(targets.map((target) => target.id)).toEqual(["vscode", "finder"]);
      await expect(
        openEditorTarget({ editorId: "xcode", workspacePath: "/repo" }, runtime),
      ).rejects.toBe(error);
    },
  );

  it("propagates unexpected Xcode discovery failures", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Xcode");
    const error = Object.assign(new Error("I/O failure"), { code: "EIO" });
    runtime.failDirectoryRead("/repo", error);

    await expect(
      listAvailableEditorTargets(runtime, [xcodeTarget], { workspacePath: "/repo" }),
    ).rejects.toBe(error);
  });

  it("does not discover nested Xcode documents or list an uninstalled Xcode", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.addDirectory("/repo", ["App.xcodeproj"]);
    const withoutXcode = await listAvailableEditorTargets(runtime, [xcodeTarget], {
      workspacePath: "/repo",
    });
    runtime.installMacApplication("Xcode");
    runtime.addDirectory("/nested-repo", ["ios"]);
    runtime.addDirectory("/nested-repo/ios", ["App.xcworkspace"]);
    const nested = await listAvailableEditorTargets(runtime, [xcodeTarget], {
      workspacePath: "/nested-repo",
    });

    expect(withoutXcode).toEqual([]);
    expect(nested).toEqual([]);
  });

  it("detects Cursor's installed Windows command when it is absent from PATH", async () => {
    const runtime = new FakeEditorTargets("win32", {
      LOCALAPPDATA: "C:/Users/me/AppData/Local",
    });
    const installedCommand =
      "C:/Users/me/AppData/Local/Programs/cursor/resources/app/bin/cursor.cmd";
    runtime.installCommand(installedCommand, installedCommand);

    expect(await cursorTarget.isInstalled(runtime)).toBe(true);
    await cursorTarget.launch(
      { workspacePath: "C:/repo", filePath: "C:/repo/src/app.ts", line: 9 },
      runtime,
    );

    expect(runtime.launches).toEqual([
      {
        command: installedCommand,
        args: ["C:/repo", "--goto", "C:/repo/src/app.ts:9"],
      },
    ]);
  });

  it("delegates folder opening and file reveal to the system file manager", async () => {
    const runtime = new FakeEditorTargets("win32");

    expect(await explorerTarget.describe(runtime)).toEqual({
      id: "explorer",
      label: "Explorer",
      kind: "file-manager",
      icon: { kind: "symbol", name: "folder" },
    });
    expect(explorerTarget.remoteDestinationKinds(runtime)).toEqual([]);
    await explorerTarget.launch({ workspacePath: "C:/repo" }, runtime);
    await explorerTarget.launch(
      { workspacePath: "C:/repo", filePath: "C:/repo/src/app.ts" },
      runtime,
    );

    expect(runtime.openedPaths).toEqual(["C:/repo"]);
    expect(runtime.revealedPaths).toEqual(["C:/repo/src/app.ts"]);
  });

  it("opens a remote workspace through folder and file URIs instead of positional paths", async () => {
    const runtime = new FakeEditorTargets();
    runtime.installCommand("code");

    await openEditorTarget(
      {
        editorId: "vscode",
        workspacePath: "/home/user/my repo",
        filePath: "/home/user/my repo/FILE.md",
        line: 12,
        remoteDestination: { kind: "ssh", host: "dev" },
      },
      runtime,
      [vscodeTarget],
    );

    expect(runtime.launches).toEqual([
      {
        command: "/bin/code",
        args: [
          "--folder-uri",
          "vscode-remote://ssh-remote+dev/home/user/my%20repo",
          "--goto",
          "--file-uri",
          "vscode-remote://ssh-remote+dev/home/user/my%20repo/FILE.md:12",
        ],
      },
    ]);
  });

  it("opens a remote folder, and a remote file without a line, without --goto", async () => {
    const runtime = new FakeEditorTargets();
    runtime.installCommand("code");

    await openEditorTarget(
      { editorId: "vscode", workspacePath: "/repo", remoteDestination: sshDestination },
      runtime,
      [vscodeTarget],
    );
    await openEditorTarget(
      {
        editorId: "vscode",
        workspacePath: "/repo",
        filePath: "/repo/src/app.ts",
        remoteDestination: sshDestination,
      },
      runtime,
      [vscodeTarget],
    );

    expect(runtime.launches).toEqual([
      { command: "/bin/code", args: ["--folder-uri", "vscode-remote://ssh-remote+dev/repo"] },
      {
        command: "/bin/code",
        args: [
          "--folder-uri",
          "vscode-remote://ssh-remote+dev/repo",
          "--file-uri",
          "vscode-remote://ssh-remote+dev/repo/src/app.ts",
        ],
      },
    ]);
  });

  it("opens a remote workspace in Cursor with the same authority form as VS Code", async () => {
    const runtime = new FakeEditorTargets();
    runtime.installCommand("cursor");

    await openEditorTarget(
      {
        editorId: "cursor",
        workspacePath: "/repo",
        filePath: "/repo/src/app.ts",
        line: 9,
        remoteDestination: sshDestination,
      },
      runtime,
      [cursorTarget],
    );

    expect(runtime.launches).toEqual([
      {
        command: "/bin/cursor",
        args: [
          "--folder-uri",
          "vscode-remote://ssh-remote+dev/repo",
          "--goto",
          "--file-uri",
          "vscode-remote://ssh-remote+dev/repo/src/app.ts:9",
        ],
      },
    ]);
  });

  it("opens a remote workspace in Zed as an ssh URL, folder only", async () => {
    const runtime = new FakeEditorTargets();
    runtime.installCommand("zeditor");

    // Zed documents `zed ssh://[user@]host[:port]/<path>` for remote paths and `path:line`
    // only for local ones, so the active file and line are dropped rather than guessed at.
    await openEditorTarget(
      {
        editorId: "zed",
        workspacePath: "/home/user/my repo",
        filePath: "/home/user/my repo/src/app.ts",
        line: 9,
        remoteDestination: { kind: "ssh", host: "me@build.example.com:2222" },
      },
      runtime,
      [zedTarget],
    );

    expect(runtime.launches).toEqual([
      {
        command: "/bin/zeditor",
        args: ["ssh://me@build.example.com:2222/home/user/my%20repo"],
      },
    ]);
  });

  it("keeps opening local paths positionally for Zed", async () => {
    const runtime = new FakeEditorTargets();
    runtime.installCommand("zeditor");

    await zedTarget.launch(
      { workspacePath: "/repo", filePath: "/repo/src/app.ts", line: 7, column: 2 },
      runtime,
    );

    expect(runtime.launches).toEqual([
      { command: "/bin/zeditor", args: ["/repo", "/repo/src/app.ts:7:2"] },
    ]);
  });

  it("does not offer SSH for an installed app whose CLI is missing, but still offers it locally", async () => {
    // The common macOS shape: VS Code.app present, `code` never installed into PATH.
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Visual Studio Code");
    runtime.addPath("/repo");

    const [descriptor] = await listAvailableEditorTargets(runtime, [vscodeTarget]);

    expect(descriptor?.id).toBe("vscode");
    expect(descriptor?.remoteDestinationKinds).toEqual([]);

    await openEditorTarget({ editorId: "vscode", workspacePath: "/repo" }, runtime, [vscodeTarget]);
    expect(runtime.openedMacApplications).toEqual([
      { applicationName: "Visual Studio Code", paths: ["/repo"] },
    ]);
  });

  it("offers SSH for the same app once its CLI resolves", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Visual Studio Code");
    runtime.installCommand("code");

    const [descriptor] = await listAvailableEditorTargets(runtime, [vscodeTarget]);

    expect(descriptor?.remoteDestinationKinds).toEqual(["ssh"]);
  });

  it("refuses a remote open when the app is installed but its CLI is not", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Visual Studio Code");

    await expect(
      openEditorTarget(
        { editorId: "vscode", workspacePath: "/repo", remoteDestination: sshDestination },
        runtime,
        [vscodeTarget],
      ),
    ).rejects.toThrow("Editor target cannot open a ssh remote workspace: VS Code");
    expect(runtime.openedMacApplications).toEqual([]);
  });

  it("refuses a remote open on a target that cannot reach another machine", async () => {
    const runtime = new FakeEditorTargets();
    runtime.addPath("/repo");

    await expect(
      openEditorTarget(
        { editorId: "webstorm", workspacePath: "/repo", remoteDestination: sshDestination },
        runtime,
        [webstormTarget],
      ),
    ).rejects.toThrow("Editor target cannot open a ssh remote workspace: WebStorm");
    expect(runtime.launches).toEqual([]);
  });

  it("refuses a direct remote launch that bypasses the registry's capability check", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Visual Studio Code");

    await expect(
      vscodeTarget.launch({ workspacePath: "/repo", remoteDestination: sshDestination }, runtime),
    ).rejects.toThrow("VS Code command line tools are required to open a remote workspace");
    expect(runtime.openedMacApplications).toEqual([]);
  });

  it("judges a remote path by POSIX rules, not by this desktop's platform", async () => {
    // A macOS or Linux client must not reject a POSIX daemon path, and must not accept a
    // Windows one it has no way to render. Windows daemons stay out of scope.
    const runtime = new FakeEditorTargets("darwin");
    runtime.installCommand("code");

    await openEditorTarget(
      { editorId: "vscode", workspacePath: "/home/user/repo", remoteDestination: sshDestination },
      runtime,
      [vscodeTarget],
    );
    expect(runtime.launches).toEqual([
      {
        command: "/bin/code",
        args: ["--folder-uri", "vscode-remote://ssh-remote+dev/home/user/repo"],
      },
    ]);

    await expect(
      openEditorTarget(
        { editorId: "vscode", workspacePath: "C:/repo", remoteDestination: sshDestination },
        runtime,
        [vscodeTarget],
      ),
    ).rejects.toThrow("Editor target workspace path must be an absolute path");
  });

  it("keeps judging local paths by this desktop's platform", async () => {
    const runtime = new FakeEditorTargets("win32");
    runtime.installCommand("code", "C:/Editors/code.cmd");
    runtime.addPath("C:/repo");

    await openEditorTarget({ editorId: "vscode", workspacePath: "C:/repo" }, runtime, [
      vscodeTarget,
    ]);

    expect(runtime.launches).toEqual([{ command: "C:/Editors/code.cmd", args: ["C:/repo"] }]);
  });

  it("keeps requiring a local path to exist when no destination is given", async () => {
    const runtime = new FakeEditorTargets();
    runtime.installCommand("code");

    await expect(
      openEditorTarget({ editorId: "vscode", workspacePath: "/repo" }, runtime, [vscodeTarget]),
    ).rejects.toThrow("Path does not exist: /repo");
  });

  it("keeps the platform file-manager ids used by stored preferences", async () => {
    const macTargets = await listAvailableEditorTargets(new FakeEditorTargets("darwin"), [
      finderTarget,
      explorerTarget,
      fileManagerTarget,
    ]);
    const windowsTargets = await listAvailableEditorTargets(new FakeEditorTargets("win32"), [
      finderTarget,
      explorerTarget,
      fileManagerTarget,
    ]);

    expect(macTargets.map((target) => target.id)).toEqual(["finder"]);
    expect(windowsTargets.map((target) => target.id)).toEqual(["explorer"]);
  });
});
