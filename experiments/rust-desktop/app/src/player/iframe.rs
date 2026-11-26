//! Local wrapper for the official YouTube IFrame API in the video pane.
#[cfg(target_os = "macos")]
use objc2_foundation::{NSBundle, NSString, NSURL};
use serde::Deserialize;
use url::Url;
#[cfg(target_os = "linux")]
use webkit2gtk::WebViewExt as _;
use wry::WebView;
#[cfg(target_os = "macos")]
use wry::WebViewExtMacOS;
#[cfg(target_os = "linux")]
use wry::WebViewExtUnix;

use super::platform::APP_ID;
use crate::{Result, library::valid_id};

const WRAPPER_PATH: &str = "/iframe-player.html";
const HTML: &str = include_str!("../../ui/iframe-player.html");
const MAX_SNAPSHOT_BYTES: usize = 512;
// A generous bound for long-running live streams as well as ordinary videos.
const MAX_SECONDS: u32 = 31 * 24 * 60 * 60;

pub(super) struct Page {
    embed_url: Url,
}

impl Page {
    pub(super) fn new(id: &str) -> Result<Self> {
        if !valid_id(id) {
            return Err("Invalid YouTube video ID.".into());
        }
        let mut embed_url = Url::parse(&format!("https://www.youtube.com/embed/{id}"))?;
        embed_url
            .query_pairs_mut()
            .append_pair("enablejsapi", "1")
            .append_pair("origin", &wrapper_origin())
            .append_pair("autoplay", "0");
        Ok(Self { embed_url })
    }

    pub(super) fn permits(&self, url: &str) -> bool {
        // Wry's callback covers child frames as well. The iframe sandbox
        // prohibits navigation from the player into the top-level document.
        url == "about:blank" || url == self.embed_url.as_str() || Self::is_wrapper_url(url)
    }

    pub(super) fn is_wrapper_url(url: &str) -> bool {
        url == wrapper_url()
    }

    pub(super) fn load(&self, view: &WebView) -> Result<()> {
        #[cfg(target_os = "macos")]
        if !NSBundle::mainBundle()
            .bundleIdentifier()
            .is_some_and(|id| id.to_string() == APP_ID)
        {
            return Err("The IFrame player requires the Pear Desktop macOS app bundle.".into());
        }

        let url = wrapper_url();
        let html = HTML
            .replace("{WRAPPER_URL}", &url)
            .replace("{EMBED_PATH}", self.embed_url.path())
            .replace(
                "{PLAYER_URL}",
                &self.embed_url.as_str().replace('&', "&amp;"),
            );
        #[cfg(target_os = "macos")]
        {
            let base = NSURL::URLWithString(&NSString::from_str(&url))
                .ok_or("Could not create the local IFrame player URL.")?;
            // The WebView belongs to the main thread. This loads the bundled
            // document locally, with the HTTPS origin verified against APP_ID.
            let navigation = unsafe {
                view.webview()
                    .loadHTMLString_baseURL(&NSString::from_str(&html), Some(&base))
            };
            if navigation.is_none() {
                return Err("WKWebView could not load the local IFrame player.".into());
            }
        }
        #[cfg(target_os = "linux")]
        // WebKitGTK uses the HTTPS base for the local wrapper's origin and Referer.
        view.webview().load_html(&html, Some(&url));

        Ok(())
    }

    // Start polling only after Wry reports the navigation committed.
    pub(super) fn observe(
        view: &WebView,
        callback: impl Fn(String) + Send + 'static,
    ) -> Result<()> {
        if !is_wrapper(view) {
            callback("null".into());
            return Ok(());
        }
        let script = wrapper_eval("window.pearIframePlayer?.snapshot() ?? null");
        view.evaluate_script_with_callback(&script, callback)?;
        Ok(())
    }

    pub(super) fn perform(view: &WebView, action: Action) -> Result<()> {
        if !is_wrapper(view) {
            return Err("The local IFrame player is unavailable.".into());
        }
        let command = match action {
            Action::Play => "window.pearIframePlayer?.play()".into(),
            Action::Pause => "window.pearIframePlayer?.pause()".into(),
            Action::Seek(seconds) if seconds <= MAX_SECONDS => {
                format!("window.pearIframePlayer?.seek({seconds})")
            }
            Action::Seek(_) => return Err("The IFrame seek position is out of range.".into()),
        };
        view.evaluate_script(&wrapper_eval(&command))?;
        Ok(())
    }
}

fn wrapper_origin() -> String {
    format!("https://{APP_ID}")
}

pub(super) fn wrapper_url() -> String {
    format!("{}{WRAPPER_PATH}", wrapper_origin())
}

fn is_wrapper(view: &WebView) -> bool {
    view.url().is_ok_and(|url| Page::is_wrapper_url(&url))
}

fn wrapper_eval(script: &str) -> String {
    let origin = wrapper_origin();
    let url = wrapper_url();
    format!(
        "self === top && self.origin === {origin:?} && document.URL === {url:?} && document.baseURI === {url:?} ? ({script}) : null"
    )
}

pub(super) enum Action {
    Play,
    Pause,
    Seek(u32),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Snapshot {
    pub(super) ready: bool,
    pub(super) has_played: bool,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub(super) state: Option<i32>,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub(super) position: Option<u32>,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub(super) duration: Option<u32>,
    pub(super) ended: bool,
    // -1 denotes a failure in the local wrapper. Other values are YouTube errors.
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub(super) error: Option<i32>,
    pub(super) blocked: bool,
}

impl Snapshot {
    pub(super) fn parse(json: &str) -> Option<Self> {
        if json.len() > MAX_SNAPSHOT_BYTES {
            return None;
        }
        let snapshot: Self = serde_json::from_str(json).ok()?;
        if snapshot
            .state
            .is_some_and(|state| !matches!(state, -1 | 0 | 1 | 2 | 3 | 5))
            || snapshot
                .error
                .is_some_and(|error| !matches!(error, -1 | 2 | 5 | 100 | 101 | 150 | 153))
            || snapshot
                .position
                .is_some_and(|position| position > MAX_SECONDS)
            || snapshot
                .duration
                .is_some_and(|duration| !(1..=MAX_SECONDS).contains(&duration))
            || snapshot
                .position
                .zip(snapshot.duration)
                .is_some_and(|(position, duration)| position > duration)
            || (!snapshot.ready
                && (snapshot.has_played
                    || snapshot.state.is_some()
                    || snapshot.position.is_some()
                    || snapshot.duration.is_some()))
            || (snapshot.state == Some(1) && (!snapshot.has_played || snapshot.ended))
            || (snapshot.ended && !snapshot.has_played)
        {
            return None;
        }
        Some(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "M7lc1UVf-VE";
    const EMBED: &str = "https://www.youtube.com/embed/M7lc1UVf-VE?enablejsapi=1&origin=https%3A%2F%2Fcom.pear-desktop.rust-preview&autoplay=0";
    const WRAPPER: &str = "https://com.pear-desktop.rust-preview/iframe-player.html";
    const PLAYING: &str = r#"{"ready":true,"hasPlayed":true,"state":1,"position":172,"duration":320,"ended":false,"error":null,"blocked":false}"#;
    const STARTING: &str = r#"{"ready":false,"hasPlayed":false,"state":null,"position":null,"duration":null,"ended":false,"error":null,"blocked":false}"#;

    #[test]
    fn permits_only_the_local_wrapper_and_its_exact_player_url() {
        let page = Page::new(ID).unwrap();
        for url in ["about:blank", WRAPPER, EMBED] {
            assert!(page.permits(url), "{url}");
        }
        assert!(Page::is_wrapper_url(WRAPPER));
        assert!(!Page::is_wrapper_url(EMBED));
        assert!(!Page::is_wrapper_url("about:blank"));
        assert!(!Page::is_wrapper_url(&format!("{WRAPPER}#other")));
        for url in [
            "https://www.youtube.com/embed/M7lc1UVf-VE",
            "https://www.youtube.com/embed/dQw4w9WgXcQ",
            "https://www.youtube.com/iframe_api",
            "https://www.youtube.com/watch?v=M7lc1UVf-VE",
            "https://www.youtube.com.evil.example/embed/M7lc1UVf-VE",
            "https://www.youtube.com@evil.example/embed/M7lc1UVf-VE",
            "https://com.pear-desktop.rust-preview/",
            "file:///iframe-player.html",
            &format!("{WRAPPER}#other"),
            &format!("{EMBED}&autoplay=1"),
        ] {
            assert!(!page.permits(url), "{url}");
        }
    }

    #[test]
    fn rejects_invalid_video_ids_before_constructing_the_page() {
        for id in [
            "",
            "short",
            "M7lc1UVf-VE&autoplay=1",
            "M7lc1UVf/VE",
            "M7lc1UVf<VE",
        ] {
            assert!(Page::new(id).is_err(), "{id}");
        }
    }

    #[test]
    fn parses_only_known_snapshot_values() {
        let playing = Snapshot::parse(PLAYING).unwrap();
        assert!(playing.ready && playing.has_played);
        assert_eq!(playing.state, Some(1));
        assert_eq!(playing.position, Some(172));
        assert_eq!(playing.duration, Some(320));
        assert!(!playing.ended && !playing.blocked);
        assert_eq!(playing.error, None);

        let starting = Snapshot::parse(STARTING).unwrap();
        assert!(!starting.ready && !starting.has_played);
        assert_eq!(starting.state, None);
        assert_eq!(
            Snapshot::parse(&STARTING.replace("\"error\":null", "\"error\":153"))
                .unwrap()
                .error,
            Some(153)
        );
        let ended = PLAYING
            .replace("\"state\":1", "\"state\":0")
            .replace("\"ended\":false", "\"ended\":true");
        assert!(Snapshot::parse(&ended).unwrap().ended);
    }

    #[test]
    fn rejects_malformed_or_out_of_bounds_snapshots() {
        for json in [
            "".to_owned(),
            "null".to_owned(),
            " ".repeat(1024) + PLAYING,
            PLAYING.replace(",\"error\":null", ""),
            PLAYING.replace("\"error\":null", "\"error\":404"),
            PLAYING.replace("\"state\":1", "\"state\":4"),
            PLAYING.replace("\"duration\":320", "\"duration\":4294967295"),
            PLAYING.replace("\"position\":172", "\"position\":-1"),
            PLAYING.replace("\"position\":172", "\"position\":321"),
            PLAYING.replace("\"ready\":true", "\"ready\":false"),
            PLAYING.replace("\"ended\":false", "\"ended\":true"),
            PLAYING.replace(
                "\"error\":null",
                "\"error\":null,\"message\":\"extra field\"",
            ),
            STARTING.replace("\"ended\":false", "\"ended\":true"),
        ] {
            assert!(Snapshot::parse(&json).is_none(), "{json}");
        }
    }
}
