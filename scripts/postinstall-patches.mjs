import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";

// In CI we often install a single workspace (e.g. server/relay/website). Only apply patches
// when the patched dependency is actually present.
// `cwd` is where patch-package must run from. Packages that npm does not hoist to the
// workspace root live in their workspace's own node_modules, and patch-package resolves
// the patch's node_modules/... paths relative to its working directory.
const patchedPackages = [
  {
    nodeModulesPath: "node_modules/react-native-markdown-display",
    patchPrefix: "react-native-markdown-display+",
  },
  {
    nodeModulesPath: "node_modules/react-native-uitextview",
    patchPrefix: "react-native-uitextview+",
  },
  // Remove after react-native-unistyles ships
  // https://github.com/jpudysz/react-native-unistyles/pull/1203.
  {
    nodeModulesPath: "node_modules/react-native-unistyles",
    patchPrefix: "react-native-unistyles+",
  },
  {
    nodeModulesPath: "node_modules/react-native-draggable-flatlist",
    patchPrefix: "react-native-draggable-flatlist+",
  },
  {
    nodeModulesPath: "node_modules/react-native-gesture-handler",
    patchPrefix: "react-native-gesture-handler+",
  },
  {
    nodeModulesPath: "node_modules/react-native-svg",
    patchPrefix: "react-native-svg+",
  },
  {
    nodeModulesPath: "node_modules/@mattermost/react-native-paste-input",
    patchPrefix: "@mattermost+react-native-paste-input+",
  },
  {
    nodeModulesPath: "packages/server/node_modules/@opencode-ai/sdk",
    patchPrefix: "@opencode-ai+sdk+",
    cwd: "packages/server",
  },
];

const installedPackages = patchedPackages.filter(({ nodeModulesPath }) =>
  existsSync(nodeModulesPath),
);

if (!existsSync("patches") || installedPackages.length === 0) {
  process.exit(0);
}

const patchFiles = readdirSync("patches").filter((file) => file.endsWith(".patch"));

// Group patch files, and the packages they patch, by the directory patch-package must run from.
const groupsByCwd = new Map();
for (const { nodeModulesPath, patchPrefix, cwd = "." } of installedPackages) {
  const files = patchFiles.filter((file) => file.startsWith(patchPrefix));
  if (files.length === 0) {
    continue;
  }
  const group = groupsByCwd.get(cwd) ?? { files: [], packagePaths: [] };
  group.files.push(...files);
  group.packagePaths.push(nodeModulesPath);
  groupsByCwd.set(cwd, group);
}

if (groupsByCwd.size === 0) {
  process.exit(0);
}

const isWindows = process.platform === "win32";

function run(command, args, options) {
  const result = spawnSync(isWindows ? `${command}.cmd` : command, args, {
    shell: isWindows,
    windowsHide: true,
    ...options,
  });
  if (result.error) {
    console.error(`postinstall-patches: ${command} failed to spawn:`, result.error.message);
  }
  return result;
}

// npm skips packages whose version did not change, so node_modules can still hold a
// copy patched by an older revision of a patch file. patch-package can neither apply
// the new patch nor recognise it as applied; put the published files back first.
function restorePristine(nodeModulesPath, tempDir) {
  const { name, version } = JSON.parse(readFileSync(join(nodeModulesPath, "package.json"), "utf8"));
  const pack = run(
    "npm",
    ["pack", `${name}@${version}`, "--silent", "--pack-destination", tempDir],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const tarball = pack.stdout?.trim().split("\n").pop();
  if (pack.status !== 0 || !tarball) {
    return false;
  }
  rmSync(nodeModulesPath, { recursive: true, force: true });
  mkdirSync(nodeModulesPath, { recursive: true });
  const untar = spawnSync(
    "tar",
    ["-xzf", join(tempDir, tarball), "--strip-components=1", "-C", nodeModulesPath],
    {
      stdio: "inherit",
      windowsHide: true,
    },
  );
  return untar.status === 0;
}

let groupIndex = 0;
for (const [cwd, { files, packagePaths }] of groupsByCwd) {
  groupIndex += 1;
  const tempPatchDir = join(".tmp", `postinstall-patches-${process.pid}-${groupIndex}`);
  const tempPackDir = join(".tmp", `postinstall-packs-${process.pid}-${groupIndex}`);

  mkdirSync(tempPatchDir, { recursive: true });
  mkdirSync(tempPackDir, { recursive: true });
  for (const patchFile of files) {
    copyFileSync(join("patches", patchFile), join(tempPatchDir, patchFile));
  }

  // patch-package exits 0 on a failed patch unless it runs on CI or gets --error-on-fail.
  const applyPatches = () =>
    run("patch-package", ["--error-on-fail", "--patch-dir", relative(cwd, tempPatchDir)], {
      cwd,
      stdio: "inherit",
    });

  let result;
  try {
    result = applyPatches();
    if (result.status !== 0 && !result.error) {
      console.error("postinstall-patches: restoring pristine packages and retrying");
      if (packagePaths.every((path) => restorePristine(path, tempPackDir))) {
        result = applyPatches();
      }
    }
  } finally {
    rmSync(tempPatchDir, { recursive: true, force: true });
    rmSync(tempPackDir, { recursive: true, force: true });
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

process.exit(0);
