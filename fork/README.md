# The `panrafal` fork

This fork's `main` is the latest `getpaseo/paseo` `main` with my own patches
on top. It is what I build and run. It is not a branch I commit to — it is
derived from `fork-integration` on every run of `fork/integrate.sh`, so
anything committed directly to it is lost.

`main` is deliberately not a mirror of upstream. Cloning the fork should give
you the build I actually use, and upstream's workflows only fire on a branch
literally called `main` (`ci.yml` is `push: branches: [main]`), so mirroring
upstream into it burned a full CI run on every sync. `fork-base` moves
those workflows into `.github/workflows/disabled/`, which GitHub does not read,
and `main` carries that move. Upstream's `main` is `upstream/main`; there is no
fork-side copy of it and nothing needs one.

## Branches

| Branch             | Base            | Purpose                                                                                                                                                                         |
| ------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fork-base`        | `upstream/main` | Everything fork-only: this directory, and the repo changes the fork needs — own update feed and app identifiers, upstream workflows disabled, the `🍱` scripts in `paseo.json`. |
| PR branches        | `upstream/main` | One per change, sent upstream as a pull request.                                                                                                                                |
| `fork-integration` | kept            | `upstream/main` + `fork-base` + the PR branches, as merges. Advanced by `fork/integrate.sh`; rebuilt only on request.                                                           |
| `main`             | derived         | `fork-integration`'s tree as one commit on top of the newest upstream commit it contains. Force-pushed on every run.                                                            |

Everything except the last two is based on `upstream/main`, including
`fork-base`. Start a change with `fork/new-branch.sh <name>` rather than
`git switch -c`: `main` is the branch your fingers reach for, and a branch cut
from it carries the whole patch stack. `fork/integrate.sh` refuses such a
branch — it spots `fork/branches` in it — but only once the mistake is made.

## The quick route

Four `🍱` scripts in `paseo.json`, one tap each in the Paseo UI. They run on
whichever daemon hosts the workspace: the first three belong on the devbox,
`deploy` needs the laptop.

| Script                    | Runs                                               | When                                                                |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| `🍱 update with upstream` | `fork/integrate.sh rebase --agent --push`          | every day: latest upstream in, `main` published                     |
| `🍱 re-merge integration` | `fork/integrate.sh rebuild --agent --push`         | after removing a branch from `fork/branches`, or to start over      |
| `🍱 rebase branches`      | `fork/integrate.sh rebase-branches --agent --push` | when the PR branches need to sit on current upstream; rewrites them |
| `🍱 deploy`               | `fork/deploy.sh`                                   | from the laptop: build every target and install each where it runs  |

Single targets are built by hand with `fork/build.sh daemon`, `desktop`,
`vscode` or `ios` — see [Building](#building). Building never installs
anything; `fork/deploy.sh` does, see [Deploying](#deploying).

## Integrating

`fork-integration` is kept between runs, so the routine update is one merge:

```bash
fork/integrate.sh rebase --agent --push
```

1. Fetch upstream and the fork. A `fork-base` or `fork-integration` that
   another checkout advanced and pushed is fast-forwarded first; one that has
   diverged stops the run with the two ways out.
2. Merge `upstream/main` into `fork-integration`. Every patch meets the new
   upstream in this one merge, so a conflict shows up once, in one place,
   whatever the number of branches.
3. Merge any listed branch whose tip is not in the integration yet: one that
   gained commits merges trivially; one that was rewritten (amended, rebased)
   is merged through a link to the tip that was merged before, so only the
   difference between the two versions lands rather than every amended line
   conflicting.
4. Bump the build number on `fork-base` and merge it in, so the number is
   inside the commit it identifies. A run that merged nothing bumps nothing.
5. Derive `main`: `fork-integration`'s tree as one commit on the newest
   upstream commit it contains, with a message naming the integration commit
   and every branch tip that went in. Push `fork-base`, `fork-integration`
   and `main` together.

Run it from any worktree. The merges happen in a scratch worktree under
`~/.paseo-fork/integrate`, so a run that stops on a conflict leaves your
checkout alone. A checkout sitting on `main`, `fork-base` or
`fork-integration` is hard-reset to the result when the run succeeds, and
one with uncommitted changes to tracked files stops the run before any work
is done — stash or discard them first; do not commit them on `main`, the
next publish drops the commit. Drop `--agent` to stop on conflicts instead,
`--push` to keep everything local — it prints the push to run.

It also reports what it cannot fix: a listed branch it cannot resolve, a
branch that looks merged upstream (every commit has an equivalent on
`upstream/main`), and a branch that is in the integration but no longer in
the list. The last two are the same instruction: delete the line and rebuild.

`main` is a rewrite every time. Anywhere you consume it, re-sync with a reset,
not a pull:

```bash
git fetch origin && git reset --hard origin/main
```

### The other three

`fork/integrate.sh rebuild` starts over: a fresh worktree at `upstream/main`,
`fork-base` merged first, then every line of `fork/branches` in order, then
the build number. It is the only thing that drops a branch, and the only time
the order of the list matters. It also discards the old integration, and with
it any adaptation that lived only in its upstream merges — a fix that belongs
to a patch should be pushed down into the patch branch, not left in the
integration. The run ends with a diff stat against the previous integration
in the files the patches touch, so a lost adaptation shows up as a difference
nobody made on a branch.

`fork/integrate.sh rebase-branches` rebases `fork-base` and every listed
branch that has a local branch of the same name onto `upstream/main`,
force-pushes them, then rebuilds. A local branch that is behind its published
copy is fast-forwarded first; one that has diverged is rebased as it is, with
a warning, and the push drops what only the published copy had. A checkout
sitting on one of those branches is reset like one on `main`. Do this when
the PRs need to be mergeable again or when the routine merge is conflicting
badly. It rewrites the commits your open PRs point at, and its cost grows
with the time since the last one:
`rerere` replays a resolution only when the conflict looks the same, and a
branch resolved against the whole stack in an integration merge looks
different when replayed one commit at a time.

`fork/integrate.sh add <branch>` — also `fork/add-branch.sh <branch>` — lists
a branch and merges it in, without touching anything else. See
[Adding a change](#adding-a-change).

### Adding a change

Every change to Paseo itself is its own branch off `upstream/main`, never a
commit on `main`. That is what keeps it sendable upstream and what lets it be
merged on its own.

```bash
fork/new-branch.sh my-change
# ...work, commit...
git push -u origin my-change
fork/integrate.sh add my-change --push
```

`add` appends `origin/my-change` to `fork/branches` on `fork-base`, merges
the branch into `fork-integration`, bumps the number and publishes `main`.
The list line and the bump are committed only once the merge has succeeded,
so a run that stops on a conflict leaves `fork-base` untouched. Later pushes
to the branch are picked up by the next `rebase`; `gh pr create` sends the
same branch upstream whenever you want it reviewed.

The branch brings its own base along: one cut from today's upstream pulls
those upstream commits into the integration with it.

Anything fork-only — how the fork builds, ships, or syncs itself — goes on
`fork-base` instead. None of it would be accepted upstream, and it is the
one branch that is allowed to know it is a fork. The next `rebase` merges it
in.

### Changing what gets merged

`fork/branches` is read from the `fork-base` ref, not from your working tree,
so an uncommitted edit has no effect. A line added by hand is merged by the
next `rebase`. A line removed by hand takes effect at the next `rebuild`, and
`rebase` says so until then.

When a PR lands upstream, delete its line and rebuild. The commits arrive
through `upstream/main` instead; `rebase` flags the branch as merged upstream
once every one of its commits has an equivalent there. Do not try to unmerge
anything by hand.

### Conflicts

A merge that conflicts is handed to a Paseo agent with `--agent`, told which
listed branches touch each conflicted file so it can read a patch's intent
from the patch's own commits, and told never to drop an upstream change to
make a patch apply nor a patch's feature because its lines no longer fit. Set
`FORK_AGENT_PROVIDER` to pick the provider.

Without `--agent`, or when the agent gives up, the run stops and leaves the
scratch worktree in place. Resolve there, commit, and re-run the same
command: it continues from the merge you committed, so a fix made outside
the conflict hunks — an import, a call site — is kept too. A re-run whose
integration moved in the meantime starts over and says so.

`rerere` is on. It replays a resolution when the same conflict comes back,
which is what makes `rebase-branches` after a hand-resolved rebase bearable.
On the routine path the agent is the mechanism, not `rerere`: the next
upstream merge starts from the resolved text, so the conflict does not come
back in the same shape.

### Tests

`fork/integrate.test.sh` runs every command against scratch repositories
under a temp directory: rebuild, the routine rebase, branch drift, add,
conflicts and re-runs, rebase-branches, seeding a fresh clone, diverged
branches, dirty checkouts. Nothing touches this repository or
`~/.paseo-fork`. Run it after changing `fork/integrate.sh`.

## Versions

Every fork artifact carries the same stamped version, so a daemon, a desktop
app and a TestFlight build from one commit all report the same string:

```
0.7.2-panrafal.7
^^^^^ upstream base
              ^ fork build number
```

`paseo --version` on the devbox therefore tells you it is a fork build and
which build — a plain `0.7.2` is upstream's.

`fork/build-number` on `fork-base` holds both halves, `0.7.2 7`, because
the counter restarts at 1 whenever the upstream version moves. Storing the
version it counts for is what makes the restart detectable — a bare integer
cannot tell "first build of 0.7.3" from "someone reset the file".
`fork/integrate.sh` bumps it once per run that changes the integration,
after the merges — the number has to count the version the merged tree
carries, and an upstream merge can move it — and merges it in as the last
commit, so it is inside the `main` commit it identifies.

The restart is safe, but only under that rule: reset when the base moves, never
otherwise. Two things depend on it.

The desktop's in-app updater compares semver, and `0.7.3-panrafal.1` sorts
above `0.7.2-panrafal.99` because the base dominates — a restart is still an
upgrade. Within one base, numeric prerelease identifiers compare numerically,
so `panrafal.10` really is newer than `panrafal.9`.

The same number is the iOS `CFBundleVersion`, which App Store Connect requires
to increase within one `CFBundleShortVersionString`.
`packages/app/native-release-version.js` reports the bare base as the short
version, so a restart lands exactly when that string changes. Restarting while
the base held would be rejected at upload. Upstream's 1..999 build slot is a
per-release counter and would run out.

That file also parses the version with a hardcoded pattern. Change the suffix
and you change the regex, or every Expo config read throws — including
`expo export --platform web`, which the daemon's bundled web UI build runs.

A fork build sorts below the upstream release of the same base
(`0.7.2-panrafal.7` < `0.7.2`), which is correct: it is built from upstream `main`
after that release and before the next. The fork's update feed only lists fork
builds, so nothing compares the two.

`fork/build.sh` stamps the version after `npm install` (so the install
still resolves against the committed lockfile) and before anything is packed
(so the tarballs and their `@getpaseo/*` cross-dependency ranges all carry
it), using the repo's own `scripts/sync-workspace-versions.mjs`.

## Building

`fork/build.sh <target>` builds one thing and installs nothing:

| Target    | Produces                                                           |
| --------- | ------------------------------------------------------------------ |
| `prepare` | the build checkout at `~/.paseo-fork/build`, installed and stamped |
| `daemon`  | `~/.paseo-fork/dist/getpaseo-*-<version>.tgz`, seven tarballs      |
| `desktop` | a `fork-v<version>` tag, and a GitHub release once Actions is done |
| `vscode`  | `~/.paseo-fork/dist/paseo-vscode-<version>.vsix`                   |
| `ios`     | an EAS build that submits itself to TestFlight                     |

`daemon`, `vscode` and `ios` build `main` as it is in the local repository —
they do not fetch — in the build checkout, which is a detached worktree so
`fork/integrate.sh` can move `main` underneath it. `prepare` happens once per
`main` commit and is remembered in `.fork-prepared`; after that the three can
run at the same time, and a lock keeps two of them from both running
`npm install` into the checkout. `--clean` wipes `node_modules` and `dist`
first.

`desktop` builds nothing here. It pushes the local `main` to the fork when
that is a fast-forward — a `main` behind the published one stops it, so a
stale checkout cannot rewind the branch — pushes a `fork-v<version>` tag, and
waits for the Actions run.

`vscode` needs `packages/vscode`, which arrives through the `vscode` patch
branch; a `main` built without it makes the target a warning and exit 0.
`ios` waits for the EAS build unless told `--no-wait`.

## Deploying

```bash
fork/deploy.sh                # everything
fork/deploy.sh vscode daemon  # only these
```

Run it inside Paseo on the laptop. The `🍱 deploy` action fetches and resets
the laptop's `main`, then runs the script inside Paseo so you can follow its
logs and build links. The script resets `main` to `origin/main` here and on the
devbox — a `main` checkout with uncommitted changes stops it — so every
target comes from the same commit, then runs all four at once:

| Target    | Built                                     | Installed                                                                                          |
| --------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `daemon`  | on the devbox, over ssh                   | `npm install -g` on the devbox, `systemctl restart paseo`, then the healthcheck                    |
| `desktop` | by GitHub Actions, from a tag pushed here | After every job finishes, Terminal runs `fork/update-macos.sh` to install and relaunch the Mac app |
| `vscode`  | on the laptop                             | VS Code and Cursor on the laptop; VS Code Server and Cursor Server on the devbox                   |
| `ios`     | by EAS, queued from the laptop            | TestFlight, by EAS itself when the build is done; the deploy does not wait for it                  |

One target failing does not stop the others. Each target's output goes to
`~/.paseo-fork/deploy/<target>.log`, and the summary at the end says what was
built, where it went, and where a failed one stopped. A re-run of the same
version skips the desktop build when its release already exists; everything
else is idempotent.

The Mac update is the last step because it stops Paseo's local daemon and
the deploy script running inside it. Desktop builds alongside the other
targets; once all jobs have finished, including any failures, a successful
desktop build is handed to a separate Terminal window for installation.
The summary reports the desktop as built, with installation pending. Follow
the update in Terminal or `~/.paseo-fork/deploy/desktop-update.log`.
iOS only needs to be queued before this handoff; its cloud build continues.

It has to run off the devbox: installing the desktop app needs macOS, and
restarting the daemon kills every agent on the devbox, including one that
would be running this. `--no-update` builds whatever `main` is at now.

The laptop needs:

- bash 4 or newer (`brew install bash`; the scripts use `#!/usr/bin/env bash`),
  `gh`, `node`.
- An ssh alias for the devbox's admin account, `devbox-admin` by default
  (`FORK_DEVBOX_SSH`), with passwordless `sudo` there. The repo checkout, the
  build directory and the editors' server installs belong to `paseo`
  (`FORK_DEVBOX_USER`), at `/home/paseo/projects/paseo` (`FORK_DEVBOX_REPO`)
  and `/home/paseo/.paseo-fork` (`FORK_DEVBOX_WORK_ROOT`); the daemon is the
  `paseo` unit under `/usr` (`FORK_DEVBOX_SERVICE`, `FORK_DEVBOX_NPM_PREFIX`).
- For `ios`, the key that opens `fork/.env.fork` — see
  [EXPO_TOKEN](#expo_token).

### The daemon, by hand

The devbox runs the daemon from a global npm install driven by the `paseo`
systemd unit. It cannot be updated from inside a Paseo agent — `/usr` and
`/etc` are read-only there and there is no root — and restarting the service
would kill the agent doing it. This is what the `daemon` target runs, from
the laptop:

```bash
ssh devbox-admin "sudo npm install -g --prefix /usr --allow-scripts=esbuild,node-pty \
  /home/paseo/.paseo-fork/dist/getpaseo-{highlight,relay,protocol,client,plugin,server,cli}-0.7.2-panrafal.2.tgz \
  && sudo systemctl restart paseo && sleep 8 && sudo devbox-healthcheck"
```

The package order is dependency-first — npm has to see a package on disk
before the one that requires it. `systemctl restart` returns as soon as the
unit is started, not when the daemon is serving, which is what the pause
before the healthcheck is for. `--allow-scripts` is needed because npm blocks
install scripts by default; without it esbuild and node-pty install
unconfigured. `~/.paseo-fork` is under a home the admin account cannot read,
so the tarballs are read by `sudo`.

## macOS

`fork/build.sh desktop` tags the current `main` as `fork-v<version>` and
pushes the branch and the tag, starting **Fork Desktop**
(`.github/workflows/fork-desktop.yml`, on `fork-base`). It builds arm64 and x64 on macOS runners, signs with your
Developer ID certificate, skips notarization, and publishes a release on your
fork.

Signing runs on a GitHub runner, so these live as repo secrets on the fork:

| Secret                       | Where it comes from                            |
| ---------------------------- | ---------------------------------------------- |
| `APPLE_CERTIFICATE`          | base64 of your Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password                     |

Store the certificate as base64 without line breaks:

```bash
base64 < DeveloperIDApplication.p12 | tr -d '\n' | \
  gh secret set APPLE_CERTIFICATE --repo panrafal/paseo
gh secret set APPLE_CERTIFICATE_PASSWORD --repo panrafal/paseo
```

The workflow passes `mac.notarize=false`, so it needs no App Store Connect key,
Apple ID, app-specific password or Apple team ID. `FORK_APPLE_TEAM_ID` remains
in `fork/dist.env` because iOS still needs it.

These are the only fork values GitHub holds. The rest are the plain identifiers
in `fork/dist.env`, committed as they are, and `EXPO_TOKEN`, which a script on
your own machine needs — see [iOS / TestFlight](#ios--testflight).

On the Mac, `fork/update-macos.sh [fork-v<version>]` downloads that build
(the newest without an argument), quits a running Paseo, installs it, clears
the quarantine flag required for the non-notarized build, restarts the local
daemon through the installed app's bundled CLI, and relaunches Paseo. Running
it again for the installed version still restarts the daemon.
Fetch and run it in one line:

```bash
gh api repos/panrafal/paseo/contents/fork/update-macos.sh?ref=main \
  -H 'Accept: application/vnd.github.raw' | bash
```

After the first install the app updates itself. Fork builds carry a prerelease
version (`0.7.2-panrafal.1`), so the app has to be on the `beta` update channel
— it reads that from its own settings, not from the version string — and
`fork-base` points that channel's feed at your fork.

## VS Code and Cursor

`fork/build.sh vscode` exports the web app, packages the extension and leaves
`paseo-vscode-<version>.vsix` in `~/.paseo-fork/dist`.

The extension is `extensionKind: ["workspace"]`: in a Remote-SSH window it
runs on the devbox, next to the daemon, and an install on the laptop alone
does not reach those windows. So the `vscode` deploy target installs it four
times: into `code` and `cursor` on the laptop, and into the VS Code Server and
Cursor Server on the devbox, by copying the `.vsix` and
`fork/install-vscode-remote.sh` there and running the installer as
`FORK_DEVBOX_EDITOR_USER`, because the servers' extensions live in that
account's home. An editor that is not on the laptop's PATH, or one of the two
servers that has never connected to the devbox, is reported as skipped; a
devbox with neither server fails the target, with the installer's output in
the job log. Reload open remote windows to pick the new build up.

## iOS / TestFlight

The fork ships under its own bundle identifier, EAS project and App Store
Connect record — `sh.paseo` belongs to upstream's app record and cannot be
reused.

### One-time setup

Create the EAS project on [expo.dev](https://expo.dev) first, with the slug
`panrafal-paseo`. It has to match `expo.slug` in `packages/app/app.config.js`;
`eas` refuses a project whose slug disagrees. Then, in the build checkout:

```bash
cd ~/.paseo-fork/build/packages/app
npx eas login
npx eas init --id=<project id>   # link the project you just made
npx eas credentials -p ios       # registers the bundle id, then creates the
                                 # distribution certificate and provisioning
                                 # profile, and stores an App Store Connect
                                 # API key so `submit` needs no password
```

If `npx eas` installs a package called `eas` and then reports no binary, your
`npx` is resolving against the registry instead of the checkout. Run
`~/.paseo-fork/build/node_modules/.bin/eas` directly; `fork/ios.sh` already
prefers it.

Then fill `FORK_IOS_BUNDLE_ID`, `FORK_EAS_OWNER`, `FORK_EAS_PROJECT_ID`,
`FORK_ASC_APP_ID` and `FORK_APPLE_TEAM_ID` into `fork/dist.env` on
`fork-base` and commit. `fork/ios.sh doctor` checks them without building.

`app.config.js` on `fork-base` reads the identity from `APP_PACKAGE_ID`,
`EAS_PROJECT_ID` and `EAS_OWNER`, and the config is evaluated twice: by the
`eas` CLI here, and again by the EAS worker on the build machine. `fork/ios.sh`
sets the variables for the first and writes them into the `production` build
profile's `env` in the build checkout's `eas.json` for the second. Without
the second the worker sees upstream's project id and refuses the build as
belonging to another project.

### EXPO_TOKEN

`eas build` and `eas submit` run `--non-interactive`, which needs an access
token from [expo.dev/settings/access-tokens](https://expo.dev/settings/access-tokens).
Nothing in Actions builds the iOS app; `fork/ios.sh` does it here. So the token
is committed to `fork-base` encrypted with [dotenvx](https://dotenvx.com)
rather than kept in GitHub secrets:

```bash
dotenvx set EXPO_TOKEN '<token>' -f fork/.env.fork   # from the repo root
git add fork/.env.fork && git commit -m 'fork: expo token'
```

That writes two files. `fork/.env.fork` holds the ciphertext and the public
key and is committed. `.env.keys` holds the private key, lands in the
directory you ran the command from, and is gitignored everywhere — back it up
in your password manager, because nothing else has a copy.

`fork/ios.sh` re-execs itself under `dotenvx run` to get the token into
`eas`, so it works the same from a terminal, from `fork/build.sh ios` and from
`fork/deploy.sh`. It looks for the key in `fork/.env.keys`, the repo root,
and `~/.paseo-fork/.env.keys`, or in a `DOTENV_PRIVATE_KEY_FORK` environment
variable. Only the last two survive a git worktree, which gets no copy of a
gitignored file — put the key in `~/.paseo-fork/.env.keys` and every checkout
on the machine finds it.

Without `fork/.env.fork` nothing breaks; `eas` falls back to the interactive
login in `~/.expo` and the scripts warn once. With the file but no key they
stop, rather than handing `eas` the ciphertext.

### Push notifications

They need your own Firebase `GoogleService-Info.plist`. `packages/app` reads
the path from `GOOGLE_SERVICE_INFO_PLIST_PROD` and falls back to
`packages/app/.secrets/GoogleService-Info.prod.plist`, but that fallback is
local-only: `.secrets/` is gitignored and EAS does not upload gitignored files
to its build workers. For an EAS build, make it a file-type environment
variable instead, which EAS writes to a path on the worker and points the
variable at:

```bash
cd ~/.paseo-fork/build/packages/app
npx eas env:create production --name GOOGLE_SERVICE_INFO_PLIST_PROD \
  --type file --value ./GoogleService-Info.plist \
  --visibility secret --scope project
```

Everything else works without it.

## GitHub Actions on the fork

`fork-base` moves every upstream workflow into
`.github/workflows/disabled/`. GitHub only reads `.github/workflows/*.yml` and
does not recurse, so nothing there can trigger — which is what lets `main` be
the published integration at all, since `ci.yml` fires on
`push: branches: [main]` and force-pushes land there on every run. The files
are unchanged and still runnable by hand: point the Actions tab at a branch
that has them at the top level, or copy one back temporarily. Fork Desktop
triggers on its own, on `fork-v*` tags. Patch branches can bring workflows of
their own: `vscode` adds `vscode.yml`, which runs on every push to `main`, so
each `--push` also costs a VS Code Extension CI run.

Tags are the gap. A tag-triggered workflow resolves its file from the tagged
commit, not from `main`, so pushing an upstream `v*` tag to this fork would
start `deploy-app`, `desktop-release` and `android-apk-release` from upstream's
enabled copies. Never push upstream tags to `origin` — plain `git push` does
not, so just avoid `--tags` and `--follow-tags`.

## Commit hooks

Upstream's `lefthook.yml` runs the formatter, the linter and the whole-repo
typecheck on every commit, which needs `node_modules` and built declarations
in the checkout and takes about twenty seconds. `fork-base` sets the
pre-commit hook to `skip: true`, so commits on `fork-base` and on anything
derived from `main` pass straight through. A patch branch is cut from
`upstream/main`, does not have that change, and keeps the hooks: it is a PR,
and gets the checks upstream expects. `LEFTHOOK=0` in the environment turns
the hook off anywhere; the installed hook script checks it before it looks
for node.

## A new machine

```bash
git clone https://github.com/panrafal/paseo.git && cd paseo
git remote add upstream https://github.com/getpaseo/paseo.git
git fetch origin fork-base:fork-base
fork/integrate.sh rebase --push
```

The first `rebase` starts the local `fork-integration` from
`origin/fork-integration`. A clone that has only `main` — the published
copy is gone — rebuilds the integration's ancestry from `main`'s commit
message, which names every branch tip that went in.
