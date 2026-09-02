# The `panrafal` fork

`panrafal` is an integration branch: the latest `getpaseo/paseo` `main` with my
own patches merged on top. It is what I build and run. It is not a branch I
commit to.

## The three kinds of branch

| Branch                | Base            | Purpose                                                     |
| --------------------- | --------------- | ----------------------------------------------------------- |
| `fork-tooling`        | `upstream/main` | This directory. The branch list and the sync script.        |
| feature branches      | `upstream/main` | One per change. These are the PR heads sent upstream.       |
| `panrafal`            | rebuilt         | `upstream/main` + `fork-tooling` + every feature branch.    |

Work happens on feature branches. `panrafal` is generated output — every sync
throws the old one away and rebuilds it, so anything committed directly to it
is lost.

## Syncing

```bash
fork/sync.sh          # rebuild locally, print the push command
fork/sync.sh --push   # rebuild and force-push to origin/panrafal
```

Run it from any worktree. It builds in a scratch worktree under `.git/`, so
your checkout is untouched even when a merge conflicts.

Because the branch is rebuilt rather than advanced, publishing is a
force-push. Anywhere you consume it, re-sync with a reset, not a pull:

```bash
git fetch origin && git reset --hard origin/panrafal
```

## Changing what gets merged

Edit `fork/branches` on the `fork-tooling` branch, commit, then sync:

```bash
git -C <a worktree on fork-tooling> ...   # or: git worktree add ../tooling fork-tooling
$EDITOR fork/branches
git commit -am "fork: add <branch>"
fork/sync.sh
```

The list is read from the `fork-tooling` ref, not from your working tree, so
an uncommitted edit has no effect. That is deliberate: the list travels with
the repo.

## Conflicts

`rerere` is enabled. The first time upstream collides with one of your
patches you resolve it by hand in the build worktree; every later sync
replays that resolution automatically. A resolution goes stale only when the
conflicting hunk itself changes.

Conflicts are also a signal: if a feature branch keeps fighting upstream,
rebase that branch onto current `upstream/main` and update its PR. Rebasing
feature branches is free here — `panrafal` is rebuilt from them each time and
never remembers the old shape.

## When a PR lands upstream

Delete its line from `fork/branches` and sync. The commits arrive through
`upstream/main` instead. Do not try to unmerge anything.

## Starting from scratch on a new machine

```bash
git clone https://github.com/panrafal/paseo.git
cd paseo
git remote add upstream https://github.com/getpaseo/paseo.git
git fetch upstream main
git fetch origin fork-tooling:fork-tooling
git show fork-tooling:fork/sync.sh | bash -s -- --push
```
