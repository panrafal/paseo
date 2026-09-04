# The `panrafal` fork

This fork's `main` is an integration branch: the latest `getpaseo/paseo` `main`
with my own patches merged on top. It is what I build and run. It is not a
branch I commit to — every sync throws the old one away and rebuilds it, so
anything committed directly to it is lost.

`main` is deliberately not a mirror of upstream. Cloning the fork should give
you the build I actually use, and upstream's workflows only fire on a branch
literally called `main` (`ci.yml` is `push: branches: [main]`), so mirroring
upstream into it burned a full CI run on every sync. `fork-base` moves
those workflows into `.github/workflows/disabled/`, which GitHub does not read,
and `main` carries that move. Upstream's `main` is `upstream/main`; there is no
fork-side copy of it and nothing needs one.

## Branches

| Branch      | Base            | Purpose                                                                                                                                                                            |
| ----------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fork-base` | `upstream/main` | Everything fork-only: this directory, and the repo changes the fork needs — own update feed and app identifiers, upstream workflows disabled, `panrafal:` scripts in `paseo.json`. |
| PR branches | `upstream/main` | One per change, sent upstream as a pull request.                                                                                                                                   |
| `main`      | rebuilt         | `upstream/main` + `fork-base` + PR branches. Force-pushed.                                                                                                                         |

Everything except `main` is based on `upstream/main`, including
`fork-base`. Start one with `fork/new-branch.sh <name>` rather than
`git switch -c`: `main` is the branch your fingers reach for, and a branch cut
from it carries the whole patch stack. `fork/sync.sh` refuses such a branch —
it spots the integration merge commits — but only once the mistake is made.

## The quick route

Six `panrafal:` scripts in `paseo.json`, one tap each in the Paseo UI:

| Script                    | Runs                                   | Ends with                                |
| ------------------------- | -------------------------------------- | ---------------------------------------- |
| `panrafal: sync`          | `fork/sync.sh --rebase --agent --push` | the rebuilt branch, pushed               |
| `panrafal: build daemon`  | `fork/build.sh daemon`                 | an `ssh devbox-admin …` command to paste |
| `panrafal: build desktop` | `fork/build.sh desktop`                | a command to paste on the Mac            |
| `panrafal: build vscode`  | `fork/build.sh vscode`                 | a command to paste on the laptop         |
| `panrafal: build ios`     | `fork/build.sh ios`                    | a TestFlight link                        |
| `panrafal: build ALL`     | `fork/build.sh all`                    | one command that installs all of it      |

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
3. Rebuild `main` from `upstream/main` by merging `fork-base` and every
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

Then add `origin/my-change` to `fork/branches` on `fork-base`, commit, and
sync. It is in every build from then on, and `gh pr create` sends the same
branch upstream whenever you want it reviewed.

Anything fork-only — how the fork builds, ships, or syncs itself — goes on
`fork-base` instead. None of it would be accepted upstream, and it is the
one branch that is allowed to know it is a fork.

### Changing what gets merged

Edit `fork/branches` on `fork-base`, commit, then sync. The list
is read from the `fork-base` ref, not from your working tree, so an
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

`fork/build-number` on `fork-base` holds both halves, `0.7.2 7`, because
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
`fork-base`). It builds arm64 and x64 on macOS runners, signs with your
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

On the Mac, `fork/update-macos.sh` downloads the newest fork build, quits a
running Paseo, installs it, clears the quarantine flag required for the
non-notarized build, and relaunches it. Fetch and run it in one line:

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
`paseo-vscode-<version>.vsix` in `~/.paseo-fork/dist`. `packages/vscode` comes
from the `vscode` patch branch, so a `main` built without it has nothing to
package: the build warns and exits 0, so `all` can run the step
unconditionally.

The extension is `extensionKind: ["workspace"]`: in a Remote-SSH window it
runs on the devbox, next to the daemon, and an install on the laptop alone
does not reach those windows. The printed command does both halves. It fetches
the `.vsix` over `sudo cat` rather than `scp` because `~/.paseo-fork` is
under a home the admin account cannot read, parks it at
`/tmp/paseo-vscode-<version>.vsix`, and installs it into whichever of `code`
and `cursor` are on the laptop's PATH — with neither there it installs
nothing and says nothing, so use Install from VSIX… in the Extensions view.
The devbox half runs `install-vscode-remote.sh`, shipped next to the `.vsix`,
as `FORK_DEVBOX_EDITOR_USER` (default: whoever ran the build) because the
servers' extensions live in that account's home. It needs no root and no
laptop; the build also prints the form to run from a terminal here. Reload
open remote windows to pick the new build up.

## iOS / TestFlight

The fork ships under its own bundle identifier, EAS project and App Store
Connect record — `sh.paseo` belongs to upstream's app record and cannot be
reused.

### One-time setup

Create the EAS project on [expo.dev](https://expo.dev) first, with the slug
`voice-mobile`. It has to match `expo.slug` in `packages/app/app.config.js`;
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
`fork/build.sh all`. It looks for the key in `fork/.env.keys`, the repo root,
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

## Everything at once

`fork/build.sh all` runs the daemon, desktop, VS Code and iOS builds in turn
and ends with their install commands folded into one `&&` chain, copied to
the clipboard like the individual ones. The chain installs the daemon last:
its restart drops every agent on the devbox, including the one you pasted
from. An earlier link failing stops the chain before the daemon, so if it dies
part-way, re-run the daemon command on its own — `all` prints it separately
too.

The desktop step waits for the Fork Desktop workflow, so the chain is runnable
the moment it is printed; a red run drops that step from the chain and the
rest goes on. `vscode` is skipped without `packages/vscode`, `ios` while
`fork/dist.env` still holds `REPLACE_ME` placeholders. Any other failure
stops the run.

## GitHub Actions on the fork

`fork-base` moves every upstream workflow into
`.github/workflows/disabled/`. GitHub only reads `.github/workflows/*.yml` and
does not recurse, so nothing there can trigger — which is what lets `main` be
the integration branch at all, since `ci.yml` fires on `push: branches: [main]`
and force-pushes land there constantly. The files are unchanged and still
runnable by hand: point the Actions tab at a branch that has them at the top
level, or copy one back temporarily. Fork Desktop triggers on its own, on
`fork-v*` tags. Patch branches can bring workflows of their own: `vscode` adds
`vscode.yml`, which runs on every push to `main`, so each `--push` sync also
costs a VS Code Extension CI run.

Tags are the gap. A tag-triggered workflow resolves its file from the tagged
commit, not from `main`, so pushing an upstream `v*` tag to this fork would
start `deploy-app`, `desktop-release` and `android-apk-release` from upstream's
enabled copies. Never push upstream tags to `origin` — plain `git push` does
not, so just avoid `--tags` and `--follow-tags`.

## A new machine

```bash
git clone https://github.com/panrafal/paseo.git && cd paseo
git remote add upstream https://github.com/getpaseo/paseo.git
git fetch origin fork-base:fork-base
fork/sync.sh --push
```
