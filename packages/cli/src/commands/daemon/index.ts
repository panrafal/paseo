import { Command } from "commander";
import { startCommand, daemonRunCommand } from "./start.js";
import { daemonStatusCommand } from "./status.js";
import { daemonStopCommand } from "./stop.js";
import { daemonRestartCommand } from "./restart.js";
import { runSetPasswordCommand } from "./set-password.js";
import { pairCommand } from "./pair.js";
import { daemonReloadCommand } from "./reload.js";
import { daemonConfigCommand } from "./config.js";
import { runDevicesListCommand, runDevicesRevokeCommand } from "./devices.js";
import { withOutput } from "../../output/index.js";
import { addJsonOption, addLocalDaemonOptions } from "../../utils/command-options.js";

export function createDaemonCommand(): Command {
  const daemon = new Command("daemon").description("Manage the Paseo daemon");
  for (const command of [
    startCommand(),
    daemonRunCommand(),
    daemonStatusCommand(),
    daemonStopCommand(),
    daemonRestartCommand(),
    daemonReloadCommand(),
    pairCommand(),
    daemonConfigCommand(),
  ])
    daemon.addCommand(command);
  addJsonOption(
    addLocalDaemonOptions(
      daemon.command("set-password").description("Save a hashed daemon password (local operation)"),
    ),
  ).action(withOutput(runSetPasswordCommand));
  const devices = addJsonOption(
    addLocalDaemonOptions(
      daemon
        .command("devices")
        .description("List devices paired through the relay (local operation)"),
    ),
  ).action(withOutput(runDevicesListCommand));
  addJsonOption(
    addLocalDaemonOptions(
      devices
        .command("revoke")
        .description("Revoke relay device credentials (local operation)")
        .argument("[id]", "Device ID from paseo daemon devices")
        .option("--all", "Revoke every paired device"),
    ),
  ).action(withOutput(runDevicesRevokeCommand));
  return daemon;
}
