import { hostname } from "node:os";
import * as vscode from "vscode";
import { type FetchLike, validateDaemonPassword } from "../daemon/discovery";
import { createDaemonPasswordKey } from "./password-key";

function passwordKey(endpoint: string): string {
  return createDaemonPasswordKey({
    endpoint,
    hostName: hostname(),
    machineId: vscode.env.machineId,
    remoteName: vscode.env.remoteName ?? null,
  });
}

function legacyPasswordKey(endpoint: string): string {
  return `paseo.daemonPassword.${endpoint}`;
}

export async function getPassword(
  context: vscode.ExtensionContext,
  endpoint: string,
): Promise<string | null> {
  // Do not fall back to endpoint-only keys: localhost can identify a different
  // daemon in every local, SSH, WSL, or Codespaces extension host.
  return (await context.secrets.get(passwordKey(endpoint))) ?? null;
}

export async function setPassword(
  context: vscode.ExtensionContext,
  endpoint: string,
  password: string,
): Promise<void> {
  await context.secrets.store(passwordKey(endpoint), password);
  await context.secrets.delete(legacyPasswordKey(endpoint));
}

export async function clearPassword(
  context: vscode.ExtensionContext,
  endpoint: string,
): Promise<void> {
  await context.secrets.delete(passwordKey(endpoint));
  await context.secrets.delete(legacyPasswordKey(endpoint));
}

export async function promptForDaemonPassword(input: {
  context: vscode.ExtensionContext;
  endpoint: string;
  fetch?: FetchLike;
}): Promise<string> {
  const password = await vscode.window.showInputBox({
    password: true,
    ignoreFocusOut: true,
    prompt: "Paseo daemon password",
  });
  if (!password) {
    throw new Error("Paseo daemon password is required.");
  }
  const valid = await validateDaemonPassword({
    endpoint: input.endpoint,
    password,
    fetch: input.fetch,
  });
  if (!valid) {
    throw new Error("Incorrect Paseo daemon password.");
  }
  await setPassword(input.context, input.endpoint, password);
  return password;
}
