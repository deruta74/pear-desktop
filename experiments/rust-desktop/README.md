# Pear Desktop Rust preview

This experiment explores a Rust desktop client from the Pear Desktop 3.20.1 baseline. Tao provides the native window, Muda provides the desktop menu, and Wry hosts the page in the system WebView. The Rust reverb crate independently validates the audio processing that could be reused in a future player.

## Run the preview

From the repository root, with the Rust toolchain on your PATH:

```sh
cargo run --locked --manifest-path experiments/rust-desktop/Cargo.toml -p pear-desktop-preview
```

The preview opens a fresh session at `https://music.youtube.com/`. Its navigation policy permits that origin. The window exposes reload, quit, and **Open YouTube Music in Browser**. The website receives no application IPC, scripts or token access. On Windows the shell checks the WebView2 profile's InPrivate state before loading any site.

**Observed on macOS 27.2.1:** YouTube Music shows **Your browser is deprecated** in WKWebView. The shell opened successfully, but the site did not offer a playable track in that session. The browser command opens the normal website separately.

To build a local, ad hoc signed macOS bundle:

```sh
open "$(experiments/rust-desktop/tools/bundle-macos.sh preview)"
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

A native Linux ARM64 build loaded the local benchmark page in WebKitGTK under Xvfb. On macOS, the Windows x64 target passed `cargo check`. Windows runtime behavior and live Linux playback still require native tests.

The [benchmark instructions](benchmark/README.md) describe the reproducible local comparison with a minimal Electron host. It measures identical local pages so the results isolate the browser hosts from plugin and network behavior.

### macOS baseline

Eight matched runs per host on Apple M5 Pro, macOS 27.2.1. Startup is measured through the same fixture's page-load event. RSS is sampled two seconds later.

| Host | Median startup | Median RSS |
| --- | ---: | ---: |
| Rust and WKWebView | 275 ms | 166 MiB |
| Electron 42.10.0 | 257 ms | 375 MiB |

The Rust RSS estimate includes the three WebKit services that appeared during each Rust trial. Attribution is based on process timing and user ID. Shared pages can count toward several processes. These results cover lightweight hosts rendering a fixture and do not establish the memory or startup time of a full Pear Desktop replacement.
