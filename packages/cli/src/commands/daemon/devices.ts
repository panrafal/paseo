import type { Command } from "commander";
import {
  readPersistedConfig,
  RelayDeviceStore,
  resolveConfigFromPersisted,
  resolvePaseoHome,
} from "@getpaseo/server";
import type {
  CommandError,
  CommandOptions,
  ListResult,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

export interface RelayDeviceRow {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface RevokeRelayDevicesResult {
  action: "revoked";
  revoked: number;
  message: string;
}

const deviceRowSchema: OutputSchema<RelayDeviceRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id" },
    { header: "LABEL", field: "label" },
    { header: "PAIRED", field: "createdAt" },
    { header: "LAST SEEN", field: "lastSeenAt" },
  ],
};

const revokeResultSchema: OutputSchema<RevokeRelayDevicesResult> = {
  idField: "action",
  columns: [
    { header: "STATUS", field: "action", color: () => "green" },
    { header: "REVOKED", field: "revoked" },
  ],
  renderHuman: (result) => (result.data as RevokeRelayDevicesResult).message,
};

const DEVICE_AUTH_OFF_NOTE =
  "daemon.relay.deviceAuth is off, so relay clients still connect without pairing.";

function commandError(code: string, message: string): CommandError {
  return { code, message };
}

function resolveHome(options: CommandOptions): string {
  return resolvePaseoHome({
    PASEO_HOME: options.daemonTarget.kind === "instance" ? options.daemonTarget.home : undefined,
  });
}

export function isRelayDeviceAuthEnabled(paseoHome: string): boolean {
  const persisted = readPersistedConfig(paseoHome, { defaultsIfMissing: true });
  return resolveConfigFromPersisted(paseoHome, persisted, { env: {} }).relayDeviceAuth === true;
}

export function listRelayDevices(paseoHome: string): RelayDeviceRow[] {
  return new RelayDeviceStore({ paseoHome }).listDevices().map((device) => ({
    id: device.id,
    label: device.label ?? "",
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt ?? "",
  }));
}

export function revokeRelayDevices(input: {
  paseoHome: string;
  id: string | undefined;
  all: boolean;
  deviceAuth: boolean;
}): RevokeRelayDevicesResult {
  const note = input.deviceAuth ? "" : ` ${DEVICE_AUTH_OFF_NOTE}`;
  if (input.id !== undefined && input.all) {
    throw commandError("INVALID_ARGUMENTS", "Pass a device ID or --all, not both.");
  }
  const store = new RelayDeviceStore({ paseoHome: input.paseoHome });
  if (input.all) {
    const revoked = store.revokeAllDevices();
    return {
      action: "revoked",
      revoked,
      message: `Revoked ${revoked} device(s). They must pair again.${note}`,
    };
  }
  if (input.id === undefined) {
    throw commandError(
      "DEVICE_REQUIRED",
      "Pass a device ID from `paseo daemon devices`, or --all.",
    );
  }
  if (!store.revokeDevice(input.id)) {
    throw commandError("DEVICE_NOT_FOUND", `No paired device has ID ${input.id}.`);
  }
  return {
    action: "revoked",
    revoked: 1,
    message: `Revoked ${input.id}. It must pair again.${note}`,
  };
}

export async function runDevicesListCommand(
  options: CommandOptions,
  _command: Command,
): Promise<ListResult<RelayDeviceRow>> {
  const paseoHome = resolveHome(options);
  if (!isRelayDeviceAuthEnabled(paseoHome)) {
    process.stderr.write(`${DEVICE_AUTH_OFF_NOTE}\n`);
  }
  return { type: "list", data: listRelayDevices(paseoHome), schema: deviceRowSchema };
}

export async function runDevicesRevokeCommand(
  id: string | undefined,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<RevokeRelayDevicesResult>> {
  const paseoHome = resolveHome(options);
  return {
    type: "single",
    data: revokeRelayDevices({
      paseoHome,
      id,
      all: options.all === true,
      deviceAuth: isRelayDeviceAuthEnabled(paseoHome),
    }),
    schema: revokeResultSchema,
  };
}
