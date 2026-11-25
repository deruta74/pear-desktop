"""Compare the minimal Rust and Electron browser hosts on macOS."""

import argparse
import hashlib
import json
import math
import os
import platform
import plistlib
import re
import selectors
import signal
import statistics
import subprocess
import tempfile
import threading
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


HERE = Path(__file__).resolve().parent
WEBKIT_SERVICE = re.compile(r"com\.apple\.WebKit\.(WebContent|Networking|GPU)(?:\.[\w.-]+)?")


class BenchmarkError(Exception):
    pass


@dataclass(frozen=True)
class Process:
    pid: int
    ppid: int
    pgid: int
    uid: int
    rss_kib: int
    started: str
    executable: str

    @property
    def identity(self):
        return self.pid, self.started, self.executable


def parse_ps(output):
    rows = []
    for line in output.splitlines():
        fields = line.split(maxsplit=10)
        if len(fields) < 10:
            raise BenchmarkError("unexpected macOS ps output")
        executable = Path(fields[10]).name if len(fields) == 11 else ""
        rows.append(Process(*map(int, fields[:5]), " ".join(fields[5:10]), executable))
    return rows


def snapshot():
    return parse_ps(subprocess.check_output(
        ["/bin/ps", "-axww", "-o", "pid=,ppid=,pgid=,uid=,rss=,lstart=,comm="],
        env={**os.environ, "LC_ALL": "C"},
        encoding="utf-8",
        errors="replace",
    ))


def account_memory(engine, root_pid, uid, baseline, sample):
    by_pid = {row.pid: row for row in sample}
    if root_pid not in by_pid or not by_pid[root_pid].rss_kib:
        raise BenchmarkError("host exited before the memory snapshot")

    by_parent = {}
    for row in sample:
        by_parent.setdefault(row.ppid, []).append(row.pid)

    descendants = set()
    pending = [root_pid]
    while pending:
        pid = pending.pop()
        if pid not in descendants:
            descendants.add(pid)
            pending.extend(by_parent.get(pid, ()))

    host_tree = []
    new_webkit = []
    preexisting_webkit = []
    baseline_ids = {row.identity for row in baseline}
    for row in sorted(sample, key=lambda row: row.pid):
        if row.pid in descendants:
            host_tree.append(row)
        elif row.uid == uid and row.rss_kib and WEBKIT_SERVICE.fullmatch(row.executable):
            if row.identity in baseline_ids:
                preexisting_webkit.append(row)
            else:
                new_webkit.append(row)

    contamination = []
    if preexisting_webkit:
        contamination.append("preexisting_webkit_services")
    if new_webkit:
        contamination.append(
            "new_webkit_service_ownership_unverified" if engine == "rust"
            else "new_webkit_services_during_electron"
        )

    host_rss = sum(row.rss_kib for row in host_tree)
    candidate_rss = sum(row.rss_kib for row in new_webkit)
    memory = {
        "snapshot_utc": datetime.now(timezone.utc).isoformat(),
        "host_tree_rss_kib": host_rss,
        "host_tree": [asdict(row) for row in host_tree],
        "new_webkit_services_rss_kib": candidate_rss,
        "new_webkit_services": [asdict(row) for row in new_webkit],
        "preexisting_webkit_services": [asdict(row) for row in preexisting_webkit],
        "possible_contamination": contamination,
    }
    if engine == "rust":
        memory["rust_rss_with_candidate_services_kib"] = (
            host_rss + candidate_rss if new_webkit else None
        )
    return memory


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/":
            self.send_error(404)
            return
        with self.server.request_lock:
            self.server.requests += 1
        payload = self.server.payload
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):
        pass


def wait_for_ready(stream, started, timeout):
    pending = b""
    with selectors.DefaultSelector() as selector:
        selector.register(stream, selectors.EVENT_READ)
        while True:
            remaining = started + timeout - time.perf_counter()
            if remaining <= 0 or not selector.select(remaining):
                raise BenchmarkError("timed out waiting for PEAR_READY")
            chunk = os.read(stream.fileno(), 4096)
            observed = time.perf_counter()
            if not chunk:
                raise BenchmarkError("host closed stdout before PEAR_READY")
            *lines, pending = (pending + chunk).split(b"\n")
            if any(line in (b"PEAR_READY", b"PEAR_READY\r") for line in lines):
                return observed


def signal_group(pgid, signum):
    try:
        os.killpg(pgid, signum)
    except ProcessLookupError:
        pass


def wait_for_group_exit(pgid, timeout):
    deadline = time.perf_counter() + timeout
    while True:
        rows = subprocess.check_output(
            ["/bin/ps", "-ax", "-o", "pid=,pgid=,state="], text=True, timeout=1
        )
        remaining = [
            int(pid)
            for pid, group, state in (line.split() for line in rows.splitlines())
            if int(group) == pgid and not state.startswith("Z")
        ]
        delay = deadline - time.perf_counter()
        if not remaining or delay <= 0:
            return remaining
        time.sleep(min(0.05, delay))


def stop_host(process):
    if process.returncode is not None:
        raise BenchmarkError("cannot signal a process group after its leader has been reaped")

    # start_new_session=True reserved the child's PID as its process group ID.
    # Keep the leader unreaped through escalation to prevent reuse of that ID.
    # Detached WebKit services remain outside the benchmark's process group.
    try:
        signal_group(process.pid, signal.SIGTERM)
        try:
            remaining = wait_for_group_exit(process.pid, timeout=2)
        except (OSError, subprocess.SubprocessError, KeyboardInterrupt):
            signal_group(process.pid, signal.SIGKILL)
            raise
        if remaining:
            signal_group(process.pid, signal.SIGKILL)
            remaining = wait_for_group_exit(process.pid, timeout=2)
        return remaining
    finally:
        process.stdout.close()
        process.wait(timeout=3)


def run_trial(engine, binary, round_number, server, url, args):
    trial = {"engine": engine, "round": round_number, "status": "error"}
    env = os.environ.copy()
    env.pop("ELECTRON_RUN_AS_NODE", None)
    env.pop("NODE_OPTIONS", None)
    command = [str(binary)]
    with tempfile.TemporaryDirectory(prefix="pear-browser-bench-") as data, tempfile.TemporaryFile() as log:
        if engine == "electron":
            env["PEAR_BENCHMARK_DATA_DIR"] = data
            command.append(str(HERE / "electron"))
        command.extend(["--benchmark-url", url])

        baseline = snapshot()
        requests_before = server.requests
        started = time.perf_counter()
        process = subprocess.Popen(
            command,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=log,
            start_new_session=True,
        )
        try:
            ready = wait_for_ready(process.stdout, started, args.timeout)
            trial["startup_ms"] = round((ready - started) * 1000, 3)
            time.sleep(max(0, ready + args.settle - time.perf_counter()))
            trial["memory"] = account_memory(engine, process.pid, os.getuid(), baseline, snapshot())
            trial["fixture_requests"] = server.requests - requests_before
            if not trial["fixture_requests"]:
                raise BenchmarkError("fixture did not receive a request from the host")
            trial["status"] = "ok"
        except BenchmarkError as error:
            trial["error"] = str(error)
        finally:
            remaining = stop_host(process)

        trial["exit_code_after_cleanup"] = process.returncode
        trial.setdefault("fixture_requests", server.requests - requests_before)
        if remaining:
            trial["status"] = "error"
            trial["error"] = "live processes remained in the isolated benchmark process group"
            trial["remaining_process_group_pids"] = remaining
        if trial["status"] == "error":
            log.seek(max(0, log.tell() - 4096))
            trial["stderr_tail"] = log.read().decode("utf-8", errors="replace")
    return trial


def command_output(*command):
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def machine_factors():
    power = command_output("/usr/bin/pmset", "-g", "batt")
    power_source = re.search(r"Now drawing from '([^']+)'", power or "")
    return {
        "os_version": command_output("/usr/bin/sw_vers", "-productVersion"),
        "os_build": command_output("/usr/bin/sw_vers", "-buildVersion"),
        "hardware_model": command_output("/usr/sbin/sysctl", "-n", "hw.model"),
        "cpu_model": command_output("/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"),
        "python_architecture": platform.machine(),
        "logical_cpu_count": os.cpu_count(),
        "physical_memory_bytes": int(command_output("/usr/sbin/sysctl", "-n", "hw.memsize") or 0),
        "power_source": power_source.group(1) if power_source else None,
        "python_version": platform.python_version(),
    }


def describe_executable(path):
    digest = hashlib.sha256()
    with path.open("rb") as executable:
        for block in iter(lambda: executable.read(1024 * 1024), b""):
            digest.update(block)
    return {
        "name": path.name,
        "format": command_output("/usr/bin/file", "-b", str(path)),
        "sha256": digest.hexdigest(),
    }


def electron_bundle_info(path):
    # Require the stock Electron runtime so a production .app cannot silently
    # ignore the local entry and load its own profile.
    try:
        with (path.parent.parent / "Info.plist").open("rb") as info:
            bundle = plistlib.load(info)
    except (OSError, ValueError, plistlib.InvalidFileException):
        bundle = {}
    if (
        path.name != "Electron"
        or path.parent.name != "MacOS"
        or path.parent.parent.name != "Contents"
        or bundle.get("CFBundleExecutable") != "Electron"
        or bundle.get("CFBundleIdentifier") != "com.github.Electron"
        or (path.parent.parent / "Resources" / "app.asar").exists()
        or (path.parent.parent / "Resources" / "app").exists()
    ):
        raise BenchmarkError("--electron-bin must be the executable inside a stock Electron.app")
    return bundle


def summarize(trials):
    summary = {}
    for engine in ("rust", "electron"):
        passed = [trial for trial in trials if trial["engine"] == engine and trial["status"] == "ok"]
        if not passed:
            summary[engine] = {"successful_runs": 0}
            continue
        timings = [trial["startup_ms"] for trial in passed]
        memories = [trial["memory"]["host_tree_rss_kib"] for trial in passed]
        summary[engine] = {
            "successful_runs": len(passed),
            "startup_median_ms": statistics.median(timings),
            "startup_min_ms": min(timings),
            "startup_max_ms": max(timings),
            "host_tree_rss_median_kib": statistics.median(memories),
            "host_tree_rss_min_kib": min(memories),
            "host_tree_rss_max_kib": max(memories),
        }
        if engine == "rust":
            estimates = [
                trial["memory"]["rust_rss_with_candidate_services_kib"]
                for trial in passed
                if trial["memory"]["rust_rss_with_candidate_services_kib"] is not None
            ]
            summary[engine]["runs_with_webkit_candidates"] = len(estimates)
            if estimates:
                summary[engine]["rust_rss_with_candidate_services_median_kib"] = statistics.median(estimates)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rust-bin", required=True, type=Path, help="release executable with benchmark feature")
    parser.add_argument("--electron-bin", required=True, type=Path, help="executable inside stock Electron.app")
    parser.add_argument("--runs", default=6, type=int, help="number of paired rounds (default: 6)")
    parser.add_argument("--timeout", default=20.0, type=float, help="seconds to wait for page load (default: 20)")
    parser.add_argument("--settle", default=2.0, type=float, help="seconds after page load to sample RSS (default: 2)")
    parser.add_argument("--cooldown", default=1.0, type=float, help="seconds after each process exits (default: 1)")
    args = parser.parse_args()
    if platform.system() != "Darwin":
        parser.error("the benchmark requires macOS")
    if args.runs < 1 or not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--runs and --timeout must be positive")
    if any(not math.isfinite(value) or value < 0 for value in (args.settle, args.cooldown)):
        parser.error("--settle and --cooldown must be nonnegative")

    binaries = {"rust": args.rust_bin.resolve(), "electron": args.electron_bin.resolve()}
    for engine, path in binaries.items():
        if not path.is_file() or not os.access(path, os.X_OK):
            parser.error(f"--{engine}-bin must be an executable file")
    try:
        bundle = electron_bundle_info(binaries["electron"])
        if binaries["rust"] == binaries["electron"] or any(
            ancestor.suffix.lower() == ".app" for ancestor in binaries["rust"].parents
        ):
            raise BenchmarkError("--rust-bin must be the Rust preview executable")
    except BenchmarkError as error:
        parser.error(str(error))

    payload = (HERE / "fixture.html").read_bytes()
    report = {
        "schema_version": 1,
        "started_utc": datetime.now(timezone.utc).isoformat(),
        "machine": machine_factors(),
        "executables": {name: describe_executable(path) for name, path in binaries.items()},
        "settings": {
            "rounds": args.runs,
            "timeout_seconds": args.timeout,
            "settle_seconds": args.settle,
            "cooldown_seconds": args.cooldown,
            "window_content_logical_points": {"width": 1200, "height": 800},
            "fixture_sha256": hashlib.sha256(payload).hexdigest(),
        },
        "trials": [],
    }
    report["executables"]["electron"]["bundle_version"] = bundle.get("CFBundleShortVersionString")
    with ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler) as server:
        server.requests = 0
        server.request_lock = threading.Lock()
        server.payload = payload
        url = f"http://127.0.0.1:{server.server_port}/"
        report["settings"]["fixture_url"] = url
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        try:
            for round_number in range(1, args.runs + 1):
                order = ("rust", "electron") if round_number % 2 else ("electron", "rust")
                for engine in order:
                    trial = run_trial(engine, binaries[engine], round_number, server, url, args)
                    report["trials"].append(trial)
                    if trial.get("remaining_process_group_pids"):
                        raise BenchmarkError("stopped after the isolated process group failed to exit")
                    time.sleep(args.cooldown)
        except (BenchmarkError, OSError, subprocess.SubprocessError, KeyboardInterrupt) as error:
            report["error"] = str(error) or type(error).__name__
        finally:
            server.shutdown()
            worker.join()

    report["summary"] = summarize(report["trials"])
    print(json.dumps(report, indent=2, allow_nan=False))
    return int("error" in report or any(trial["status"] != "ok" for trial in report["trials"]))


if __name__ == "__main__":
    raise SystemExit(main())
