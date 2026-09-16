#!/usr/bin/env bash
#
# fork/wait-for-agents.sh — wait until no agent on a daemon is working.
#
#   fork/wait-for-agents.sh [paseo-binary] [where]
#
# Polls `paseo ls -g --json` until every agent is idle, errored or closed, so
# a restart does not kill one mid-turn. `where` only names the daemon in the
# output. The agent this runs inside, if any ($PASEO_AGENT_ID), is not waited
# for.
#
# It is standalone: fork/deploy.sh pipes it to the devbox, and
# fork/update-macos.sh fetches it when run without a checkout.
#
#   FORK_SKIP_AGENT_WAIT=1         do not wait
#   FORK_AGENT_WAIT_INTERVAL=15    seconds between checks
#
# A daemon that cannot be listed has no agents to lose, so that is a warning
# and no wait.

set -euo pipefail

paseo="${1:-paseo}"
where="${2:-this machine}"
interval="${FORK_AGENT_WAIT_INTERVAL:-15}"

if [ "${FORK_SKIP_AGENT_WAIT:-0}" = 1 ]; then
  echo "FORK_SKIP_AGENT_WAIT=1: not waiting for agents on $where"
  exit 0
fi

# The JSON is pretty-printed with the agent's own fields at four spaces, which
# keeps a label called "status" from matching. Prints "<shortId> <status>
# <name>" for every agent still working.
busy_agents() {
  awk -v self="${PASEO_AGENT_ID:-}" '
    function value(line) {
      sub(/^    "[a-zA-Z]+": "/, "", line)
      sub(/",?$/, "", line)
      return line
    }
    /^  \{/ { id = ""; short = ""; name = ""; status = "" }
    /^    "id": "/ { id = value($0) }
    /^    "shortId": "/ { short = value($0) }
    /^    "name": "/ { name = value($0) }
    /^    "status": "/ { status = value($0) }
    /^  \}/ {
      if ((status == "running" || status == "initializing") && id != self)
        printf "%s %s %s\n", short, status, name
    }
  '
}

last=""
waited=0
while :; do
  if ! out="$("$paseo" ls -g --json 2>&1)"; then
    echo "warning: cannot list agents on $where, not waiting: $out" >&2
    exit 0
  fi
  busy="$(busy_agents <<<"$out")"
  if [ -z "$busy" ]; then
    if [ "$waited" -eq 1 ]; then
      echo "All agents on $where are idle."
    else
      echo "No agents running on $where."
    fi
    exit 0
  fi
  if [ "$busy" != "$last" ]; then
    echo "Waiting for $(wc -l <<<"$busy" | tr -d ' ') agent(s) on $where to go idle or error out ($(date +%H:%M:%S)):"
    sed 's/^/  /' <<<"$busy"
    last="$busy"
  fi
  waited=1
  sleep "$interval"
done
