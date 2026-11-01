import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Every daemon a test boots syncs orchestration skills into the agent homes.
// Point that at a throwaway folder instead of the developer's real ~; workers
// inherit the variable from this process.
export default function setup(): (() => void) | undefined {
  if (process.env.PASEO_SKILLS_HOME) return undefined;
  const skillsHome = mkdtempSync(path.join(os.tmpdir(), "paseo-test-skills-home-"));
  process.env.PASEO_SKILLS_HOME = skillsHome;
  return () => rmSync(skillsHome, { recursive: true, force: true });
}
