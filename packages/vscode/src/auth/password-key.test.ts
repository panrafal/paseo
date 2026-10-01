import { describe, expect, it } from "vitest";
import { createDaemonPasswordKey } from "./password-key";

describe("daemon password key", () => {
  it("separates the same endpoint across local and remote extension hosts", () => {
    const local = createDaemonPasswordKey({
      endpoint: "127.0.0.1:6767",
      hostName: "macbook",
      machineId: "vscode-client-machine",
      remoteName: null,
    });
    const devbox = createDaemonPasswordKey({
      endpoint: "127.0.0.1:6767",
      hostName: "devbox",
      machineId: "vscode-client-machine",
      remoteName: "ssh-remote",
    });
    const buildbox = createDaemonPasswordKey({
      endpoint: "127.0.0.1:6767",
      hostName: "buildbox",
      machineId: "vscode-client-machine",
      remoteName: "ssh-remote",
    });

    expect(new Set([local, devbox, buildbox]).size).toBe(3);
    expect(devbox).toBe(
      createDaemonPasswordKey({
        endpoint: "127.0.0.1:6767",
        hostName: "devbox",
        machineId: "vscode-client-machine",
        remoteName: "ssh-remote",
      }),
    );
  });
});
