// node --test fork/verify-scope.test.mjs — fork/verify-scope.mjs against a
// scratch repository shaped like the monorepo: protocol <- client <- app, and
// a standalone website.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const SCRIPT = path.join(import.meta.dirname, "verify-scope.mjs");
const root = mkdtempSync(path.join(tmpdir(), "verify-scope-"));
after(() => rmSync(root, { recursive: true, force: true }));

let repo;
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

function write(file, content) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), content);
}

function commit(files, message) {
  for (const [file, content] of Object.entries(files)) write(file, content);
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

function pkg(name, deps, extra = {}) {
  return JSON.stringify({
    name,
    dependencies: Object.fromEntries(deps.map((dep) => [dep, "*"])),
    scripts: { build: "tsc", typecheck: "tsgo --noEmit" },
    ...extra,
  });
}

function scope(...args) {
  const out = execFileSync("node", [SCRIPT, ...args], { cwd: repo, encoding: "utf8" });
  const lines = out.split("\n").filter(Boolean);
  const pick = (kind) =>
    lines.filter((line) => line.startsWith(`${kind} `)).map((line) => line.slice(kind.length + 1));
  const builds = pick("build").map((line) => line.split(" "));
  return {
    build: builds.map(([name]) => name),
    buildKeys: Object.fromEntries(builds.map(([name, key]) => [name, key])),
    buildOutputs: Object.fromEntries(builds.map(([name, , ...outputs]) => [name, outputs])),
    typecheck: pick("typecheck"),
    test: pick("test"),
    note: pick("note"),
  };
}

let upstream;
beforeEach(() => {
  repo = mkdtempSync(path.join(root, "repo-"));
  git("init", "-q", "-b", "main");
  upstream = commit(
    {
      "package.json": JSON.stringify({
        name: "root",
        workspaces: ["packages/protocol", "packages/client", "packages/app", "packages/website"],
      }),
      "package-lock.json": "{}",
      "packages/protocol/package.json": pkg("protocol", [], { types: "./dist/index.d.ts" }),
      "packages/protocol/src/index.ts": "export {};\n",
      "packages/client/package.json": pkg("client", ["protocol"], { files: ["dist"] }),
      "packages/client/vitest.config.ts": "",
      "packages/client/src/index.ts": "export {};\n",
      "packages/client/src/index.test.ts": "",
      "packages/app/package.json": pkg("app", ["client"], { main: "index.ts" }),
      "packages/app/vitest.config.ts": "",
      "packages/app/src/screen.tsx": "",
      "packages/app/src/screen.test.tsx": "",
      "packages/app/e2e/flow.e2e.test.ts": "",
      "packages/website/package.json": pkg("website", []),
      "packages/website/src/page.ts": "",
    },
    "upstream",
  );
  git("switch", "-q", "-c", "fork");
});

test("a change to a leaf checks it alone, on built dependencies", () => {
  commit(
    { "packages/app/src/screen.tsx": "// fork\n", "packages/app/e2e/flow.e2e.test.ts": "//" },
    "app",
  );
  const s = scope(upstream);
  assert.deepEqual(s.typecheck, ["app"]);
  assert.deepEqual(s.build, ["protocol", "client"]);
  assert.deepEqual(s.test, ["packages/app src/screen.test.tsx"]);
});

test("a change to a dependency checks its dependents", () => {
  commit(
    { "packages/protocol/src/index.ts": "// fork\n", "packages/client/src/index.ts": "// fork\n" },
    "lib",
  );
  const s = scope(upstream);
  assert.deepEqual(s.typecheck, ["protocol", "client", "app"]);
  assert.deepEqual(s.build, ["protocol", "client"]);
  assert.deepEqual(s.test, ["packages/client src/index.test.ts"]);
});

test("files no workspace reads check nothing", () => {
  commit({ "fork/verify.sh": "", "docs/x.md": "", "README.md": "" }, "docs");
  const s = scope(upstream);
  assert.deepEqual(s.typecheck, []);
  assert.deepEqual(s.build, []);
});

test("a root file reaches every workspace", () => {
  commit({ "package-lock.json": "{ }" }, "lock");
  assert.deepEqual(scope(upstream).typecheck, ["protocol", "client", "app", "website"]);
});

test("since a verified commit, only what changed and the fork touches is checked", () => {
  const verified = commit(
    { "package-lock.json": "{ }", "packages/app/src/screen.tsx": "// fork\n" },
    "fork",
  );
  git("switch", "-q", "main");
  const upstream2 = commit({ "packages/website/src/page.ts": "// upstream\n" }, "upstream website");
  git("switch", "-q", "fork");
  git("merge", "-q", "--no-edit", "main");
  // The fork's lockfile reaches every workspace, but only website changed
  // since the verified commit.
  assert.deepEqual(scope(upstream2, verified).typecheck, ["website"]);

  const verified2 = git("rev-parse", "HEAD");
  git("switch", "-q", "main");
  const upstream3 = commit(
    { "packages/protocol/src/index.ts": "// upstream\n" },
    "upstream protocol",
  );
  git("switch", "-q", "fork");
  git("merge", "-q", "--no-edit", "main");
  assert.deepEqual(scope(upstream3, verified2).typecheck, ["protocol", "client", "app"]);
});

test("since a verified commit, a leaf the fork touches is skipped when nothing under it moved", () => {
  const verified = commit({ "packages/app/src/screen.tsx": "// fork\n" }, "app");
  git("switch", "-q", "main");
  const upstream2 = commit({ "packages/website/src/page.ts": "// upstream\n" }, "upstream website");
  git("switch", "-q", "fork");
  git("merge", "-q", "--no-edit", "main");
  const s = scope(upstream2, verified);
  assert.deepEqual(s.typecheck, []);
  assert.deepEqual(s.test, []);
});

test("an unknown since falls back to the base", () => {
  commit({ "packages/app/src/screen.tsx": "// fork\n" }, "app");
  const s = scope(upstream, "0000000000000000000000000000000000000000");
  assert.deepEqual(s.typecheck, ["app"]);
  assert.match(s.note.join("\n"), /does not resolve/);
});

test("a build key changes with the workspace, its dependencies and root inputs only", () => {
  commit({ "packages/app/src/screen.tsx": "// fork\n" }, "app");
  const first = scope(upstream);
  assert.deepEqual(first.buildOutputs, {
    protocol: ["packages/protocol/dist"],
    client: ["packages/client/dist"],
  });

  commit({ "packages/app/src/screen.tsx": "// fork 2\n", "docs/y.md": "" }, "app again");
  assert.deepEqual(scope(upstream).buildKeys, first.buildKeys);

  commit({ "packages/client/src/index.ts": "// fork\n" }, "client");
  const second = scope(upstream);
  assert.equal(second.buildKeys.protocol, first.buildKeys.protocol);
  assert.notEqual(second.buildKeys.client, first.buildKeys.client);

  commit({ "package-lock.json": "{ }" }, "lock");
  assert.notEqual(scope(upstream).buildKeys.protocol, first.buildKeys.protocol);
});
