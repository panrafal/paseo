"""Exercise deploy ordering with external build/install commands isolated.

Run: python3 fork/deploy.test.py
"""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class DeployTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="deploy test's ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.fork = self.root / "fork"
        self.fork.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        source = Path(__file__).resolve().parent
        for name in ("deploy.sh", "config.sh", "dist.env"):
            shutil.copy2(source / name, self.fork / name)
        self.env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}",
                        FORK_WORK_ROOT=str(self.root / "work"), TEST_ROOT=str(self.root))
        self.script(self.bin / "uname", 'echo Darwin')
        self.script(self.bin / "git", '''
[ "$PWD" = "$TEST_ROOT" ] || exit 90
case "$*" in
  'rev-parse --git-dir') echo .git ;;
  'rev-parse main') echo test-main-sha ;;
  'remote get-url '*) echo https://example.invalid/upstream ;;
  'show main:package.json') echo '{"version":"0.7.2"}' ;;
  'show main:fork/build-number') echo '0.7.2 9' ;;
  'show main:fork/wait-for-agents.sh') echo '# waiter' ;;
  'log '*) echo 'abc123 fixture' ;;
  *) exit 91 ;;
esac
''')
        self.script(self.bin / "gh", '''
printf '%s\n' "$*" >> "$TEST_ROOT/gh.calls"
case "$*" in
  'release view '*) exit "${RELEASE_EXISTS:-1}" ;;
  'release create '*) exit 0 ;;
  'release upload '*) exit 0 ;;
  *) exit "${RELEASE_EXISTS:-1}" ;;
esac
''')
        self.script(self.bin / "ssh", '''
printf '%s\n' "$*" >> "$TEST_ROOT/ssh.calls"
if [ "${DAEMON_EXIT:-0}" != 0 ] && [[ "$*" == *fork/build.sh* ]]; then
  exit "$DAEMON_EXIT"
fi
if [[ "$*" == *"bash -s"* ]]; then
  [ "$(cat)" = '# waiter' ]
  echo 'Waiting for 1 agent(s) on devbox to go idle or error out (12:00:00):'
  echo '  abc1234 running fixture'
  sleep "${WAIT_SECONDS:-0}"
  echo 'All agents on devbox are idle.'
  exit "${WAIT_EXIT:-0}"
fi
if [[ "$*" == *"sudo cat"* ]]; then
  printf ''
  exit 0
fi
if [[ "$*" == *"git rev-parse"* ]]; then
  echo test-main-sha
  exit 0
fi
''')
        self.script(self.bin / "open", '''
[ "$1" = -a ] && [ "$2" = Terminal ]
[ ! -e "$TEST_ROOT/ios.started" ] || [ -e "$TEST_ROOT/ios.finished" ]
printf '%s' "$3" > "$TEST_ROOT/launcher"
exit "${OPEN_EXIT:-0}"
''')
        self.script(self.fork / "build.sh", '''
case "$1" in
  prepare) exit 0 ;;
  desktop)
    touch "$TEST_ROOT/desktop.built"
    exit "${DESKTOP_EXIT:-0}"
    ;;
  ios)
    [ "$2" = --no-wait ]
    touch "$TEST_ROOT/ios.started"
    if [ "${EXPECT_DESKTOP:-1}" = 1 ]; then
      for ((i=0; i<100; i++)); do
        [ ! -e "$TEST_ROOT/desktop.built" ] || break
        sleep 0.05
      done
      [ -e "$TEST_ROOT/desktop.built" ]
    fi
    touch "$TEST_ROOT/ios.finished"
    exit "${IOS_EXIT:-0}"
    ;;
  *) exit 92 ;;
esac
''')
        self.script(self.fork / "update-macos.sh", '''
[ "$1" = fork-v0.7.2-panrafal.9 ]
[ "$FORK_REPO" = panrafal/paseo ]
touch "$TEST_ROOT/updated"
echo 'Update finished'
''')

    def script(self, path, body):
        path.write_text('#!/usr/bin/env bash\nset -euo pipefail\n' + body + '\n')
        path.chmod(0o755)

    def deploy(self, *targets, **env):
        result = subprocess.run([str(self.fork / "deploy.sh"), "--no-update", *targets],
                                cwd="/tmp", env=dict(self.env, **env),
                                capture_output=True, text=True, timeout=20)
        self.assertFalse((self.root / "updated").exists(), result.stdout + result.stderr)
        return result

    def test_parallel_builds_then_terminal_handoff(self):
        result = self.deploy("desktop", "ios")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("installation pending in Terminal", result.stdout)
        launcher = Path((self.root / "launcher").read_text())
        update = subprocess.run([str(launcher)], env=self.env, capture_output=True,
                                text=True, timeout=5)
        self.assertEqual(update.returncode, 0, update.stderr)
        self.assertTrue((self.root / "updated").exists())
        self.assertEqual((self.root / "work/deploy/desktop-update.log").read_text(),
                         "Update finished\n")

    def test_other_failure_still_hands_off_desktop(self):
        result = self.deploy("desktop", "ios", IOS_EXIT="7")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertTrue((self.root / "launcher").exists())

    def test_failed_desktop_never_opens_terminal(self):
        result = self.deploy("desktop", "ios", DESKTOP_EXIT="8")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertFalse((self.root / "launcher").exists())
        self.assertTrue((self.root / "ios.finished").exists())

    def test_existing_release_hands_off_without_rebuilding(self):
        result = self.deploy("desktop", RELEASE_EXISTS="0")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.root / "launcher").exists())
        self.assertFalse((self.root / "desktop.built").exists())

    def test_without_desktop_never_opens_terminal(self):
        result = self.deploy("ios", EXPECT_DESKTOP="0")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.root / "launcher").exists())

    def test_terminal_launch_failure_is_reported(self):
        result = self.deploy("desktop", OPEN_EXIT="9")
        self.assertEqual(result.returncode, 9, result.stdout + result.stderr)

    def test_daemon_publishes_tarballs_to_release(self):
        result = self.deploy("daemon")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = (self.root / "gh.calls").read_text()
        self.assertIn("release upload fork-v0.7.2-panrafal.9", calls)
        self.assertIn("--clobber", calls)
        self.assertIn(
            "https://github.com/panrafal/paseo/releases/tag/fork-v0.7.2-panrafal.9",
            result.stdout,
        )

    def test_daemon_waits_for_agents_between_build_and_install(self):
        result = self.deploy("daemon", WAIT_SECONDS="4")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = (self.root / "ssh.calls").read_text().splitlines()
        steps = [next(i for i, c in enumerate(calls) if key in c)
                 for key in ("fork/build.sh", "bash -s", "npm install", "systemctl restart")]
        self.assertEqual(steps, sorted(steps))
        wait = calls[steps[1]]
        self.assertIn("sudo -u paseo -H env FORK_SKIP_AGENT_WAIT='0'", wait)
        self.assertIn("'/usr/bin/paseo' devbox", wait)
        # Printed live, before the job ends, not only in the log.
        out = result.stdout
        self.assertIn("daemon: built; waiting for agents on the devbox", out)
        self.assertLess(out.index("daemon: Waiting for 1 agent(s)"), out.index("daemon: done"))
        self.assertIn("daemon:   abc1234 running fixture", out)
        self.assertIn("no agents running on the devbox", out)

    def test_failed_agent_wait_does_not_install(self):
        result = self.deploy("daemon", WAIT_EXIT="5")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        calls = (self.root / "ssh.calls").read_text()
        self.assertNotIn("npm install", calls)
        self.assertNotIn("systemctl restart", calls)

    def test_updater_passes_skip_agent_wait(self):
        result = self.deploy("desktop", FORK_SKIP_AGENT_WAIT="1")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        launcher = Path((self.root / "launcher").read_text()).read_text()
        self.assertIn("export FORK_SKIP_AGENT_WAIT='1'", launcher)

    def test_failed_daemon_does_not_publish(self):
        result = self.deploy("daemon", DAEMON_EXIT="3")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        calls = ""
        path = self.root / "gh.calls"
        if path.exists():
            calls = path.read_text()
        self.assertNotIn("release upload", calls)


if __name__ == "__main__":
    unittest.main()
