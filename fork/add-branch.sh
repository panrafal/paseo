#!/usr/bin/env bash
#
# fork/add-branch.sh — put a branch into every build.
#
#   fork/add-branch.sh my-change [--agent] [--push]
#
# The same as `fork/integrate.sh add my-change`: lists the branch in
# fork/branches on fork-base and merges it into fork-integration, without
# rebuilding anything else. See fork/integrate.sh.

exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/integrate.sh" add "$@"
