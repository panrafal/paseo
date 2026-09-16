"""Test the Mac update with a temporary app and isolated macOS commands.

Run: python3 fork/update-macos.test.py
"""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class MacUpdateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mac update's ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.apps = self.root / "Applications"
        self.apps.mkdir()
        self.app = self.apps / "Paseo.app"
        self.mount = self.root / "Volumes/build"
        self.mount.mkdir(parents=True)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}",
                        TEST_ROOT=str(self.root), FORK_AGENT_WAIT_INTERVAL="0")
        self.env.pop("PASEO_AGENT_ID", None)
        self.env.pop("FORK_SKIP_AGENT_WAIT", None)
        here = Path(__file__).resolve().parent
        (self.root / "wait-for-agents.sh").write_text(
            (here / "wait-for-agents.sh").read_text())
        source = (here / "update-macos.sh").read_text()
        # Redirect the fixed system install location into the disposable fixture.
        self.updater = self.root / "update-macos.sh"
        self.updater.write_text(source.replace(
            'APP="/Applications/Paseo.app"', 'APP="$TEST_ROOT/Applications/Paseo.app"'
        ).replace(' /Applications/\n', ' "$TEST_ROOT/Applications/"\n'))
        self.script(self.bin / "uname", '[ "$1" != -s ] || { echo Darwin; exit; }; echo arm64')
        self.script(self.bin / "defaults", 'cat "$(dirname "$2")/version"')
        self.script(self.bin / "gh", '''
[ "$2" != download ] || touch "$TEST_ROOT/build-arm64.dmg"
''')
        self.script(self.bin / "find", 'echo "$TEST_ROOT/build-arm64.dmg"')
        self.script(self.bin / "hdiutil", '''
[ "$1" != attach ] || printf '/dev/disk1\t%s\n' "$TEST_ROOT/Volumes/build"
''')
        self.script(self.bin / "pgrep", '[ "${PASEO_RUNNING:-0}" = 1 ]')
        self.script(self.bin / "osascript", 'echo quit >> "$TEST_ROOT/events"')
        self.script(self.bin / "sleep", 'exit 0')
        self.script(self.bin / "xattr", 'exit 0')
        self.script(self.bin / "open", 'echo launch >> "$TEST_ROOT/events"')
        self.make_app(self.mount / "Paseo.app", "0.7.2-panrafal.10")

    def script(self, path, body):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('#!/usr/bin/env bash\nset -euo pipefail\n' + body + '\n')
        path.chmod(0o755)

    def make_app(self, app, version):
        self.script(app / "Contents/Resources/bin/paseo", '''
version="$(cat "$(dirname "$0")/../../version")"
if [ "$*" = 'ls -g --json' ]; then
  polls="$(cat "$TEST_ROOT/polls" 2>/dev/null || echo 0)"
  echo $((polls + 1)) > "$TEST_ROOT/polls"
  echo "ls $version" >> "$TEST_ROOT/events"
  status=idle
  [ "$polls" -ge "${BUSY_POLLS:-0}" ] || status=running
  printf '[\\n  {\\n    "id": "agent-1",\\n    "shortId": "agent-1",\\n    "name": "fixture",\\n    "status": "%s"\\n  }\\n]\\n' "$status"
  exit 0
fi
[ "$*" = 'daemon restart' ]
echo "restart $version" >> "$TEST_ROOT/events"
exit "${RESTART_EXIT:-0}"
''')
        (app / "Contents/version").write_text(version + "\n")

    def update(self, **env):
        return subprocess.run(["bash", str(self.updater), "fork-v0.7.2-panrafal.10"],
                              env=dict(self.env, **env), capture_output=True,
                              text=True, timeout=5)

    def test_upgrade_restarts_new_bundled_daemon_before_launch(self):
        self.make_app(self.app, "0.7.2-panrafal.9")
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "events").read_text(),
                         "ls 0.7.2-panrafal.9\nrestart 0.7.2-panrafal.10\nlaunch\n")

    def test_installed_version_still_restarts_daemon(self):
        self.make_app(self.app, "0.7.2-panrafal.10")
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "events").read_text(),
                         "ls 0.7.2-panrafal.10\nrestart 0.7.2-panrafal.10\nlaunch\n")
        self.assertFalse((self.root / "build-arm64.dmg").exists())

    def test_restart_failure_stops_before_launch(self):
        self.make_app(self.app, "0.7.2-panrafal.9")
        result = self.update(RESTART_EXIT="7")
        self.assertEqual(result.returncode, 7, result.stdout + result.stderr)
        self.assertEqual((self.root / "events").read_text(),
                         "ls 0.7.2-panrafal.9\nrestart 0.7.2-panrafal.10\n")

    def test_waits_for_running_agents_before_quitting(self):
        self.make_app(self.app, "0.7.2-panrafal.9")
        result = self.update(BUSY_POLLS="2", PASEO_RUNNING="1")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("agent-1 running fixture", result.stdout)
        self.assertEqual((self.root / "events").read_text(),
                         "ls 0.7.2-panrafal.9\n" * 3 +
                         "quit\nrestart 0.7.2-panrafal.10\nlaunch\n")

    def test_skip_agent_wait(self):
        self.make_app(self.app, "0.7.2-panrafal.9")
        result = self.update(BUSY_POLLS="5", FORK_SKIP_AGENT_WAIT="1")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "events").read_text(),
                         "restart 0.7.2-panrafal.10\nlaunch\n")


if __name__ == "__main__":
    unittest.main()
