# The `panrafal` fork

This fork's `main` is an integration branch: the latest `getpaseo/paseo` `main`
with my own patches merged on top. It is what I build and run. It is not a
branch I commit to — every sync throws the old one away and rebuilds it, so
anything committed directly to it is lost.

`main` is deliberately not a mirror of upstream. Cloning the fork should give
you the build I actually use, and upstream's workflows only fire on a branch
literally called `main` (`ci.yml` is `push: branches: [main]`), so mirroring
upstream into it burned a full CI run on every sync. `panrafal-base` moves
those workflows into `.github/workflows/disabled/`, which GitHub does not read,
and `main` carries that move. Upstream's `main` is `upstream/main`; there is no
fork-side copy of it and nothing needs one.

## Branches

| Branch          | Base            | Purpose                                                          |
| --------------- | --------------- | ---------------------------------------------------------------- |
| `panrafal-base` | `upstream/main` | Everything fork-only: this directory, and the repo changes the fork needs — own update feed and app identifiers, upstream workflows disabled, `panrafal:` scripts in `paseo.json`. |
| PR branches     | `upstream/main` | One per change, sent upstream as a pull request.                  |
| `main`          | rebuilt         | `upstream/main` + `panrafal-base` + PR branches. Force-pushed.    |

Everything except `main` is based on `upstream/main`, including
`panrafal-base`. Start one with `fork/new-branch.sh <name>` rather than
`git switch -c`: `main` is the branch your fingers reach for, and a branch cut
from it carries the whole patch stack. `fork/sync.sh` refuses such a branch —
it spots the integration merge commits — but only once the mistake is made.

## The quick route

Four `panrafal:` scripts in `paseo.json`, one tap each in the Paseo UI:

| Script                    | Runs                              | Ends with                                   |
| ------------------------- | --------------------------------- | ------------------------------------------- |
| `panrafal: sync`          | `fork/sync.sh --rebase --agent --push` | the rebuilt branch, pushed             |
| `panrafal: build daemon`  | `fork/build.sh daemon`            | an `ssh devbox-admin …` command to paste    |
| `panrafal: build desktop` | `fork/build.sh desktop`           | a command to paste on the Mac               |
| `panrafal: build ios`     | `fork/build.sh ios`               | a TestFlight link                           |

Each build command prints the follow-up command and pushes it to your
terminal's clipboard over OSC 52, so it can usually be pasted straight into a
local terminal without selecting it.

Building never runs anything. It produces artifacts and tells you how to
install them; starting a daemon, installing a launcher and writing a config
are all your call, not the build's.

## Syncing

`fork/sync.sh --rebase --agent --push` is the whole loop in one go:

1. Fetch upstream and the fork.
2. Rebase every patch branch in `fork/branches` onto current `upstream/main`,
   handing conflicts to a Paseo agent, and force-push each one. This keeps the
   PRs mergeable.
3. Rebuild `main` from `upstream/main` by merging `panrafal-base` and every
   rebased patch branch, again handing conflicts to an agent.
4. Force-push `main`.

Run it from any worktree; it works in a scratch worktree under
`~/.paseo-fork/sync`, so your checkout is untouched even mid-conflict. Drop
`--agent` to stop on conflicts instead, `--push` to keep everything local.

Because the branch is rebuilt rather than advanced, publishing is a
force-push. Anywhere you consume it, re-sync with a reset, not a pull:

```bash
git fetch origin && git reset --hard origin/main
```

### Adding a change

Every change to Paseo itself is its own branch off `upstream/main`, never a
commit on `main`. That is what keeps it sendable upstream and what lets the
integration branch be thrown away and rebuilt.

```bash
fork/new-branch.sh my-change
# ...work, commit...
git push -u origin my-change
```

`fork/new-branch.sh` exists because `main` is the wrong base and is also the
one your fingers type. It fetches upstream and branches off `upstream/main`.

Then add `origin/my-change` to `fork/branches` on `panrafal-base`, commit, and
sync. It is in every build from then on, and `gh pr create` sends the same
branch upstream whenever you want it reviewed.

Anything fork-only — how the fork builds, ships, or syncs itself — goes on
`panrafal-base` instead. None of it would be accepted upstream, and it is the
one branch that is allowed to know it is a fork.

### Changing what gets merged

Edit `fork/branches` on `panrafal-base`, commit, then sync. The list
is read from the `panrafal-base` ref, not from your working tree, so an
uncommitted edit has no effect. That is deliberate: the list travels with the
repo.

When a PR lands upstream, delete its line and sync. The commits arrive through
`upstream/main` instead. Do not try to unmerge anything.

### Conflicts

`rerere` is enabled, so a resolution — yours or the agent's — is replayed on
later syncs rather than re-derived. The agent is told to keep both sides'
intent and never to drop an upstream change to make a patch apply. Set
`FORK_AGENT_PROVIDER` to pick the provider.

Rebasing is free here: `main` is rebuilt from the branches every time and
never remembers their old shape.

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

`fork/build-number` on `panrafal-base` holds both halves, `0.7.2 7`, because
the counter restarts at 1 whenever the upstream version moves. Storing the
version it counts for is what makes the restart detectable — a bare integer
cannot tell "first build of 0.7.3" from "someone reset the file".
`fork/sync.sh` bumps it once per run, after the rebase and before anything is
merged, so it is committed into the `main` commit it identifies.

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

`fork/build.sh daemon` stamps the version after `npm install` (so the install
still resolves against the committed lockfile) and before `npm pack` (so the
tarballs and their `@getpaseo/*` cross-dependency ranges all carry it), using
the repo's own `scripts/sync-workspace-versions.mjs`.

## Updating the devbox daemon

The devbox runs the daemon from a global npm install driven by the `paseo`
systemd unit. It cannot be updated from inside a Paseo agent — `/usr` and
`/etc` are read-only there and there is no root — and restarting the service
would kill the agent doing it. So the build only packs tarballs into
`~/.paseo-fork/dist`, and you run the install from your laptop:

```bash
ssh devbox-admin "sudo npm install -g --prefix /usr --allow-scripts=esbuild,node-pty \
  /home/paseo/.paseo-fork/dist/getpaseo-{highlight,relay,protocol,client,plugin,server,cli}-0.7.2-panrafal.2.tgz \
  && sudo systemctl restart paseo && sleep 8 && sudo devbox-healthcheck"
```

`fork/build.sh daemon` prints that line with the current version filled in.
Override the pieces with `FORK_DEVBOX_SSH`, `FORK_DEVBOX_NPM_PREFIX`,
`FORK_DEVBOX_SERVICE`, `FORK_DEVBOX_SETTLE` and `FORK_DEVBOX_HEALTHCHECK`.

The brace expansion runs in `devbox-admin`'s login shell, so that account needs
bash or zsh; under dash npm would receive a literal path with braces in it. The
package order is dependency-first — npm has to see a package on disk before the
one that requires it.

`systemctl restart` returns as soon as the unit is started, not when the daemon
is serving, which is what the pause before the healthcheck is for.

`--allow-scripts` is needed because npm blocks install scripts by default;
without it esbuild and node-pty install unconfigured.

## macOS

`fork/build.sh desktop` tags the current `main` as `fork-v<version>` and
pushes it, starting **Fork Desktop** (`.github/workflows/fork-desktop.yml`, on
`panrafal-base`). It builds arm64 and x64 on macOS runners, signs and notarizes
with your Apple credentials, and publishes a release on your fork.

Repo secrets required on the fork:

| Secret                       | Where it comes from                            |
| ---------------------------- | ----------------------------------------------- |
| `APPLE_CERTIFICATE`          | base64 of your Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password                     |
| `APPLE_ID`                   | your Apple ID email                            |
| `APPLE_PASSWORD`             | an app-specific password for notarization      |
| `APPLE_TEAM_ID`              | Apple Developer team id                        |

On the Mac, `fork/update-macos.sh` downloads the newest fork build, quits a
running Paseo, installs it and relaunches. Fetch and run it in one line:

```bash
gh api repos/panrafal/paseo/contents/fork/update-macos.sh?ref=panrafal \
  -H 'Accept: application/vnd.github.raw' | bash
```

After the first install the app updates itself. Fork builds carry a prerelease
version (`0.7.2-panrafal.1`), so the app has to be on the `beta` update channel
— it reads that from its own settings, not from the version string — and
`panrafal-base` points that channel's feed at your fork.

## iOS / TestFlight

The fork ships under its own bundle identifier, EAS project and App Store
Connect record — `sh.paseo` belongs to upstream's app record and cannot be
reused.

One-time setup:

```bash
cd ~/.paseo-fork/build/packages/app
npx eas login
npx eas init --id        # creates the fork's EAS project
npx eas credentials      # let EAS manage iOS signing
```

Then fill `FORK_IOS_BUNDLE_ID`, `FORK_EAS_OWNER`, `FORK_EAS_PROJECT_ID`,
`FORK_ASC_APP_ID` and `FORK_APPLE_TEAM_ID` into `fork/dist.env` on
`panrafal-base` and commit. `fork/ios.sh doctor` checks them without building.

Push notifications need your own Firebase `GoogleService-Info.plist` at
`packages/app/.secrets/` or via `GOOGLE_SERVICE_INFO_PLIST_PROD`. Everything
else works without it.

## GitHub Actions on the fork

`panrafal-base` moves every upstream workflow into
`.github/workflows/disabled/`. GitHub only reads `.github/workflows/*.yml` and
does not recurse, so nothing there can trigger — which is what lets `main` be
the integration branch at all, since `ci.yml` fires on `push: branches: [main]`
and force-pushes land there constantly. The files are unchanged and still
runnable by hand: point the Actions tab at a branch that has them at the top
level, or copy one back temporarily. Fork Desktop is the one workflow that
triggers on its own, on `fork-v*` tags.

Tags are the gap. A tag-triggered workflow resolves its file from the tagged
commit, not from `main`, so pushing an upstream `v*` tag to this fork would
start `deploy-app`, `desktop-release` and `android-apk-release` from upstream's
enabled copies. Never push upstream tags to `origin` — plain `git push` does
not, so just avoid `--tags` and `--follow-tags`.

## A new machine

```bash
git clone https://github.com/panrafal/paseo.git && cd paseo
git remote add upstream https://github.com/getpaseo/paseo.git
git fetch upstream main
git fetch origin panrafal-base:panrafal-base
git show panrafal-base:fork/sync.sh | bash -s -- --push
```
