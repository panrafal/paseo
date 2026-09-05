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
                        TEST_ROOT=str(self.root))
        source = Path(__file__).with_name("update-macos.sh").read_text()
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
        self.script(self.bin / "pgrep", 'exit 1')
        self.script(self.bin / "xattr", 'exit 0')
        self.script(self.bin / "open", 'echo launch >> "$TEST_ROOT/events"')
        self.make_app(self.mount / "Paseo.app", "0.7.2-panrafal.10")

    def script(self, path, body):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('#!/usr/bin/env bash\nset -euo pipefail\n' + body + '\n')
        path.chmod(0o755)

    def make_app(self, app, version):
        self.script(app / "Contents/Resources/bin/paseo", '''
[ "$*" = 'daemon restart' ]
version="$(cat "$(dirname "$0")/../../version")"
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
                         "restart 0.7.2-panrafal.10\nlaunch\n")

    def test_installed_version_still_restarts_daemon(self):
        self.make_app(self.app, "0.7.2-panrafal.10")
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "events").read_text(),
                         "restart 0.7.2-panrafal.10\nlaunch\n")
        self.assertFalse((self.root / "build-arm64.dmg").exists())

    def test_restart_failure_stops_before_launch(self):
        self.make_app(self.app, "0.7.2-panrafal.9")
        result = self.update(RESTART_EXIT="7")
        self.assertEqual(result.returncode, 7, result.stdout + result.stderr)
        self.assertEqual((self.root / "events").read_text(),
                         "restart 0.7.2-panrafal.10\n")


if __name__ == "__main__":
    unittest.main()
