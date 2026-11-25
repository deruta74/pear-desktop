import json
import platform
import plistlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import benchmark


class ProcessAccountingTest(unittest.TestCase):
    def test_only_new_same_user_webkit_services_enter_the_rust_estimate(self):
        baseline = benchmark.parse_ps(
            "20 1 20 501 100 Mon Jan  5 01:02:03 2026 /WebKit/com.apple.WebKit.GPU\n"
            "30 1 30 501 200 Mon Jan  5 01:02:03 2026 /WebKit/com.apple.WebKit.Networking\n"
        )
        sample = benchmark.parse_ps(
            "10 2 10 501 1000 Mon Jan  5 01:02:04 2026 /Applications/Pear Preview\n"
            "11 10 10 501 95 Mon Jan  5 01:02:04 2026 /Some Helper\n"
            "12 11 12 501 60 Mon Jan  5 01:02:04 2026 /Some Renderer\n"
            "20 1 20 501 300 Mon Jan  5 01:02:03 2026 /WebKit/com.apple.WebKit.GPU\n"
            "30 1 30 501 200 Mon Jan  5 01:02:04 2026 /WebKit/com.apple.WebKit.Networking\n"
            "40 1 40 501 400 Mon Jan  5 01:02:04 2026 /WebKit/com.apple.WebKit.WebContent.EnhancedSecurity\n"
            "50 1 50 502 500 Mon Jan  5 01:02:04 2026 /WebKit/com.apple.WebKit.WebContent\n"
            "60 1 60 501 600 Mon Jan  5 01:02:04 2026 /Safari\n"
        )

        rust = benchmark.account_memory("rust", 10, 501, baseline, sample)
        electron = benchmark.account_memory("electron", 10, 501, baseline, sample)

        self.assertEqual(rust["host_tree_rss_kib"], 1155)
        self.assertEqual(rust["host_tree"][0]["executable"], "Pear Preview")
        self.assertEqual([p["pid"] for p in rust["new_webkit_services"]], [30, 40])
        self.assertEqual([p["pid"] for p in rust["preexisting_webkit_services"]], [20])
        self.assertEqual(rust["rust_rss_with_candidate_services_kib"], 1755)
        self.assertIn("preexisting_webkit_services", rust["possible_contamination"])
        self.assertIn("new_webkit_services_during_electron", electron["possible_contamination"])
        self.assertNotIn("rust_rss_with_candidate_services_kib", electron)


@unittest.skipUnless(platform.system() == "Darwin", "macOS process accounting")
class BenchmarkIntegrationTest(unittest.TestCase):
    def test_stops_term_ignoring_helper_after_leader_exits(self):
        source = """\
import os
import signal
import sys

if os.fork() == 0:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    print('PEAR_READY', flush=True)
    sys.stdin.buffer.read()
else:
    while True:
        signal.pause()
"""
        with subprocess.Popen(
            [sys.executable, "-c", source],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            start_new_session=True,
        ) as host:
            try:
                benchmark.wait_for_ready(host.stdout, time.perf_counter(), 2)
                remaining = benchmark.stop_host(host)
                self.assertEqual(host.returncode, -signal.SIGTERM)
                self.assertEqual(remaining, [])
            finally:
                host.stdin.close()
                if host.returncode is None:
                    host.kill()

    def test_alternates_hosts_serves_one_fixture_and_rejects_unterminated_marker(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            rust = folder / "rust"
            electron = folder / "Electron.app" / "Contents" / "MacOS" / "Electron"
            electron.parent.mkdir(parents=True)
            with (electron.parent.parent / "Info.plist").open("wb") as info:
                plistlib.dump(
                    {"CFBundleIdentifier": "com.github.Electron", "CFBundleExecutable": "Electron"},
                    info,
                )
            host = (
                f"#!{sys.executable}\n"
                "import os, sys, time, urllib.request\n"
                "args = sys.argv\n"
                "url = args[args.index('--benchmark-url') + 1]\n"
                "with urllib.request.urlopen(url, timeout=2) as reply:\n"
                "    assert b'<title>Pear Desktop Benchmark</title>' in reply.read()\n"
                "if args[0].endswith('/Electron'):\n"
                "    profile = os.environ['PEAR_BENCHMARK_DATA_DIR']\n"
                "    assert os.path.isdir(profile) and not os.listdir(profile)\n"
                "    with open(os.path.join(profile, 'isolated'), 'w') as handle:\n"
                "        handle.write('local')\n"
                "print('PEAR_READY', end=os.environ.get('BENCH_TEST_END', '\\n'), flush=True)\n"
                "time.sleep(10)\n"
            )
            for binary in (rust, electron):
                binary.write_text(host)
                binary.chmod(0o755)
            command = [
                sys.executable, str(Path(benchmark.__file__)),
                "--rust-bin", str(rust), "--electron-bin", str(electron),
                "--runs", "2", "--settle", "0", "--cooldown", "0", "--timeout", "2",
            ]
            result = subprocess.run(command, capture_output=True, text=True, timeout=12)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual([r["engine"] for r in report["trials"]], ["rust", "electron", "electron", "rust"])
            self.assertEqual([r["fixture_requests"] for r in report["trials"]], [1, 1, 1, 1])
            self.assertTrue(all(r["startup_ms"] > 0 for r in report["trials"]))

            rust.write_text(host.replace("'BENCH_TEST_END', '\\n'", "'BENCH_TEST_END', ''"))
            result = subprocess.run(command, capture_output=True, text=True, timeout=12)
            self.assertEqual(result.returncode, 1)
            report = json.loads(result.stdout)
            self.assertEqual(report["trials"][0]["status"], "error")
            self.assertIn("timed out waiting for PEAR_READY", report["trials"][0]["error"])
            self.assertEqual(report["trials"][1]["status"], "ok")


if __name__ == "__main__":
    unittest.main()
