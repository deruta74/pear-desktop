//! Local wrapper for the official YouTube IFrame API in the video pane.
#[cfg(target_os = "macos")]
use objc2_foundation::{NSBundle, NSString, NSURL};
use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "windows", test))]
use std::{borrow::Cow, cell::Cell};
use url::Url;
#[cfg(target_os = "linux")]
use webkit2gtk::WebViewExt as _;
use wry::WebView;
#[cfg(target_os = "macos")]
use wry::WebViewExtMacOS;
#[cfg(target_os = "linux")]
use wry::WebViewExtUnix;
#[cfg(any(target_os = "windows", test))]
use wry::http::{Method, Request, Response, StatusCode, header};

use super::platform::APP_ID;
use crate::{Result, library::valid_id};

const WRAPPER_PATH: &str = "/iframe-player.html";
#[cfg(any(target_os = "windows", test))]
pub(super) const WINDOWS_WRAPPER_SCHEME: &str = "com.pear-desktop";
const HTML: &str = include_str!("../../ui/iframe-player.html");
const MAX_SNAPSHOT_BYTES: usize = 768;
const MAX_VOLUME: u8 = 100;
const MAX_PLAYBACK_RATES: usize = 16;
// A generous bound for long-running live streams as well as ordinary videos.
const MAX_SECONDS: u32 = 31 * 24 * 60 * 60;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AudioOutput {
    #[serde(
        default,
        deserialize_with = "deserialize_volume",
        serialize_with = "serialize_volume"
    )]
    pub volume: Option<u8>,
    pub muted: Option<bool>,
}

fn deserialize_volume<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<u8>, D::Error> {
    let volume = Option::<u8>::deserialize(deserializer)?;
    if volume.is_some_and(|value| value > MAX_VOLUME) {
        return Err(serde::de::Error::custom(
            "Volume must be between 0 and 100.",
        ));
    }
    Ok(volume)
}

fn serialize_volume<S: serde::Serializer>(
    volume: &Option<u8>,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    if volume.is_some_and(|value| value > MAX_VOLUME) {
        return Err(serde::ser::Error::custom(
            "Volume must be between 0 and 100.",
        ));
    }
    volume.serialize(serializer)
}

pub(super) struct Page {
    embed_url: Url,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct PublicPlaylist(String);

impl PublicPlaylist {
    pub(super) fn from_link(source: &str) -> Result<Self> {
        // Keep the same accepted share-link forms as the Data API browser.
        super::metadata::playlist_id(source)
            .map(Self)
            .ok_or_else(|| "Enter a public YouTube or YouTube Music playlist link.".into())
    }

    pub(super) fn browser_url(&self) -> String {
        format!("https://www.youtube.com/playlist?list={}", self.0)
    }
}

impl Page {
    pub(super) fn new(id: &str) -> Result<Self> {
        if !valid_id(id) {
            return Err("Invalid YouTube video ID.".into());
        }
        let embed_url = Url::parse(&format!("https://www.youtube.com/embed/{id}"))?;
        Ok(Self::with_player_options(embed_url))
    }

    pub(super) fn playlist(playlist: &PublicPlaylist) -> Result<Self> {
        let mut embed_url = Url::parse("https://www.youtube.com/embed")?;
        embed_url
            .query_pairs_mut()
            .append_pair("listType", "playlist")
            .append_pair("list", &playlist.0);
        Ok(Self::with_player_options(embed_url))
    }

    fn with_player_options(mut embed_url: Url) -> Self {
        embed_url
            .query_pairs_mut()
            .append_pair("enablejsapi", "1")
            .append_pair("origin", &wrapper_origin())
            .append_pair("autoplay", "0");
        Self { embed_url }
    }

    #[cfg(not(target_os = "windows"))]
    pub(super) fn permits(&self, url: &str) -> bool {
        // On WebKit, Wry's callback covers child frames as well. The iframe sandbox
        // prohibits navigation from the player into the top-level document.
        self.permits_frame(url) || Self::is_wrapper_url(url)
    }

    pub(super) fn permits_frame(&self, url: &str) -> bool {
        url == "about:blank" || url == self.embed_url.as_str()
    }

    #[cfg(any(target_os = "windows", test))]
    pub(super) fn windows_top_level_navigation() -> impl Fn(String) -> bool {
        let loaded = Cell::new(false);
        move |url| match url.as_str() {
            "about:blank" => !loaded.get(),
            // A controller serves the HTML for its initial video. Pear's
            // Reload Player creates a new controller for the current video.
            _ => Self::is_wrapper_url(&url) && !loaded.replace(true),
        }
    }

    #[cfg(any(target_os = "windows", test))]
    pub(super) fn windows_wrapper_response(
        request: &Request<Vec<u8>>,
        html: &str,
    ) -> Response<Cow<'static, [u8]>> {
        // Wry maps scheme://host to https://scheme.host on WebView2, then
        // restores the original URI before invoking the asset handler.
        let uri = request.uri();
        if request.method() != Method::GET
            || uri.scheme_str() != Some(WINDOWS_WRAPPER_SCHEME)
            || uri.authority().map(|authority| authority.as_str()) != Some("rust-preview")
            || uri.path_and_query().map(|path| path.as_str()) != Some(WRAPPER_PATH)
        {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Cow::Borrowed(&[][..]))
                .expect("fixed error response");
        }
        Response::builder()
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .body(Cow::Owned(html.as_bytes().to_vec()))
            .expect("fixed wrapper response")
    }

    pub(super) fn is_wrapper_url(url: &str) -> bool {
        url == wrapper_url()
    }

    #[cfg(not(target_os = "windows"))]
    pub(super) fn load(&self, view: &WebView, output: AudioOutput) -> Result<()> {
        #[cfg(target_os = "macos")]
        if !NSBundle::mainBundle()
            .bundleIdentifier()
            .is_some_and(|id| id.to_string() == APP_ID)
        {
            return Err("The IFrame player requires the Pear Desktop macOS app bundle.".into());
        }

        let url = wrapper_url();
        let html = self.html(&url, output)?;
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

    pub(super) fn html(&self, url: &str, output: AudioOutput) -> Result<String> {
        if output.volume.is_some_and(|value| value > MAX_VOLUME) {
            return Err("The IFrame volume is out of range.".into());
        }
        let volume = output
            .volume
            .map(|value| value.to_string())
            .unwrap_or_default();
        let muted = output
            .muted
            .map_or("", |value| if value { "true" } else { "false" });
        Ok(HTML
            .replace("{WRAPPER_URL}", url)
            .replace("{INITIAL_VOLUME}", &volume)
            .replace("{INITIAL_MUTED}", muted)
            .replace("{EMBED_PATH}", self.embed_url.path())
            .replace(
                "{PLAYER_URL}",
                &self.embed_url.as_str().replace('&', "&amp;"),
            ))
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
        let command = action.command()?;
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
    #[cfg(any(target_os = "macos", target_os = "linux", test))]
    NativePlayback {
        expected_id: String,
        playing: bool,
    },
    Seek(u32),
    SetVolume(u8),
    SetMuted(bool),
    SetRate(f64),
    Advance {
        from: String,
        to: String,
    },
}

impl Action {
    fn command(self) -> Result<String> {
        Ok(match self {
            Self::Play => "window.pearIframePlayer?.play()".into(),
            Self::Pause => "window.pearIframePlayer?.pause()".into(),
            #[cfg(any(target_os = "macos", target_os = "linux", test))]
            Self::NativePlayback {
                expected_id,
                playing,
            } if valid_id(&expected_id) => {
                let method = if playing { "play" } else { "pause" };
                format!("window.pearIframePlayer?.{method}({expected_id:?})")
            }
            #[cfg(any(target_os = "macos", target_os = "linux", test))]
            Self::NativePlayback { .. } => return Err("Invalid YouTube video ID.".into()),
            Self::Seek(seconds) if seconds <= MAX_SECONDS => {
                format!("window.pearIframePlayer?.seek({seconds})")
            }
            Self::Seek(_) => return Err("The IFrame seek position is out of range.".into()),
            Self::SetVolume(volume) if volume <= MAX_VOLUME => {
                format!("window.pearIframePlayer?.setVolume({volume})")
            }
            Self::SetVolume(_) => return Err("The IFrame volume is out of range.".into()),
            Self::SetMuted(muted) => format!("window.pearIframePlayer?.setMuted({muted})"),
            Self::SetRate(rate) if valid_rate(rate) => {
                format!("window.pearIframePlayer?.setRate({rate})")
            }
            Self::SetRate(_) => return Err("The IFrame playback rate is out of range.".into()),
            Self::Advance { from, to } if from != to && valid_id(&from) && valid_id(&to) => {
                format!("window.pearIframePlayer?.advance({from:?},{to:?})")
            }
            Self::Advance { .. } => return Err("Invalid YouTube video IDs for advance.".into()),
        })
    }
}

fn valid_rate(rate: f64) -> bool {
    (0.25..=4.0).contains(&rate)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Snapshot {
    pub(super) ready: bool,
    pub(super) has_played: bool,
    pub(super) video_id: Option<String>,
    #[serde(default)]
    native_playback_confirmed: bool,
    #[serde(default)]
    pub(super) source_replayed: bool,
    #[serde(default, deserialize_with = "deserialize_volume")]
    pub(super) volume: Option<u8>,
    pub(super) muted: Option<bool>,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub(super) state: Option<i32>,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub(super) position: Option<u32>,
    pub(super) position_ms: Option<u32>,
    pub(super) playback_rate: Option<f64>,
    pub(super) playback_rates: Option<Vec<f64>>,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub(super) duration: Option<u32>,
    pub(super) ended: bool,
    // -1 denotes a failure in the local wrapper. Other values are YouTube errors.
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub(super) error: Option<i32>,
    pub(super) blocked: bool,
}

impl Snapshot {
    #[cfg(any(target_os = "macos", target_os = "linux", test))]
    pub(super) fn allows_playback_for(&self, expected_id: &str) -> bool {
        self.native_playback_confirmed
            && self.ready
            && self.has_played
            && self.video_id.as_deref() == Some(expected_id)
            && !self.blocked
            && self.error.is_none()
            && !self.source_replayed
    }

    pub(super) fn parse(json: &str) -> Option<Self> {
        if json.len() > MAX_SNAPSHOT_BYTES {
            return None;
        }
        let snapshot: Self = serde_json::from_str(json).ok()?;
        let has_playback = snapshot.has_played
            || snapshot.state.is_some()
            || snapshot.position.is_some()
            || snapshot.position_ms.is_some()
            || snapshot.playback_rate.is_some()
            || snapshot.duration.is_some();
        if snapshot
            .state
            .is_some_and(|state| !matches!(state, -1 | 0 | 1 | 2 | 3 | 5))
            || snapshot
                .video_id
                .as_deref()
                .is_some_and(|id| !valid_id(id) || !snapshot.ready)
            || (snapshot.native_playback_confirmed
                && (!snapshot.ready
                    || !snapshot.has_played
                    || snapshot.video_id.is_none()
                    || snapshot.blocked
                    || snapshot.error.is_some()
                    || snapshot.source_replayed))
            || snapshot
                .error
                .is_some_and(|error| !matches!(error, -1 | 2 | 5 | 100 | 101 | 150 | 153))
            || snapshot
                .position
                .is_some_and(|position| position > MAX_SECONDS)
            || snapshot.position_ms.is_some_and(|millis| {
                millis > MAX_SECONDS * 1000
                    || snapshot.position != Some(millis / 1000)
                    || snapshot
                        .duration
                        .is_some_and(|duration| millis > duration.saturating_mul(1000))
            })
            || snapshot.playback_rate.is_some_and(|rate| !valid_rate(rate))
            || snapshot.playback_rates.as_deref().is_some_and(|rates| {
                !snapshot.ready
                    || snapshot.blocked
                    || snapshot.error.is_some()
                    || snapshot.source_replayed
                    || rates.is_empty()
                    || rates.len() > MAX_PLAYBACK_RATES
                    || rates.iter().any(|&rate| !valid_rate(rate))
                    || rates.windows(2).any(|rates| rates[0] >= rates[1])
            })
            || snapshot
                .duration
                .is_some_and(|duration| !(1..=MAX_SECONDS).contains(&duration))
            || snapshot
                .position
                .zip(snapshot.duration)
                .is_some_and(|(position, duration)| position > duration)
            || (!snapshot.ready && has_playback)
            || ((!snapshot.ready || snapshot.error.is_some() || snapshot.source_replayed)
                && (snapshot.volume.is_some() || snapshot.muted.is_some()))
            || (snapshot.source_replayed
                && (!snapshot.ready
                    || snapshot.video_id.is_none()
                    || has_playback
                    || snapshot.error.is_some()))
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
    fn playlist_uses_only_the_validated_id_in_the_exact_embed_and_fallback_urls() {
        let playlist = PublicPlaylist::from_link(
            "https://music.youtube.com/playlist?list=PLC77007E23FF423C6&autoplay=1",
        )
        .unwrap();
        let expected = "https://www.youtube.com/embed?listType=playlist&list=PLC77007E23FF423C6&enablejsapi=1&origin=https%3A%2F%2Fcom.pear-desktop.rust-preview&autoplay=0";
        let page = Page::playlist(&playlist).unwrap();
        assert!(page.permits_frame(expected));
        assert!(!page.permits_frame(&format!("{expected}&autoplay=1")));
        assert!(!page.permits_frame(EMBED));
        assert!(
            page.html(WRAPPER, AudioOutput::default())
                .unwrap()
                .contains("frame-src https://www.youtube.com/embed;")
        );
        assert_eq!(
            playlist.browser_url(),
            "https://www.youtube.com/playlist?list=PLC77007E23FF423C6"
        );
        for invalid in [
            "https://youtube.com.evil.example/playlist?list=PLC77007E23FF423C6",
            "https://www.youtube.com/playlist?list=PLC77007E23FF423C6&list=PL0123456789",
            "https://www.youtube.com/watch?v=M7lc1UVf-VE",
        ] {
            assert!(PublicPlaylist::from_link(invalid).is_err(), "{invalid}");
        }
    }

    #[cfg(not(target_os = "windows"))]
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
    fn windows_serves_and_navigates_only_the_expected_wrapper_and_frame() {
        use wry::http::{Method, Request, StatusCode, header};

        let page = Page::new(ID).unwrap();
        let expected_asset = "com.pear-desktop://rust-preview/iframe-player.html";
        assert_eq!(
            expected_asset.replace(
                &format!("{WINDOWS_WRAPPER_SCHEME}://"),
                &format!("https://{WINDOWS_WRAPPER_SCHEME}."),
            ),
            wrapper_url(),
        );
        let html = page.html(WRAPPER, AudioOutput::default()).unwrap();
        let request = |method: Method, uri: &str| {
            Request::builder()
                .method(method)
                .uri(uri)
                .body(Vec::new())
                .unwrap()
        };
        let response = Page::windows_wrapper_response(&request(Method::GET, expected_asset), &html);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        assert_eq!(response.body().as_ref(), html.as_bytes());
        assert!(html.contains(&format!("data-wrapper-url=\"{WRAPPER}\"")));

        for (method, uri) in [
            (Method::POST, expected_asset),
            (Method::GET, "com.pear-desktop://rust-preview/"),
            (
                Method::GET,
                "com.pear-desktop://rust-preview/iframe-player.html?other",
            ),
            (
                Method::GET,
                "com.pear-desktop://rust-preview.evil.example/iframe-player.html",
            ),
            (Method::GET, WRAPPER),
        ] {
            let response = Page::windows_wrapper_response(&request(method, uri), &html);
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
            assert!(response.body().is_empty(), "{uri}");
        }

        assert!(page.permits_frame(EMBED));
        assert!(page.permits_frame("about:blank"));
        assert!(!page.permits_frame(WRAPPER));
        assert!(!page.permits_frame(&format!("{EMBED}&autoplay=1")));
        assert!(!page.permits_frame("https://www.youtube.com/watch?v=M7lc1UVf-VE"));

        let rebuilt = Page::new("dQw4w9WgXcQ").unwrap();
        assert!(!page.permits_frame(rebuilt.embed_url.as_str()));
        assert!(rebuilt.permits_frame(rebuilt.embed_url.as_str()));
        assert!(!rebuilt.permits_frame(EMBED));
    }

    #[test]
    fn windows_wrapper_allows_one_top_level_load_per_controller() {
        let navigate = Page::windows_top_level_navigation();
        assert!(navigate("about:blank".into()));
        assert!(!navigate(EMBED.into()));
        assert!(!navigate(format!("{WRAPPER}#other")));
        assert!(navigate(WRAPPER.into()));
        assert!(
            !navigate(WRAPPER.into()),
            "a native reload would replay the initial video"
        );
        assert!(!navigate("about:blank".into()));

        let rebuilt = Page::windows_top_level_navigation();
        assert!(rebuilt(WRAPPER.into()));
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
    fn validates_optional_video_identity_in_snapshots() {
        let with_id = |json: &str, id: Option<&str>| {
            let mut snapshot: serde_json::Value = serde_json::from_str(json).unwrap();
            snapshot["videoId"] = serde_json::json!(id);
            snapshot.to_string()
        };
        assert_eq!(Snapshot::parse(PLAYING).unwrap().video_id, None);
        assert_eq!(
            Snapshot::parse(&with_id(PLAYING, None)).unwrap().video_id,
            None
        );
        assert_eq!(
            Snapshot::parse(&with_id(PLAYING, Some(ID)))
                .unwrap()
                .video_id
                .as_deref(),
            Some(ID)
        );
        assert!(Snapshot::parse(&with_id(STARTING, Some(ID))).is_none());
        assert!(Snapshot::parse(&with_id(PLAYING, Some("M7lc1UVf!VE"))).is_none());
        assert!(Snapshot::parse(&with_id(PLAYING, Some("https://youtu.be/M7lc1UVf-VE"))).is_none());
    }

    #[test]
    fn native_playback_requires_confirmation_for_the_reported_video() {
        let mut sample: serde_json::Value = serde_json::from_str(PLAYING).unwrap();
        sample["videoId"] = serde_json::json!(ID);
        sample["state"] = serde_json::json!(2);
        let unconfirmed = Snapshot::parse(&sample.to_string()).unwrap();
        assert!(unconfirmed.has_played);
        assert!(!unconfirmed.allows_playback_for(ID));

        sample["nativePlaybackConfirmed"] = serde_json::json!(true);
        let confirmed = Snapshot::parse(&sample.to_string()).unwrap();
        assert!(confirmed.allows_playback_for(ID));
        assert!(!confirmed.allows_playback_for("jNQXAC9IVRw"));

        for (field, value) in [
            ("videoId", serde_json::Value::Null),
            ("hasPlayed", serde_json::json!(false)),
            ("blocked", serde_json::json!(true)),
            ("error", serde_json::json!(100)),
            ("sourceReplayed", serde_json::json!(true)),
        ] {
            let mut conflicting = sample.clone();
            conflicting[field] = value;
            assert!(
                Snapshot::parse(&conflicting.to_string()).is_none(),
                "{field}"
            );
        }
    }

    #[test]
    fn accepts_replay_signal_only_with_ready_identity_and_no_stale_state() {
        assert!(!Snapshot::parse(PLAYING).unwrap().source_replayed);

        let replay = serde_json::json!({
            "ready": true,
            "videoId": ID,
            "sourceReplayed": true,
            "hasPlayed": false,
            "state": null,
            "position": null,
            "duration": null,
            "ended": false,
            "error": null,
            "blocked": false,
        });
        assert!(
            Snapshot::parse(&replay.to_string())
                .unwrap()
                .source_replayed
        );
        for (key, value) in [
            ("videoId", serde_json::Value::Null),
            ("ready", serde_json::json!(false)),
            ("state", serde_json::json!(2)),
            ("hasPlayed", serde_json::json!(true)),
            ("position", serde_json::json!(1)),
            ("duration", serde_json::json!(20)),
            ("playbackRate", serde_json::json!(1.0)),
            ("error", serde_json::json!(100)),
        ] {
            let mut invalid = replay.clone();
            invalid[key] = value;
            assert!(Snapshot::parse(&invalid.to_string()).is_none(), "{key}");
        }
    }

    #[test]
    fn validates_and_renders_local_audio_output() {
        let configured = AudioOutput {
            volume: Some(0),
            muted: Some(false),
        };
        assert_eq!(
            serde_json::from_str::<AudioOutput>(r#"{"volume":0,"muted":false}"#).unwrap(),
            configured,
        );
        assert_eq!(
            serde_json::to_string(&configured).unwrap(),
            r#"{"volume":0,"muted":false}"#,
        );
        assert_eq!(
            serde_json::from_str::<AudioOutput>("{}").unwrap(),
            AudioOutput::default()
        );
        assert!(serde_json::from_str::<AudioOutput>(r#"{"volume":101}"#).is_err());
        assert!(serde_json::from_str::<AudioOutput>(r#"{"muted":true,"extra":0}"#).is_err());
        assert!(
            serde_json::to_string(&AudioOutput {
                volume: Some(101),
                muted: None
            })
            .is_err()
        );

        let page = Page::new(ID).unwrap();
        let html = page.html(WRAPPER, configured).unwrap();
        assert!(html.contains(r#"data-initial-volume="0" data-initial-muted="false""#));
        let html = page.html(WRAPPER, AudioOutput::default()).unwrap();
        assert!(html.contains(r#"data-initial-volume="" data-initial-muted="""#));
        assert!(
            page.html(
                WRAPPER,
                AudioOutput {
                    volume: Some(101),
                    muted: None
                }
            )
            .is_err()
        );
    }

    #[test]
    fn builds_bounded_audio_output_commands() {
        assert_eq!(
            Action::SetVolume(0).command().unwrap(),
            "window.pearIframePlayer?.setVolume(0)"
        );
        assert_eq!(
            Action::SetVolume(100).command().unwrap(),
            "window.pearIframePlayer?.setVolume(100)"
        );
        assert!(Action::SetVolume(101).command().is_err());
        assert_eq!(
            Action::SetMuted(false).command().unwrap(),
            "window.pearIframePlayer?.setMuted(false)"
        );
    }

    #[test]
    fn native_transport_commands_include_a_validated_expected_video_id() {
        let command = |expected_id: &str, playing| {
            Action::NativePlayback {
                expected_id: expected_id.into(),
                playing,
            }
            .command()
        };
        assert_eq!(
            command(ID, true).unwrap(),
            r#"window.pearIframePlayer?.play("M7lc1UVf-VE")"#,
        );
        assert_eq!(
            command(ID, false).unwrap(),
            r#"window.pearIframePlayer?.pause("M7lc1UVf-VE")"#,
        );
        assert!(command("M7lc1UVf-\"E", true).is_err());
        assert_eq!(
            Action::Play.command().unwrap(),
            "window.pearIframePlayer?.play()"
        );
        assert_eq!(
            Action::Pause.command().unwrap(),
            "window.pearIframePlayer?.pause()"
        );
    }

    #[test]
    fn builds_only_finite_bounded_playback_rate_commands() {
        assert_eq!(
            Action::SetRate(0.25).command().unwrap(),
            "window.pearIframePlayer?.setRate(0.25)"
        );
        assert_eq!(
            Action::SetRate(4.0).command().unwrap(),
            "window.pearIframePlayer?.setRate(4)"
        );
        for rate in [0.249, 4.001, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(Action::SetRate(rate).command().is_err());
        }
    }

    #[test]
    fn parses_only_bounded_distinct_playback_rates_when_available() {
        let mut snapshot: serde_json::Value = serde_json::from_str(STARTING).unwrap();
        assert!(
            Snapshot::parse(&snapshot.to_string())
                .unwrap()
                .playback_rates
                .is_none()
        );
        snapshot["playbackRates"] = serde_json::json!([0.25, 1, 4]);
        assert!(Snapshot::parse(&snapshot.to_string()).is_none());
        snapshot["ready"] = serde_json::json!(true);
        let rates = Snapshot::parse(&snapshot.to_string()).unwrap();
        assert!(!rates.has_played);
        assert_eq!(rates.playback_rates.as_deref(), Some(&[0.25, 1.0, 4.0][..]));
        assert!(rates.playback_rate.is_none());
        for (key, value) in [
            ("blocked", serde_json::json!(true)),
            ("error", serde_json::json!(100)),
            ("playbackRates", serde_json::json!([])),
            ("playbackRates", serde_json::json!([0.249, 1])),
            ("playbackRates", serde_json::json!([1, 4.001])),
            ("playbackRates", serde_json::json!([1, 0.5])),
            ("playbackRates", serde_json::json!([1, 1])),
            (
                "playbackRates",
                serde_json::json!(
                    (0..17)
                        .map(|step| 0.25 + f64::from(step) / 8.0)
                        .collect::<Vec<_>>()
                ),
            ),
        ] {
            let mut invalid = snapshot.clone();
            invalid[key] = value;
            assert!(Snapshot::parse(&invalid.to_string()).is_none(), "{key}");
        }
    }

    #[test]
    fn accepts_full_playback_rate_lists_alongside_existing_telemetry() {
        let mut snapshot: serde_json::Value = serde_json::from_str(PLAYING).unwrap();
        let rates: Vec<_> = (1..=16)
            .map(|offset| 0.25 + f64::from(offset) * f64::EPSILON)
            .collect();
        snapshot["playbackRates"] = serde_json::json!(rates);
        snapshot["videoId"] = serde_json::json!(ID);
        snapshot["sourceReplayed"] = serde_json::json!(false);
        snapshot["positionMs"] = serde_json::json!(172_345);
        snapshot["playbackRate"] = serde_json::json!(0.25);
        snapshot["volume"] = serde_json::json!(37);
        snapshot["muted"] = serde_json::json!(false);
        let sampled = Snapshot::parse(&snapshot.to_string()).unwrap();
        assert_eq!(sampled.playback_rates.unwrap().len(), 16);
        assert_eq!(sampled.playback_rate, Some(0.25));
        assert_eq!(sampled.position_ms, Some(172_345));
    }

    #[test]
    fn parses_audio_output_without_first_play_and_rejects_stale_output() {
        let mut snapshot: serde_json::Value = serde_json::from_str(STARTING).unwrap();
        let old = Snapshot::parse(&snapshot.to_string()).unwrap();
        assert_eq!((old.volume, old.muted), (None, None));
        snapshot["volume"] = serde_json::json!(37);
        snapshot["muted"] = serde_json::json!(false);
        assert!(Snapshot::parse(&snapshot.to_string()).is_none());
        snapshot["ready"] = serde_json::json!(true);
        let audio = Snapshot::parse(&snapshot.to_string()).unwrap();
        assert!(!audio.has_played);
        assert_eq!((audio.volume, audio.muted), (Some(37), Some(false)));
        snapshot["error"] = serde_json::json!(100);
        assert!(Snapshot::parse(&snapshot.to_string()).is_none());
        snapshot["error"] = serde_json::Value::Null;
        snapshot["volume"] = serde_json::json!(101);
        assert!(Snapshot::parse(&snapshot.to_string()).is_none());
    }

    #[test]
    fn builds_advance_commands_only_for_distinct_valid_ids() {
        let command = |from: &str, to: &str| {
            Action::Advance {
                from: from.into(),
                to: to.into(),
            }
            .command()
        };
        assert_eq!(
            command(ID, "jNQXAC9IVRw").unwrap(),
            r#"window.pearIframePlayer?.advance("M7lc1UVf-VE","jNQXAC9IVRw")"#,
        );
        assert!(command("not a video", ID).is_err());
        assert!(command(ID, "jNQXAC9IVR\"").is_err());
        assert!(command(ID, ID).is_err());
    }

    #[test]
    fn accepts_millisecond_samples_only_when_they_agree_with_the_timeline() {
        let sample = |millis: u32| {
            PLAYING.replace(
                "\"position\":172",
                &format!("\"position\":172,\"positionMs\":{millis}"),
            )
        };
        assert_eq!(
            Snapshot::parse(&sample(172_345)).unwrap().position_ms,
            Some(172_345)
        );
        assert!(Snapshot::parse(&sample(171_999)).is_none());
        assert!(
            Snapshot::parse(&sample(172_001).replace("\"duration\":320", "\"duration\":172"))
                .is_none()
        );
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
