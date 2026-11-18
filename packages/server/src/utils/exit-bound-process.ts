import type { ChildProcess } from "node:child_process";

import { spawnProcess, type SpawnProcessOptions } from "./spawn.js";

const liveProcesses = new Set<ChildProcess>();
let exitHookInstalled = false;

// Some agent CLIs (cursor-agent's ACP server) keep running when their stdin
// closes, so a daemon worker that exits without closing its sessions (uncaught
// exception, supervisor loss, forced shutdown) would orphan them to PID 1. Each
// child leads its own process group, and a synchronous `exit` hook kills every
// group still alive. SIGKILL of the worker skips `exit`; the supervisor's
// process-tree kill covers that case.
export function spawnExitBoundProcess(
  command: string,
  args: string[],
  options?: SpawnProcessOptions,
): ChildProcess {
  const child = spawnProcess(command, args, {
    ...options,
    detached: process.platform !== "win32",
  });
  if (child.pid === undefined) {
    return child;
  }
  liveProcesses.add(child);
  child.once("exit", () => liveProcesses.delete(child));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", killExitBoundProcesses);
  }
  return child;
}

export function killExitBoundProcesses(): void {
  for (const child of liveProcesses) {
    const pid = child.pid!;
    try {
      process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  liveProcesses.clear();
}
