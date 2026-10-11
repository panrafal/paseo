import { probeDaemonStatus, type FetchLike } from "../daemon/discovery";

export async function ensureUsableDaemonPassword(input: {
  endpoint: string;
  getStoredPassword: () => Promise<string | null>;
  clearStoredPassword: () => Promise<void>;
  promptForPassword: () => Promise<string>;
  fetch?: FetchLike;
}): Promise<void> {
  const storedPassword = await input.getStoredPassword();
  if (!storedPassword) {
    await input.promptForPassword();
    return;
  }

  const probe = await probeDaemonStatus({
    endpoint: input.endpoint,
    password: storedPassword,
    fetch: input.fetch,
  });
  if (probe.status !== "unauthorized") {
    return;
  }

  await input.clearStoredPassword();
  await input.promptForPassword();
}
