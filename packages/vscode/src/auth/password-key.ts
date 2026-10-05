export function createDaemonPasswordKey(input: {
  endpoint: string;
  hostName: string;
  machineId: string;
  remoteName: string | null;
}): string {
  const scope = JSON.stringify([
    input.remoteName ?? "local",
    input.hostName,
    input.machineId,
    input.endpoint,
  ]);
  return `paseo.daemonPassword.v2.${encodeURIComponent(scope)}`;
}
