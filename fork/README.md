# The `panrafal` fork

`panrafal` is an integration branch: the latest `getpaseo/paseo` `main` with my
own patches merged on top. It is what I build and run. It is not a branch I
commit to — every sync throws the old one away and rebuilds it, so anything
committed directly to it is lost.

## Branches

| Branch                | Base            | Purpose                                                         |
| --------------------- | --------------- | --------------------------------------------------------------- |
| `fork-tooling`        | `upstream/main` | This directory: the branch list and the scripts. No repo code.  |
| `fork-dist`           | `upstream/main` | The repo changes that let the fork publish under its own identity. |
| PR branches           | `upstream/main` | One per change, sent upstream as a pull request.                |
| `panrafal`            | rebuilt         | `upstream/main` + `fork-tooling` + `fork-dist` + the PR branches. |

## Scripts

| Command                   | What it does                                                        |
| ------------------------- | -------------------------------------------------------------------- |
| `fork/sync.sh`            | Rebuild `panrafal` from upstream + `fork/branches`.                 |
| `fork/build.sh restart`   | Build the fork and run it as a second daemon on this machine.       |
| `fork/release.sh desktop` | Tag a fork build; GitHub Actions builds the signed macOS app.       |
| `fork/update-macos.sh`    | Run on the Mac: install the newest fork build.                      |
| `fork/ios.sh ship`        | EAS build + TestFlight submit.                                      |

Settings live in `fork/config.sh`; fork identity lives in `fork/dist.env`.

## Syncing

```bash
fork/sync.sh                  # rebuild locally, print the push command
fork/sync.sh --push           # rebuild and force-push to origin/panrafal
fork/sync.sh --rebase --agent # rebase the patch branches onto upstream too,
                              # and hand conflicts to a Paseo agent
```

Run it from any worktree. It builds in a scratch worktree under
`~/.paseo-fork/sync`, so your checkout is untouched even when a merge
conflicts.

Because the branch is rebuilt rather than advanced, publishing is a
force-push. Anywhere you consume it, re-sync with a reset, not a pull:

```bash
git fetch origin && git reset --hard origin/panrafal
```

### Changing what gets merged

Edit `fork/branches` on the `fork-tooling` branch, commit, then sync. The list
is read from the `fork-tooling` ref, not from your working tree, so an
uncommitted edit has no effect. That is deliberate: the list travels with the
repo.

### Conflicts

`rerere` is enabled. The first time upstream collides with one of your patches
you resolve it once; every later sync replays that resolution automatically.

`--agent` hands a stopped merge or rebase to a Paseo agent in the scratch
worktree, with instructions to keep both sides' intent and never drop an
upstream change to make a patch apply. The agent's resolution is recorded by
rerere like any other, so it is replayed rather than re-derived. Set
`FORK_AGENT_PROVIDER` to pick the provider.

`--rebase` moves the patch branches themselves onto current upstream before
merging. That keeps their PRs mergeable and makes the integration merges
trivial; it rewrites those branches, so push them with `--force-with-lease`
afterwards. Rebasing is free here — `panrafal` is rebuilt from the branches
every time and never remembers their old shape.

### When a PR lands upstream

Delete its line from `fork/branches` and sync. The commits arrive through
`upstream/main` instead. Do not try to unmerge anything.

## Running the fork on this devbox

The devbox daemon cannot be replaced: it is a system `paseo.service` pointing
at `/usr/lib/node_modules/@getpaseo/cli`, and both `/usr` and `/etc` are
read-only with no root available. Replacing it would also kill any agent
running the replacement.

So the fork runs **side by side** — its own `PASEO_HOME`, its own port, started
by `fork/build.sh` rather than systemd:

```bash
fork/build.sh restart     # build + install launcher + restart the fork daemon
fork/build.sh status      # what is built, what is running, on which port
paseo-fork ls             # the launcher talks to the fork daemon
```

Defaults: home `~/.paseo-fork/home`, listening on `127.0.0.1:6866`, launcher at
`~/.local/bin/paseo-fork`. Override with `FORK_PASEO_HOME`,
`FORK_PASEO_LISTEN`, `FORK_BIN_DIR`.

The build checkout at `~/.paseo-fork/build` is persistent so `node_modules`
survives between builds. It is a detached worktree, so `fork/sync.sh` can move
`panrafal` underneath it freely.

## macOS

`fork/release.sh desktop` tags the current `panrafal` as `fork-v<version>` and
pushes it, which starts **Fork Desktop** (`.github/workflows/fork-desktop.yml`,
on the `fork-dist` branch). It builds arm64 and x64 on macOS runners, signs and
notarizes with your Apple credentials, and publishes to a release on
`panrafal/paseo`.

Repo secrets required on `panrafal/paseo`:

| Secret                       | Where it comes from                                     |
| ---------------------------- | -------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | base64 of your Developer ID Application `.p12`          |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password                              |
| `APPLE_ID`                   | your Apple ID email                                     |
| `APPLE_PASSWORD`             | an app-specific password for notarization               |
| `APPLE_TEAM_ID`              | Apple Developer team id                                 |

On the laptop, `fork/update-macos.sh` downloads and installs the newest fork
build. After the first install the app updates itself: fork builds carry a
prerelease version (`0.7.2-panrafal.1`), which puts the app on the `beta`
update channel, and the `fork-dist` branch points that channel's feed at your
fork instead of upstream.

## iOS / TestFlight

The fork ships under its own bundle identifier, EAS project and App Store
Connect record — reusing `sh.paseo` is not possible, that identifier belongs to
upstream's app record.

One-time setup:

```bash
fork/build.sh build                       # get a build checkout
cd ~/.paseo-fork/build/packages/app
npx eas login
npx eas init --id                         # creates the fork's EAS project
npx eas credentials                       # let EAS manage iOS signing
```

Then fill `FORK_IOS_BUNDLE_ID`, `FORK_EAS_OWNER`, `FORK_EAS_PROJECT_ID`,
`FORK_ASC_APP_ID` and `FORK_APPLE_TEAM_ID` into `fork/dist.env` on the
`fork-tooling` branch and commit. `fork/ios.sh doctor` checks them without
building.

```bash
fork/ios.sh ship        # eas build --platform ios, then submit to TestFlight
```

Push notifications will not work on a fork build unless you add your own
Firebase `GoogleService-Info.plist` — `app.config.js` looks for it at
`packages/app/.secrets/` or via `GOOGLE_SERVICE_INFO_PLIST_PROD`. Everything
else works without it.

## A new machine

```bash
git clone https://github.com/panrafal/paseo.git && cd paseo
git remote add upstream https://github.com/getpaseo/paseo.git
git fetch upstream main
git fetch origin fork-tooling:fork-tooling
git show fork-tooling:fork/sync.sh | bash -s -- --push
```
