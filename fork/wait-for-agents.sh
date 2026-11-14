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
# A daemon that cannot be listed before any agent was seen has no agents to
# lose, so that is a warning and no wait. Once agents were seen, a failed
# listing is retried: it is more likely a timeout than a daemon gone. Output
# that lists nothing it can parse is an error, so a changed format cannot
# pass for an idle daemon.

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
# <name>" for every agent still working, and fails when the output is neither
# `[]` nor agent blocks it recognises.
busy_agents() {
  awk -v self="${PASEO_AGENT_ID:-}" '
    function value(line) {
      sub(/^    "[a-zA-Z]+": "/, "", line)
      sub(/",?$/, "", line)
      return line
    }
    /^  \{/ { blocks++; id = ""; short = ""; name = ""; status = "" }
    !/^\[\]$/ && !/^[[:space:]]*$/ { content = 1 }
    /^    "id": "/ { id = value($0) }
    /^    "shortId": "/ { short = value($0) }
    /^    "name": "/ { name = value($0) }
    /^    "status": "/ { status = value($0) }
    /^  \}/ {
      if ((status == "running" || status == "initializing") && id != self)
        printf "%s %s %s\n", short, status, name
    }
    END { if (content && !blocks) exit 3 }
  '
}

# stderr is kept apart so a CLI warning cannot break the parse.
errors="$(mktemp)"
trap 'rm -f "$errors"' EXIT

last=""
failed=""
waited=0
while :; do
  if ! out="$("$paseo" ls -g --json 2>"$errors")"; then
    # The CLI prints its error as indented JSON; one line keeps it readable
    # in the deploy console and makes it the summary line.
    out="$(tr -s '[:space:]' ' ' <"$errors")"
    out="${out% }"
    if [ "$waited" -eq 0 ]; then
      echo "warning: cannot list agents on $where, not waiting: $out" >&2
      exit 0
    fi
    [ "$out" = "$failed" ] || echo "warning: cannot list agents on $where, retrying: $out" >&2
    failed="$out"
    sleep "$interval"
    continue
  fi
  failed=""
  if ! busy="$(busy_agents <<<"$out")"; then
    echo "error: cannot read the agent list on $where; FORK_SKIP_AGENT_WAIT=1 skips the wait:" >&2
    echo "$out" | head -5 >&2
    exit 1
  fi
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
