import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const moduleUrl = new URL("./exit-bound-process.ts", import.meta.url).href;

let tempDir: string | null = null;
const spawnedPids: number[] = [];

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function readPid(filePath: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(filePath, "utf8")).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

afterEach(async () => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("spawnExitBoundProcess()", () => {
  test.skipIf(process.platform === "win32")(
    "kills the child and its descendants when the owning worker crashes",
    async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), "paseo-exit-bound-"));
      const agentPidPath = path.join(tempDir, "agent.pid");
      const descendantPidPath = path.join(tempDir, "descendant.pid");
      // Stands in for cursor-agent: ignores SIGTERM and stdin EOF, and owns a
      // descendant of its own.
      const agentScript = `
        const fs = require("node:fs");
        const { spawn } = require("node:child_process");
        process.on("SIGTERM", () => {});
        const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
        fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
        fs.writeFileSync(${JSON.stringify(agentPidPath)}, String(process.pid));
        setInterval(() => {}, 1000);
      `;
      const workerPath = path.join(tempDir, "worker.mjs");
      await writeFile(
        workerPath,
        `
          import { existsSync } from "node:fs";
          import { EventEmitter } from "node:events";
          import { spawnExitBoundProcess } from ${JSON.stringify(moduleUrl)};

          process.on("uncaughtException", () => process.exit(1));
          spawnExitBoundProcess(process.execPath, ["-e", ${JSON.stringify(agentScript)}], {
            stdio: ["pipe", "pipe", "pipe"],
          });
          const ready = setInterval(() => {
            if (!existsSync(${JSON.stringify(agentPidPath)})) return;
            clearInterval(ready);
            new EventEmitter().emit("error", new Error("spawn cursor-agent ENOENT"));
          }, 20);
        `,
      );

      const worker = spawn(process.execPath, ["--import", "tsx", workerPath], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      worker.stderr.setEncoding("utf8");
      worker.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const exitCode = await new Promise<number | null>((resolve) => worker.on("exit", resolve));

      const agentPid = await readPid(agentPidPath);
      const descendantPid = await readPid(descendantPidPath);
      if (agentPid) spawnedPids.push(agentPid);
      if (descendantPid) spawnedPids.push(descendantPid);
      expect(exitCode, stderr).toBe(1);
      expect(agentPid).not.toBeNull();
      expect(descendantPid).not.toBeNull();

      await waitFor(
        () => !isProcessRunning(agentPid!) && !isProcessRunning(descendantPid!),
        "agent process tree outlived the worker",
      );
    },
  );
});
