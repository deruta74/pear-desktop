# macOS browser host benchmark

Run from the repository root in an active macOS desktop session. Build the Rust
preview in release mode with its benchmark feature and use the stock Electron
runtime from the repository’s installed dependencies.

```sh
cargo build --manifest-path experiments/rust-desktop/Cargo.toml \
  --release --locked -p pear-desktop-preview --features benchmark

python3 experiments/rust-desktop/benchmark/benchmark.py \
  --rust-bin experiments/rust-desktop/target/release/pear-desktop-preview \
  --electron-bin node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  --runs 6 > /tmp/pear-browser-benchmark.json
```

The harness alternates which host starts first in each pair. Both display the
same local page in a 1200 × 800 logical-point content area. The page loads
from a loopback HTTP server with caching disabled. Each Electron trial uses a
fresh temporary profile and the private entry in this folder. The Rust host
uses an ephemeral WebView.

Startup time runs from process launch to receipt of the top-level page load
marker. The RSS sample defaults to two seconds after the marker, followed by
one second of cooldown after each host exits. Keep desktop activity and power
conditions consistent throughout a run. The JSON includes trial order, the
fixture digest, machine and executable details, and min, median, and max for
startup and process-tree RSS. A failed trial records its error and causes a
nonzero exit.

`host_tree_rss_kib` sums the host and its sampled descendants. macOS can
launch WebKit services outside that process tree. The harness lists the
current user's newly observed and pre-existing WebContent, Networking, and
GPU services separately. `rust_rss_with_candidate_services_kib` adds the
new services as an estimate when any are observed. Their ownership is
inferred from timing and user ID. The sample flags pre-existing services
and newly observed services during Electron trials as possible
contamination. Shared resident pages can be counted in multiple processes.
The figures describe these browser hosts on this fixture.

Run the harness tests without opening windows.

```sh
python3 -B -m unittest discover -s experiments/rust-desktop/benchmark -v
```
