# Pear Desktop Rust preview

Pear Desktop Rust Preview accepts individual YouTube links or IDs, keeps a local queue across launches, and opens the selected video in the official YouTube player. Playback starts from the player's own Play button.

## Run the macOS app

From the repository root, with Rust and the Xcode command-line tools available:

```sh
open "$(experiments/rust-desktop/tools/bundle-macos.sh preview)"
```

The script builds an ad hoc signed local app. The queue accepts YouTube and YouTube Music watch links, short links, Shorts, embed links and raw video IDs. Select a row or use the previous and next controls to switch videos. Move a row up or down to change playback order without restarting the current video. The queue saves video titles as it encounters them in the player and uses IDs until their titles are known. **Open in browser** opens the selected video's YouTube watch page. Use **View → Reload Player** to retry a slow or stopped player. **⌘L** focuses the link field and reveals the queue when hidden. **⇧⌘L** shows or hides the queue without interrupting the current video. The queue stores video IDs, known titles, and the selected entry in `~/Library/Application Support/com.pear-desktop.rust-preview/queue.json`.

The local controls and the official player use separate private WebViews. Only the bundled controls can send queue commands to Rust. The player loads the selected embed with the native app's Referer and uses the website's controls and media requests. It can play videos whose owners allow embedding in the current region.

**Verified on macOS 27.2.1:** captured titles for two videos, reordered the queue while the first video continued playing, and restored the titles, order, and selection after reopening. The keyboard controls for hiding the queue and refocusing the link field also worked in the bundled app. The full YouTube Music site still reports an unsupported browser in WKWebView. The preview uses individual video links. YouTube Music account browsing, Premium behavior, and live audio plugins remain separate work.

## Run the queue on Linux or Windows

The queue is opt-in while these platforms are being tested. On Linux, install the GTK 3 and WebKitGTK 4.1 development packages (`libgtk-3-dev` and `libwebkit2gtk-4.1-dev` on Debian or Ubuntu), plus a C toolchain and `pkg-config`. On Windows, use the MSVC Rust toolchain and a current Microsoft Edge WebView2 Evergreen Runtime. The app checks that both native WebView2 controllers support InPrivate mode before loading a page.

```sh
cargo run --locked --manifest-path experiments/rust-desktop/Cargo.toml -p pear-desktop-preview -- --queue
```

The queue file is `com.pear-desktop.rust-preview/queue.json` under `$XDG_DATA_HOME` (or `~/.local/share`) on Linux and under `%LOCALAPPDATA%` on Windows. To test with a fresh queue, set `PEAR_PREVIEW_QUEUE_DIR` to a separate absolute directory. **View → Hide Queue** and **File → Add Video** are available from the native menus.

On Ubuntu ARM64 with WebKitGTK 4.1, an Xvfb test confirmed that the bundled controls received their Rust acknowledgement and that YouTube's example video title appeared and persisted. The isolated test queue and an ordinary queue ran at the same time on one GTK session bus. Windows x64 passed an MSVC cross-target type check. Native Windows behavior and live Linux audio still need runtime checks.

Omit `--queue` to run the original system WebView compatibility experiment from Cargo:

```sh
cargo run --locked --manifest-path experiments/rust-desktop/Cargo.toml -p pear-desktop-preview
```

### Official YouTube Embed probe

A separate macOS test app opens Google's documented example video in a visible WebKit player. The first navigation supplies the bundle identifier as an HTTPS Referer, as required for native clients. The probe uses a fresh site session and its navigation is scoped to that example video.

```sh
open "$(experiments/rust-desktop/tools/bundle-macos.sh embed)"
```

Click the player's **Play** button and confirm that the timer advances and **Pause** works. This test applies to the documented embeddable video. YouTube Music browsing, account sessions, Premium behavior, DRM, and availability of other titles require separate validation. [Google's client identification requirements](https://developers.google.com/youtube/terms/required-minimum-functionality#api-client-identity-and-credentials)

## Reverb and platform checks

Node 24 runs the checked-in JavaScript worklet as the oracle for the host Rust port. The differential checks both channels at 8, 44.1, 48 and 96 kHz, with changing intensity and different block sizes. The crate models the wet tank. The effect chain, browser audio capture, EQ, and the released Player Actions controller remain separate integration work.

```sh
cargo test --locked --manifest-path experiments/rust-desktop/Cargo.toml --workspace --all-features
```

A native Linux ARM64 build loaded the local benchmark page in WebKitGTK under Xvfb.

The queue frontend tests exercise the controls and IPC acknowledgements using the repository's installed Playwright Chromium.

```sh
node --test experiments/rust-desktop/app/ui/controls.test.mjs
```

The [benchmark instructions](benchmark/README.md) describe the reproducible local comparison with a minimal Electron host. It measures identical local pages so the results isolate the browser hosts from plugin and network behavior.

### macOS baseline

Eight matched runs per host on Apple M5 Pro, macOS 27.2.1. Startup is measured through the same fixture's page-load event. RSS is sampled two seconds later.

| Host | Median startup | Median RSS |
| --- | ---: | ---: |
| Rust and WKWebView | 275 ms | 166 MiB |
| Electron 42.10.0 | 257 ms | 375 MiB |

The Rust RSS estimate includes the three WebKit services that appeared during each Rust trial. Attribution is based on process timing and user ID. Shared pages can count toward several processes. These results cover the original lightweight hosts rendering a fixture. The queue app uses two WebViews for controls and video, so it needs its own playback memory measurement.
