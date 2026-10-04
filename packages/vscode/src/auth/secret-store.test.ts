import { describe, expect, it, vi } from "vitest";
import { createDaemonPasswordKey } from "./password-key";

vi.mock("node:os", () => ({ hostname: () => "devbox" }));
vi.mock("vscode", () => ({
  env: { machineId: "vscode-client-machine", remoteName: "ssh-remote" },
  window: {},
}));

import { clearPassword, getPassword, setPassword } from "./secret-store";

describe("daemon password secret store", () => {
  it("uses the current extension host instead of an endpoint-only legacy secret", async () => {
    const endpoint = "127.0.0.1:6767";
    const legacyKey = `paseo.daemonPassword.${endpoint}`;
    const scopedKey = createDaemonPasswordKey({
      endpoint,
      hostName: "devbox",
      machineId: "vscode-client-machine",
      remoteName: "ssh-remote",
    });
    const values = new Map([[legacyKey, "local-password"]]);
    const context = {
      secrets: {
        get: async (key: string) => values.get(key),
        store: async (key: string, value: string) => {
          values.set(key, value);
        },
        delete: async (key: string) => {
          values.delete(key);
        },
      },
    } as unknown as Parameters<typeof getPassword>[0];

    await expect(getPassword(context, endpoint)).resolves.toBeNull();

    await setPassword(context, endpoint, "devbox-password");
    expect(values).toEqual(new Map([[scopedKey, "devbox-password"]]));
    await expect(getPassword(context, endpoint)).resolves.toBe("devbox-password");

    await clearPassword(context, endpoint);
    expect(values.size).toBe(0);
  });
});
