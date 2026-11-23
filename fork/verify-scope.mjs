#!/usr/bin/env node
//
// fork/verify-scope.mjs <base> [<since>] — what fork/verify.sh has to build,
// typecheck and test in the tree in the current directory.
//
// A workspace needs checking when both hold:
//   - the fork changes it, or a workspace it depends on, relative to <base>.
//     Anything else is upstream's code on upstream's dependencies.
//   - it, or a workspace it depends on, changed since <since>, a commit that
//     passed fork/verify.sh before. Anything else is what already passed.
// A change outside every workspace that can reach them all (the lockfile,
// package.json, a tsconfig at the root) counts as a change to every workspace.
//
// Prints one line per item, in the order fork/verify.sh runs them:
//   note <text>              why the scope is what it is
//   build <workspace> <key> <output>...
//                            a dependency whose dist/ a checked workspace
//                            reads, in dependency order. <key> hashes every
//                            input of the build, so an output built from the
//                            same key can be kept; <output> are the dirs
//                            other workspaces read it from. A workspace whose build another
//                            listed build runs is folded into that one.
//   typecheck <workspace>
//   test <dir> <file>        a test file the fork changes, or the test beside a
//                            source file it changes, relative to its workspace
//                            dir; browser and e2e tests are left out

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Paths outside the workspaces that no build, typecheck or unit test reads.
const IRRELEVANT = [
  /^fork\//,
  /^docs\//,
  /^public-docs\//,
  /^\.github\//,
  /^scratch\//,
  /^nix\//,
  /^docker\//,
  /^fastlane\//,
  /^\.(agents|claude|codex)\//,
  /^[^/]+\.md$/,
  /^scripts\/[^/]+\.test\.mjs$/,
  /^(LICENSE|\.gitignore|\.dockerignore|knip\.json|lefthook\.yml|paseo\.json|flake\.(nix|lock)|\.mise\.toml|\.tool-versions|\.oxfmtrc\.json|cli-client-id)$/,
];

// Paths outside the workspaces that a workspace reads: the server build copies
// skills/ into its dist, and the plugin package typechecks plugin-examples/.
const READ_BY = [
  [/^skills\//, "@getpaseo/server"],
  [/^plugin-examples\//, "@getpaseo/plugin"],
];

const [base, sinceArg] = process.argv.slice(2);
if (!base) {
  console.error("usage: fork/verify-scope.mjs <base> [<since>]");
  process.exit(2);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
}

function resolve(ref) {
  try {
    return git("rev-parse", "--verify", "-q", `${ref}^{commit}`)[0];
  } catch {
    return "";
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function workspaceDirs() {
  const root = readJson("package.json");
  const patterns = Array.isArray(root.workspaces)
    ? root.workspaces
    : (root.workspaces?.packages ?? []);
  return patterns.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern];
    const parent = pattern.slice(0, -2);
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`);
  });
}

const workspaces = new Map();
for (const dir of workspaceDirs()) {
  const file = path.join(dir, "package.json");
  if (!existsSync(file)) continue;
  const pkg = readJson(file);
  // The build outputs other workspaces import, so it has to be built before
  // they typecheck or test.
  const entryPoints = JSON.stringify([pkg.main, pkg.types, pkg.exports, pkg.bin, pkg.files]);
  const outputs = ["dist", "build"]
    .filter((out) => new RegExp(`(^|[/"])${out}[/"]`).test(entryPoints))
    .map((out) => `${dir}/${out}`);
  workspaces.set(pkg.name, {
    name: pkg.name,
    dir,
    scripts: pkg.scripts ?? {},
    deps: Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    }),
    outputs,
  });
}
for (const ws of workspaces.values()) ws.deps = ws.deps.filter((name) => workspaces.has(name));
const byDir = [...workspaces.values()].sort((a, b) => b.dir.length - a.dir.length);

// The workspaces the files change, or all: true when one of them reaches every
// workspace.
function changedWorkspaces(files) {
  const changed = new Set();
  for (const file of files) {
    const ws = byDir.find((candidate) => file.startsWith(`${candidate.dir}/`));
    if (ws) {
      changed.add(ws.name);
      continue;
    }
    const reader = READ_BY.find(([pattern]) => pattern.test(file));
    if (reader && workspaces.has(reader[1])) {
      changed.add(reader[1]);
      continue;
    }
    if (IRRELEVANT.some((pattern) => pattern.test(file))) continue;
    return { all: true, cause: file };
  }
  return { all: false, names: changed };
}

// The workspaces and everything that depends on them.
function withDependents(names) {
  const out = new Set(names);
  let grew = true;
  while (grew) {
    grew = false;
    for (const ws of workspaces.values()) {
      if (out.has(ws.name) || !ws.deps.some((dep) => out.has(dep))) continue;
      out.add(ws.name);
      grew = true;
    }
  }
  return out;
}

function withDependencies(names) {
  const out = new Set();
  const visit = (name) => {
    if (out.has(name)) return;
    out.add(name);
    for (const dep of workspaces.get(name).deps) visit(dep);
  };
  for (const name of names) visit(name);
  return out;
}

function inDependencyOrder(names) {
  const out = [];
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const dep of workspaces.get(name).deps) visit(dep);
    if (names.has(name)) out.push(name);
  };
  for (const name of [...names].sort()) visit(name);
  return out;
}

const notes = [];
const all = new Set(workspaces.keys());

// Every file whose change could matter: --no-renames so a move counts at both
// its old and its new path.
const forkBase = git("merge-base", base, "HEAD")[0];
const forkFiles = git("diff", "--name-only", "--no-renames", forkBase, "HEAD");
const fork = changedWorkspaces(forkFiles);
let check = fork.all ? new Set(all) : withDependents(fork.names);
notes.push(
  fork.all
    ? `the fork changes ${fork.cause}, which every workspace reads`
    : `the fork changes ${fork.names.size ? [...fork.names].sort().join(", ") : "no workspace"}`,
);

const since = sinceArg ? resolve(sinceArg) : "";
if (sinceArg && !since) notes.push(`${sinceArg} does not resolve; checking against ${base} alone`);
if (since) {
  const delta = changedWorkspaces(git("diff", "--name-only", "--no-renames", since, "HEAD"));
  if (delta.all) {
    notes.push(`${delta.cause} changed since ${since.slice(0, 12)}, which passed before`);
  } else {
    const moved = withDependents(delta.names);
    check = new Set([...check].filter((name) => moved.has(name)));
    notes.push(
      `since ${since.slice(0, 12)}, which passed before, ${delta.names.size ? `${[...delta.names].sort().join(", ")} changed` : "no workspace changed"}`,
    );
  }
}
notes.push(
  check.size === all.size
    ? "checking every workspace"
    : `checking ${check.size ? [...check].sort().join(", ") : "nothing"}`,
);

const build = new Set(
  [...withDependencies(check)].filter((name) => {
    const ws = workspaces.get(name);
    const dependedOn = [...workspaces.values()].some((other) => other.deps.includes(name));
    return ws.outputs.length > 0 && dependedOn && ws.scripts.build;
  }),
);

// What a build reads outside the workspaces: every root file and directory
// that is not a workspace's and not irrelevant (the lockfile, tsconfig.base,
// scripts/, patches/, skills/).
const workspaceRoots = new Set([...workspaces.values()].map((ws) => ws.dir.split("/")[0]));
const rootInputs = git("ls-tree", "HEAD").filter((line) => {
  const [meta, file] = line.split("\t");
  const probe = meta.includes(" tree ") ? `${file}/` : file;
  return !workspaceRoots.has(file) && !IRRELEVANT.some((pattern) => pattern.test(probe));
});

function buildKey(name) {
  const inputs = [...withDependencies([name])]
    .sort()
    .map((dep) => `${dep} ${git("rev-parse", `HEAD:${workspaces.get(dep).dir}`)[0]}`);
  return createHash("sha1")
    .update([...inputs, ...rootInputs].join("\n"))
    .digest("hex");
}

// The fork's tests in the checked workspaces: its changed tests, and the test
// beside each source file it changes.
const tests = new Set();
for (const file of forkFiles) {
  if (!existsSync(file)) continue;
  let test = null;
  if (/\.test\.tsx?$/.test(file)) test = file;
  else if (/\.tsx?$/.test(file)) {
    const candidate = file.replace(/\.(tsx?)$/, ".test.$1");
    if (existsSync(candidate)) test = candidate;
  }
  if (!test || /\.(browser|e2e)\.test\.tsx?$/.test(test) || test.includes("/e2e/")) continue;
  tests.add(test);
}

for (const note of notes) console.log(`note ${note}`);
for (const name of inDependencyOrder(build)) {
  console.log(`build ${name} ${buildKey(name)} ${workspaces.get(name).outputs.join(" ")}`);
}
for (const name of inDependencyOrder(check)) {
  if (workspaces.get(name).scripts.typecheck) console.log(`typecheck ${name}`);
}
for (const test of [...tests].sort()) {
  const ws = byDir.find((candidate) => test.startsWith(`${candidate.dir}/`));
  if (!ws || !check.has(ws.name)) continue;
  if (!readdirSync(ws.dir).some((entry) => entry.startsWith("vitest.config."))) continue;
  console.log(`test ${ws.dir} ${test.slice(ws.dir.length + 1)}`);
}
