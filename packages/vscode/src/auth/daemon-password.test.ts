import { describe, expect, it, vi } from "vitest";
import { ensureUsableDaemonPassword } from "./daemon-password";

function createFetch(status: number) {
  return vi.fn(async () => ({
    status,
    json: async () => ({}),
  }));
}

describe("daemon password preparation", () => {
  it("keeps a valid stored password without prompting", async () => {
    const fetch = createFetch(200);
    const clearStoredPassword = vi.fn(async () => undefined);
    const promptForPassword = vi.fn(async () => "new-password");

    await ensureUsableDaemonPassword({
      endpoint: "127.0.0.1:6767",
      getStoredPassword: async () => "current-password",
      clearStoredPassword,
      promptForPassword,
      fetch,
    });

    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:6767/api/status", {
      headers: { Authorization: "Bearer current-password" },
    });
    expect(clearStoredPassword).not.toHaveBeenCalled();
    expect(promptForPassword).not.toHaveBeenCalled();
  });

  it("clears an invalid stored password before prompting", async () => {
    const calls: string[] = [];

    await ensureUsableDaemonPassword({
      endpoint: "127.0.0.1:6767",
      getStoredPassword: async () => "stale-password",
      clearStoredPassword: async () => {
        calls.push("clear");
      },
      promptForPassword: async () => {
        calls.push("prompt");
        return "new-password";
      },
      fetch: createFetch(401),
    });

    expect(calls).toEqual(["clear", "prompt"]);
  });

  it("keeps the stored password when validation cannot reach the daemon", async () => {
    const clearStoredPassword = vi.fn(async () => undefined);
    const promptForPassword = vi.fn(async () => "new-password");

    await ensureUsableDaemonPassword({
      endpoint: "127.0.0.1:6767",
      getStoredPassword: async () => "current-password",
      clearStoredPassword,
      promptForPassword,
      fetch: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });

    expect(clearStoredPassword).not.toHaveBeenCalled();
    expect(promptForPassword).not.toHaveBeenCalled();
  });
});
