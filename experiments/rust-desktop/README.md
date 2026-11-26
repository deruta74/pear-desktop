# Pear Desktop Rust preview

Pear Desktop Rust Preview accepts individual YouTube links or IDs, keeps a local queue across launches, and opens the selected video in the official YouTube player. Playback starts from the player's own Play button.

## Run the macOS app

From the repository root, with Rust and the Xcode command-line tools available:

```sh
open "$(experiments/rust-desktop/tools/bundle-macos.sh preview)"
```

The script builds an ad hoc signed local app. The queue accepts YouTube and YouTube Music watch links, short links, Shorts, embed links and raw video IDs. Select a row or use the previous and next controls to switch videos. Move a row up or down to change playback order without restarting the current video. The queue saves video titles as it encounters them in the player and uses IDs until their titles are known. **Open in browser** opens the selected video's YouTube watch page. Use **View → Reload Player** to retry a slow or stopped player. **⌘L** focuses the link field and reveals the queue when hidden. **⇧⌘L** shows or hides the queue without interrupting the current video. The queue stores video IDs, known titles, and the selected entry in `~/Library/Application Support/com.pear-desktop.rust-preview/queue.json`.

To build for an Intel Mac, install the `x86_64-apple-darwin` Rust target and run `experiments/rust-desktop/tools/bundle-macos.sh preview x86_64-apple-darwin`. For Apple silicon, use `aarch64-apple-darwin`.

On first launch, choose **Open local audio** to play WAV, FLAC, MP3, Ogg Opus, and AAC-LC M4A files offline. Read the terms and privacy policy and choose **Agree and continue** to enable YouTube playback and lookups. **Help → Terms and Privacy** reopens the policy at any time. The local profile records the accepted policy revision.

Choose **Add links** and paste one link or ID per line to add several videos together. Enter submits, and Shift+Enter inserts a line. The queue skips duplicates and identifies invalid lines before saving the batch. Use **Filter queue** to find an entry by title or ID. Press Escape in the filter field to show the full queue again. **Play next** moves a queued video or adds a search result immediately after the current video while playback continues.

Use the arrows beside Pear to revisit earlier Queue, Search, Lyrics, and Library views. With the panel focused, press **⌘[** or **⌘]** on macOS, or **Alt+Left** or **Alt+Right** on Windows and Linux. Pear keeps up to 32 destinations for the current window session.

Select the title or artwork in **Now playing** to open Queue and reveal the current video. Pear keeps the active filter and leaves playback running.

On macOS, launch the bundled preview executable with `PEAR_PREVIEW_EXPERIMENTAL_PANEL_SWIPE=1` to try swiping left or right over the controls panel header. The experiment uses horizontal pixel-wheel input and follows the current system scroll direction. Keep focus out of text and playback controls while trying it. Native WebKit page swipes remain disabled.

Open **Library** to save the current queue as a local playlist. Open a saved playlist to rename it, choose a track, or add its tracks to the queue while the current video plays. The library stores playlists in `playlists.json` next to `queue.json`.

In **Queue**, choose **Add links**, then open **Play a YouTube playlist** and paste a public YouTube or YouTube Music playlist link. Choose **Play playlist in Pear**, then press Play in the visible YouTube player. This works without a YouTube Data API key. Use the embedded player’s controls for the playlist. Choose **Return to queue** to restore the selected queue video, or select another queue entry to switch directly. **Open in browser** opens the same playlist if playback is unavailable in Pear. On macOS, this feature uses the bundled app.

The local controls and the official player use separate private WebViews. Only the bundled controls can send queue commands to Rust. The player loads the selected embed with the native app's Referer and uses the website's controls and media requests. It can play videos whose owners allow embedding in the current region.

**Verified on macOS 27.2.1:** captured titles for two videos, reordered the queue while the first video continued playing, and restored the titles, order, and selection after reopening. The keyboard controls for hiding the queue and refocusing the link field also worked in the bundled app. The full YouTube Music site still reports an unsupported browser in WKWebView. The optional YouTube Data API account view uses the separate sign-in described below. Premium behavior and live audio plugins remain separate work.

### Experimental playback controls

On macOS and Linux, the player with integrated playback controls opens by default when the profile has no saved preferences. On Windows it remains opt-in. Choose **View → Experimental Playback Controls** to switch players. The selection reloads the current video and is remembered across launches. The command-line flag opens the player with integrated controls for the current launch.

```sh
app="$(experiments/rust-desktop/tools/bundle-macos.sh preview)"
"$app/Contents/MacOS/pear-desktop-preview" --iframe-player
```

On Linux and Windows, use the same `--iframe-player` flag through Cargo.

```sh
cargo run --locked --manifest-path experiments/rust-desktop/Cargo.toml -p pear-desktop-preview -- --iframe-player
```

Press Play in the visible YouTube player first. The queue panel then exposes pause, resume, and seeking through the official IFrame Player API. Press **Space** while the queue panel is focused outside an input or button to pause or resume. Both players share the local queue and playlists. The experimental player shows saved titles and looks up details for the selected video.

With the experimental player active, **View → Play Next Automatically** can advance the queue when the current video ends and the window is in the foreground. Enable **View → Repeat Queue** to return to the first video after the last when the queue has at least two videos. Both options start off. If YouTube blocks a transition, Pear opens the next video for you to start with its Play button.

**Volume controls** can adjust the embedded player before playback when YouTube exposes volume and mute. Pear remembers changes confirmed by the player and reapplies them when it opens another video.

**View → Playback Speed** lists the speeds supported for the current video.

After you start a queue video in the visible player, the system can offer play and pause through macOS Now Playing, Linux MPRIS, or Windows System Media Transport Controls. These controls remain available when the queue panel is hidden.

On macOS, the example video was paused, scrubbed to another position, and resumed from the queue panel. Automatic advance started the next video in the same player and saved it as the current item. On Ubuntu ARM64, the example video played and the Pear timeline advanced. The test window stayed ready while idle after adding a GTK timer for playback and request deadlines.

Windows uses the same local wrapper and a native WebView2 frame navigation guard. Playback and audio in this mode still need verification in an interactive Windows session.

### Synced lyrics

With integrated playback controls enabled, start the video and open **Lyrics**. Check the track name and artist, then select **Find lyrics**. Pear sends those two fields and the video duration to LRCLIB when you submit. Synced lines follow playback and highlight individual words where LRCLIB supplies timing. The animated dots appear during the current timed rest, and reduced motion keeps them still. Lyrics stay in memory and clear when you change the video. [LRCLIB API](https://lrclib.net/docs)

### Local audio and Slowed + Reverb

Choose **File → Open Local Audio Window**, then **Open audio files**, or drop up to 200 files into the Local Audio window. Select a track from the list or use Previous and Next. At the end of a playing track, Pear lets the effect tail finish and starts the next readable file. Use **Shuffle upcoming** to reorder tracks after the current one or **Clear upcoming** to remove them while playback continues. Choose **Repeat → Queue** to wrap to the beginning or **Repeat → Track** to replay the current file. The queue lasts for the current local audio session.

Pear streams mono or stereo integer PCM and IEEE float WAV, native FLAC with a known duration, MP3, single-stream Ogg Opus (`.opus` or `.ogg`), and AAC-LC in `.m4a` through the system’s default output. AAC support covers unencrypted, unfragmented files with one audio track, one media data section, and 1,024-sample AAC frames. Pear applies a single normal-speed MP4 edit or validated iTunes encoder delay and padding. It uses MP3 encoder delay and padding information when available and counts complete frames when the file lacks duration metadata. The window provides pause, seeking, volume, speed from 0.70× to 1.30×, and reverb with exact high-pass and low-pass inputs in hertz. Speed changes pitch. Volume, speed, and reverb settings carry across tracks and are restored the next time you open Local Audio.

You can also pass `--local-audio` to the executable. To preload a queue from the command line, follow it with file paths, for example `--local-audio "First track.wav" "Second track.opus"`. Local playback runs offline in a separate window and uses its own session. Press **Space** outside an input or button to pause or resume. The embedded YouTube player has its own playback controls.

Local Audio displays embedded title, artist, and album from MP3 ID3 tags and FLAC or Ogg Opus Vorbis comments. WAV, M4A, and untagged tracks use the filename. The player publishes the current track and available playback controls to macOS Now Playing, MPRIS on Linux, and Windows System Media Transport Controls.

Expand **Equalizer** to choose the 8-, 14- or 20-band layout, or add up to 64 custom peaking bands. In **Custom**, click the graph to add a point and drag it to set frequency and gain. The fields below the graph accept exact frequency, gain and Q values. **Auto preamp** adjusts attenuation for the active EQ curve and the local volume. Named presets are saved in the local audio profile so they can be loaded after restarting Pear.

Symphonia 0.6.1 handles FLAC, MP3, and AAC-LC in M4A, and symphonia-opus 0.1.3 decodes Opus. Both libraries use MPL 2.0. The ogg 0.9.2 library parses Ogg pages and packets under the BSD 3-Clause license. [Symphonia source](https://github.com/pdeljanov/Symphonia/tree/v0.6.1) · [symphonia-opus source](https://crates.io/crates/symphonia-opus/0.1.3) · [ogg source and license](https://docs.rs/crate/ogg/0.9.2/source/LICENSE)

<details>
<summary>ogg license notice</summary>

```text
Copyright (c) 2016-2017 est31 <MTest31@outlook.com> and contributors
Copyright (c) 2002-2015 Xiph.org Foundation

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

- Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.

- Redistributions in binary form must reproduce the above copyright
notice, this list of conditions and the following disclaimer in the
documentation and/or other materials provided with the distribution.

- Neither the name of the Xiph.org Foundation nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE FOUNDATION
OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

</details>

### Video details and optional search

Pear shows the title, channel and artwork for the selected video when YouTube supplies them. The public oEmbed lookup works without an API key.

To enable in-app search, enable YouTube Data API v3 in a Google Cloud project and create a developer key restricted to that API. Save the key on its own line in a private plain-text file. In Pear, choose **File → Set YouTube Data API Key File…**, select the file, and reopen Pear. Pear remembers the file location. To remove that setting, choose **File → Forget YouTube Data API Key File** and reopen Pear. [Google Cloud API key guide](https://cloud.google.com/docs/authentication/api-keys)

Pear uses the Data API for video details and music search. Select a result's title to open it in the Pear player, or use **Add** or **Play next** to queue it without interrupting the current video. Search requests use the configured project's API quota and run when you submit a query. Lookup results stay in memory and expire within a day. For development or testing, `PEAR_YOUTUBE_API_KEY_FILE` takes priority over the file selected in the menu. [YouTube Data API reference](https://developers.google.com/youtube/v3/docs/search/list)

With a key configured, paste a public YouTube or YouTube Music playlist link into Search. Choose **Load more** to request another page of up to 50 items. The list keeps the playlist order, including repeated tracks, and opens the video you choose in YouTube Music. **Add to queue** adds the loaded videos in order, skips duplicates, and keeps your current video playing. The preview can browse up to 500 playlist entries. Results expire in memory one day after the first page loads. [Playlist items API](https://developers.google.com/youtube/v3/docs/playlistItems/list)

Without a key, **Search** opens the submitted query or public playlist link in YouTube Music in the system browser. **File → Open in YouTube Music** opens the currently selected video there.

### Optional YouTube account Library

To enable **Library → YouTube account**, enable YouTube Data API v3 in a
Google Cloud project, configure its OAuth consent screen, and create an OAuth
client of type **Desktop app**. If the project is in testing, add the intended
Google Account as a test user. Download the Desktop client JSON to a private
location outside the repository. In Pear, choose **File → Set Google Desktop
OAuth Client File…**, select the JSON file, and reopen Pear. Pear remembers its
location. To remove the saved setting, choose **File → Forget Google Desktop
OAuth Client File** and reopen Pear. The API key used for public search is
independent of account access. [Google Desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app)

For development or testing, `PEAR_YOUTUBE_OAUTH_CLIENT_FILE` takes priority over
the file selected in the menu. On macOS, run the bundled executable directly to
pass the environment variable.

```sh
app="$(experiments/rust-desktop/tools/bundle-macos.sh preview)"
PEAR_YOUTUBE_OAUTH_CLIENT_FILE="/absolute/path/to/desktop-client.json" \
  "$app/Contents/MacOS/pear-desktop-preview"
```

On Linux or Windows, set the override in the shell that runs the preview.
In Pear, open **Library → YouTube account** and choose **Connect**.
Finish sign-in in your system browser to grant the read-only YouTube scope.
Use **Your playlists**, **Liked videos**, and **Next page** to browse your
collections. Selecting a playlist shows its videos. Selecting a video opens its
watch page in your browser.

Pear keeps account access and results in memory for the current session.
**Cancel sign-in** abandons an outstanding attempt. **Disconnect** clears the
account view immediately and asks Google to revoke access. If you quit during
sign-in or disconnect, Pear gives pending account cleanup up to 20 seconds.
If cleanup fails or times out, remove access under your Google Account
permissions. The account view clears when access expires or you quit Pear.
Connect again for a new session.
[Google Account permissions](https://myaccount.google.com/permissions)

## Run the queue on Linux or Windows

The preview opens the queue by default on Linux and Windows. To build it on Debian or Ubuntu, install `libgtk-3-dev`, `libwebkit2gtk-4.1-dev`, `libssl-dev`, `libasound2-dev`, a C toolchain and `pkg-config`. To build on Windows, use the MSVC Rust toolchain and a current Microsoft Edge WebView2 Evergreen Runtime. The app confirms that each native WebView2 controller started in InPrivate mode before loading its page.

```sh
cargo run --locked --manifest-path experiments/rust-desktop/Cargo.toml -p pear-desktop-preview
```

The queue file is `com.pear-desktop.rust-preview/queue.json` under `$XDG_DATA_HOME` (or `~/.local/share`) on Linux and under `%LOCALAPPDATA%` on Windows. To test with a fresh queue, set `PEAR_PREVIEW_QUEUE_DIR` to a separate absolute directory. **View → Hide Queue** and **File → Add Video** are available from the native menus.

On Ubuntu ARM64 with WebKitGTK 4.1, an Xvfb test confirmed the controls acknowledgement and title persistence. The example video played in the VM, with audio verified on a PulseAudio test sink. The isolated test queue and an ordinary queue ran at the same time on one GTK session bus. On a Windows x64 runner, the native WebView2 queue opened, completed the controls handshake, and reached the official embed in an onscreen window. The embed did not expose a visible Play control on that runner. Windows video and audio playback still need verification. [Windows verification run](https://github.com/deruta74/pear-desktop/actions/runs/45744454411)

The development build includes a separate system WebView compatibility probe:

```sh
cargo run --locked --manifest-path experiments/rust-desktop/Cargo.toml -p pear-desktop-preview --features benchmark -- --site-probe
```

### Official YouTube Embed probe

A separate macOS test app opens Google's documented example video in a visible WebKit player. The first navigation supplies the bundle identifier as an HTTPS Referer, as required for native clients. The probe uses a fresh site session and its navigation is scoped to that example video.

```sh
open "$(experiments/rust-desktop/tools/bundle-macos.sh embed)"
```

Click the player's **Play** button and confirm that the timer advances and **Pause** works. This test applies to the documented embeddable video. YouTube Music browsing, account sessions, Premium behavior, DRM, and availability of other titles require separate validation. [Google's client identification requirements](https://developers.google.com/youtube/terms/required-minimum-functionality#api-client-identity-and-credentials)

## Reverb and platform checks

Node 24 runs the checked-in JavaScript worklet as the reference for the Rust reverb port. The comparison checks both channels at 8, 44.1, 48 and 96 kHz, with changing intensity and different block sizes. The local audio window runs the reverb and EQ in the native output stream.

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

The Rust RSS estimate includes the three WebKit services that appeared during each Rust trial. Attribution is based on process timing and user ID. Shared pages can count toward several processes. These results cover lightweight hosts rendering a local fixture.

The bundled queue app at `efc9f2f5` was sampled separately on the same Mac with two WebViews and the official YouTube demo. Each phase reports the median of seven one-second samples.

| Queue app state | App process tree | Estimate including new WebKit services |
| --- | ---: | ---: |
| Video loaded before Play | 110 MiB | 399 MiB |
| Video playing | 116 MiB | 523 MiB |

The estimate includes four WebKit services observed after launch. Existing services are excluded, and memory pages shared by processes can be counted more than once.
