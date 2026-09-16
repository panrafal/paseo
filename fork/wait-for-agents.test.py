"""Exercise the agent wait against a scripted paseo CLI.

Run: python3 fork/wait-for-agents.test.py
"""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

WAITER = Path(__file__).resolve().with_name("wait-for-agents.sh")


def agent(short, status, **extra):
    # The shape `paseo ls -g --json` prints, nested labels included.
    return {"id": f"{short}-full", "shortId": short, "name": f"agent {short}",
            "provider": "claude/opus", "thinking": "high", "status": status,
            "cwd": "~/x", "created": "just now", "labels": extra.get("labels", {})}


class WaitForAgentsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agent wait's ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.paseo = self.root / "paseo"
        # Each poll prints the next response file; the last one repeats.
        self.paseo.write_text('''#!/usr/bin/env bash
[ "$*" = 'ls -g --json' ] || exit 90
n="$(cat "$ROOT/polls" 2>/dev/null || echo 0)"
echo $((n + 1)) > "$ROOT/polls"
f="$ROOT/poll.$n"
[ -e "$f" ] || f="$(ls "$ROOT"/poll.* | sort -t. -k2 -n | tail -1)"
echo 'cli warning' >&2
[ ! -e "$f.fail" ] || { echo 'timed out' >&2; exit 1; }
cat "$f"
''')
        self.paseo.chmod(0o755)
        self.env = dict(os.environ, ROOT=str(self.root), FORK_AGENT_WAIT_INTERVAL="0")
        for key in ("PASEO_AGENT_ID", "FORK_SKIP_AGENT_WAIT"):
            self.env.pop(key, None)

    def polls(self, *responses):
        for i, response in enumerate(responses):
            path = self.root / f"poll.{i}"
            if response is None:
                path.write_text("")
                (self.root / f"poll.{i}.fail").write_text("")
            elif isinstance(response, str):
                path.write_text(response)
            else:
                path.write_text(json.dumps(response, indent=2) + "\n")

    def wait(self, **env):
        return subprocess.run(["bash", str(WAITER), str(self.paseo), "box"],
                              env=dict(self.env, **env), capture_output=True,
                              text=True, timeout=10)

    def poll_count(self):
        return int((self.root / "polls").read_text())

    def test_waits_until_running_and_initializing_agents_settle(self):
        self.polls([agent("a1", "running"), agent("a2", "idle")],
                   [agent("a1", "error"), agent("a2", "initializing")],
                   [agent("a1", "error"), agent("a2", "idle"), agent("a3", "closed")])
        result = self.wait()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("  a1 running agent a1\n", result.stdout)
        self.assertIn("  a2 initializing agent a2\n", result.stdout)
        self.assertTrue(result.stdout.endswith("All agents on box are idle.\n"))
        self.assertEqual(self.poll_count(), 3)

    def test_label_named_status_does_not_count(self):
        self.polls([agent("a1", "idle", labels={"status": "running"})])
        result = self.wait()
        self.assertEqual(result.stdout, "No agents running on box.\n")

    def test_own_agent_is_not_waited_for(self):
        self.polls([agent("me", "running")])
        result = self.wait(PASEO_AGENT_ID="me-full")
        self.assertEqual(result.stdout, "No agents running on box.\n")

    def test_empty_list(self):
        self.polls("[]\n")
        result = self.wait()
        self.assertEqual((result.returncode, result.stdout), (0, "No agents running on box.\n"))

    def test_unlistable_daemon_is_not_waited_for(self):
        self.polls(None)
        result = self.wait()
        self.assertEqual(result.returncode, 0)
        self.assertIn("not waiting: cli warning\ntimed out", result.stderr)

    def test_failed_listing_after_agents_were_seen_is_retried(self):
        self.polls([agent("a1", "running")], None, [agent("a1", "idle")])
        result = self.wait()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("retrying: cli warning\ntimed out", result.stderr)
        self.assertIn("All agents on box are idle.", result.stdout)
        self.assertEqual(self.poll_count(), 3)

    def test_unrecognised_output_fails(self):
        self.polls('[{"id":"a1","status":"running"}]\n')
        result = self.wait()
        self.assertEqual(result.returncode, 1)
        self.assertIn("cannot read the agent list", result.stderr)

    def test_skip(self):
        self.polls([agent("a1", "running")])
        result = self.wait(FORK_SKIP_AGENT_WAIT="1")
        self.assertEqual(result.returncode, 0)
        self.assertFalse((self.root / "polls").exists())


if __name__ == "__main__":
    unittest.main()
