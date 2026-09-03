#!/usr/bin/env bash
#
# fork/install-vscode-remote.sh — install the fork's VS Code extension into
# the VS Code Server and Cursor Server on this machine.
#
#   fork/install-vscode-remote.sh ~/.paseo-fork/dist/paseo-vscode-<version>.vsix
#
# Run it ON THE DEVBOX, as the account VS Code and Cursor SSH in as. The
# extension is extensionKind "workspace", so in a Remote-SSH window it runs
# here, next to the daemon; an install on the laptop alone leaves those
# windows without it. fork/build.sh vscode prints the ssh one-liner that runs
# this for you. It needs no sudo and nothing from fork/config.sh.
#
# Each product keeps one extensions directory shared by every server version
# it has downloaded here, so installing through the newest server covers
# them all. Open remote windows pick the new version up after
# "Developer: Reload Window".

set -euo pipefail

die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

vsix="${1:-}"
[ -n "$vsix" ] || die "usage: $0 <paseo-vscode-*.vsix>"
[ -f "$vsix" ] || die "no such file: $vsix"

installed=0
for product in "VS Code:$HOME/.vscode-server:code-server" "Cursor:$HOME/.cursor-server:cursor-server"; do
  IFS=: read -r name root bin <<<"$product"
  if [ ! -d "$root" ]; then
    echo "$name has never connected to this host ($root is missing) — skipping"
    continue
  fi
  # Two layouts are in the wild: cli/servers/<name>/server, and the older
  # bin/<commit>. Newest by mtime is the one the editor currently uses.
  cli="$(ls -t "$root"/cli/servers/*/server/bin/"$bin" "$root"/bin/*/bin/"$bin" 2>/dev/null | head -1 || true)"
  if [ -z "$cli" ]; then
    echo "$name: no server binary under $root — skipping"
    continue
  fi
  printf '\033[1m==>\033[0m %s: %s\n' "$name" "$cli"
  "$cli" --install-extension "$vsix" --force
  installed=$((installed + 1))
done

[ "$installed" -gt 0 ] || die "neither VS Code nor Cursor has a server on this host yet — connect once, then re-run"
echo "Reload any open remote window (Developer: Reload Window) to pick it up."
