use std::{fs::File, io::Read, path::Path, time::Duration};

use serde::{Deserialize, Serialize};
use ureq::{
    Agent, Body,
    http::{HeaderValue, header},
    tls::{RootCerts, TlsConfig, TlsProvider},
};

use crate::library::valid_id;

const VIDEOS_ENDPOINT: &str = "https://www.googleapis.com/youtube/v3/videos";
const MAX_BODY_BYTES: u64 = 16 * 1024;
const MAX_FIELD_CHARS: usize = 180;
const MAX_KEY_FILE_BYTES: u64 = 512;

#[derive(Clone)]
pub(super) struct Client {
    agent: Agent,
    api_key: Option<HeaderValue>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub(super) struct Metadata {
    pub(super) title: String,
    pub(super) channel: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum LookupError {
    InvalidVideoId,
    InvalidKey,
    InvalidKeyConfiguration,
    QuotaExceeded,
    Throttled,
    Network,
    InvalidResponse,
    Service,
}

impl Client {
    pub(super) fn from_env() -> Option<Self> {
        let path = std::env::var_os("PEAR_YOUTUBE_API_KEY_FILE")?;
        let api_key = read_key_file(Path::new(&path));
        let agent = Agent::config_builder()
            .https_only(true)
            .proxy(None)
            .max_redirects(0)
            .timeout_connect(Some(Duration::from_secs(3)))
            .timeout_global(Some(Duration::from_secs(5)))
            .http_status_as_error(false)
            .tls_config(
                TlsConfig::builder()
                    .provider(TlsProvider::NativeTls)
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .build()
            .new_agent();

        Some(Self { agent, api_key })
    }

    pub(super) fn lookup(&self, id: &str) -> Result<Option<Metadata>, LookupError> {
        if !valid_id(id) {
            return Err(LookupError::InvalidVideoId);
        }
        let api_key = self
            .api_key
            .clone()
            .ok_or(LookupError::InvalidKeyConfiguration)?;
        let mut response = self
            .agent
            .get(VIDEOS_ENDPOINT)
            .query("part", "snippet,id")
            .query("id", id)
            .query("fields", "items(id,snippet(title,channelTitle))")
            .header(header::ACCEPT, "application/json")
            .header("x-goog-api-key", api_key)
            .call()
            .map_err(transport_error)?;

        interpret_response(response.status().as_u16(), response.body_mut(), id)
    }
}

fn read_key_file(path: &Path) -> Option<HeaderValue> {
    let metadata = path.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_KEY_FILE_BYTES {
        return None;
    }
    key_header(File::open(path).ok()?)
}

fn key_header(reader: impl Read) -> Option<HeaderValue> {
    let mut value = String::new();
    reader
        .take(MAX_KEY_FILE_BYTES + 1)
        .read_to_string(&mut value)
        .ok()?;
    if value.len() as u64 > MAX_KEY_FILE_BYTES {
        return None;
    }
    let key = value.trim();
    if key.is_empty()
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return None;
    }
    let mut header = HeaderValue::from_str(key).ok()?;
    header.set_sensitive(true);
    Some(header)
}

#[derive(Deserialize)]
struct VideoList {
    items: Vec<VideoItem>,
}

#[derive(Deserialize)]
struct VideoItem {
    id: String,
    snippet: VideoSnippet,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoSnippet {
    title: String,
    channel_title: String,
}

#[derive(Deserialize)]
struct ApiError {
    error: ApiErrorDetails,
}

#[derive(Deserialize)]
struct ApiErrorDetails {
    status: Option<String>,
    #[serde(default)]
    errors: Vec<ApiErrorReason>,
    #[serde(default)]
    details: Vec<ApiErrorReason>,
}

#[derive(Deserialize)]
struct ApiErrorReason {
    reason: Option<String>,
}

fn interpret_response(
    status: u16,
    body: &mut Body,
    id: &str,
) -> Result<Option<Metadata>, LookupError> {
    match status {
        200 | 400 | 403 | 404 => {}
        401 => return Err(LookupError::InvalidKey),
        429 => return Err(LookupError::Throttled),
        _ => return Err(LookupError::Service),
    }

    if !body
        .mime_type()
        .is_some_and(|mime| mime.eq_ignore_ascii_case("application/json"))
    {
        return Err(if status == 200 {
            LookupError::InvalidResponse
        } else {
            LookupError::Service
        });
    }
    let bytes = body
        .with_config()
        .limit(MAX_BODY_BYTES)
        .read_to_vec()
        .map_err(transport_error)?;
    if status != 200 {
        return classify_api_error(status, &bytes);
    }

    let list: VideoList =
        serde_json::from_slice(&bytes).map_err(|_| LookupError::InvalidResponse)?;
    match list.items.as_slice() {
        [] => Ok(None),
        [item] if item.id == id => Ok(Some(Metadata {
            title: display_field(&item.snippet.title)?,
            channel: display_field(&item.snippet.channel_title)?,
        })),
        _ => Err(LookupError::InvalidResponse),
    }
}

fn classify_api_error(status: u16, bytes: &[u8]) -> Result<Option<Metadata>, LookupError> {
    let response: ApiError = serde_json::from_slice(bytes).map_err(|_| LookupError::Service)?;
    let reasons = response
        .error
        .errors
        .iter()
        .chain(&response.error.details)
        .filter_map(|item| item.reason.as_deref())
        .chain(response.error.status.as_deref());
    for reason in reasons {
        match reason {
            "videoNotFound" if status == 404 => return Ok(None),
            "API_KEY_INVALID"
            | "API_KEY_EXPIRED"
            | "API_KEY_SERVICE_BLOCKED"
            | "API_KEY_HTTP_REFERRER_BLOCKED"
            | "API_KEY_IP_ADDRESS_BLOCKED"
            | "API_KEY_ANDROID_APP_BLOCKED"
            | "API_KEY_IOS_APP_BLOCKED"
            | "SERVICE_DISABLED"
            | "accessNotConfigured"
            | "keyInvalid"
            | "keyExpired"
            | "ipRefererBlocked" => return Err(LookupError::InvalidKey),
            "quotaExceeded" | "dailyLimitExceeded" => return Err(LookupError::QuotaExceeded),
            "rateLimitExceeded"
            | "userRateLimitExceeded"
            | "RATE_LIMIT_EXCEEDED"
            | "RESOURCE_EXHAUSTED" => return Err(LookupError::Throttled),
            _ => {}
        }
    }
    Err(LookupError::Service)
}

fn display_field(value: &str) -> Result<String, LookupError> {
    let cleaned: String = value
        .chars()
        .filter(|&ch| {
            (ch.is_whitespace() || !ch.is_control())
                && !matches!(ch, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .collect();
    let normalized = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return Err(LookupError::InvalidResponse);
    }
    let end = normalized
        .char_indices()
        .nth(MAX_FIELD_CHARS)
        .map_or(normalized.len(), |(index, _)| index);
    Ok(normalized[..end].trim_end().to_owned())
}

fn transport_error(error: ureq::Error) -> LookupError {
    match error {
        ureq::Error::BodyExceedsLimit(_)
        | ureq::Error::Decompress(_, _)
        | ureq::Error::LargeResponseHeader(_, _)
        | ureq::Error::Protocol(_) => LookupError::InvalidResponse,
        _ => LookupError::Network,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VIDEO_ID: &str = "dQw4w9WgXcQ";

    fn response(status: u16, json: impl Into<Vec<u8>>) -> Result<Option<Metadata>, LookupError> {
        let mut body = ureq::Body::builder()
            .mime_type("application/json")
            .data(json);
        interpret_response(status, &mut body, VIDEO_ID)
    }

    #[test]
    fn rejects_a_result_for_a_different_video() {
        let json = br#"{"items":[{"id":"jNQXAC9IVRw","snippet":{"title":"Title","channelTitle":"Channel"}}]}"#;
        assert_eq!(response(200, json), Err(LookupError::InvalidResponse));
    }

    #[test]
    fn treats_an_empty_item_list_as_absent() {
        assert_eq!(response(200, br#"{"items":[]}"#), Ok(None));
    }

    #[test]
    fn rejects_a_body_larger_than_the_json_limit() {
        let mut json = br#"{"items":[]}"#.to_vec();
        json.resize(16 * 1024 + 1, b' ');
        assert_eq!(response(200, json), Err(LookupError::InvalidResponse));
    }

    #[test]
    fn bounds_display_fields_at_unicode_character_boundaries() {
        let json = serde_json::json!({
            "items": [{"id": VIDEO_ID, "snippet": {
                "title": "界".repeat(181), "channelTitle": "音".repeat(181),
            }}],
        });
        let metadata = response(200, json.to_string()).unwrap().unwrap();
        assert_eq!(metadata.title, "界".repeat(180));
        assert_eq!(metadata.channel, "音".repeat(180));
    }

    #[test]
    fn removes_display_controls_from_a_matching_result() {
        let json = br#"{"items":[{"id":"dQw4w9WgXcQ","snippet":{"title":"  Title\n with\u202e text\u0000  ","channelTitle":" Channel\tName "}}]}"#;
        assert_eq!(
            response(200, json),
            Ok(Some(Metadata {
                title: "Title with text".into(),
                channel: "Channel Name".into(),
            }))
        );
    }

    #[test]
    fn rejects_a_success_body_with_the_wrong_shape() {
        assert_eq!(response(200, br#"{}"#), Err(LookupError::InvalidResponse));
    }

    #[test]
    fn classifies_http_failures_without_returning_service_diagnostics() {
        let invalid_key = br#"{"error":{"code":400,"message":"opaque credential diagnostics","errors":[{"reason":"badRequest"}],"details":[{"reason":"API_KEY_INVALID"},{}]}}"#;
        let quota = br#"{"error":{"code":403,"errors":[{"reason":"quotaExceeded"}]}}"#;
        let throttled = br#"{"error":{"code":403,"errors":[{"reason":"userRateLimitExceeded"}]}}"#;
        let not_found = br#"{"error":{"code":404,"errors":[{"reason":"videoNotFound"}]}}"#;
        assert_eq!(response(400, invalid_key), Err(LookupError::InvalidKey));
        assert_eq!(response(403, quota), Err(LookupError::QuotaExceeded));
        assert_eq!(response(404, not_found), Ok(None));
        assert_eq!(response(429, b""), Err(LookupError::Throttled));
        assert_eq!(response(403, throttled), Err(LookupError::Throttled));
        assert_eq!(response(302, b""), Err(LookupError::Service));
        assert_eq!(response(503, b""), Err(LookupError::Service));
    }

    #[test]
    fn classifies_network_timeouts_without_diagnostics() {
        assert_eq!(
            transport_error(ureq::Error::Timeout(ureq::Timeout::Global)),
            LookupError::Network
        );
    }

    #[test]
    fn reads_a_bounded_key_as_a_sensitive_header() {
        let key = key_header(&b" synthetic-key_123\r\n"[..]).unwrap();
        assert!(key.is_sensitive());
        assert_eq!(key.as_bytes(), b"synthetic-key_123");
        assert!(key_header(&b"secret\nother-header: value"[..]).is_none());
        assert!(key_header(&b" "[..]).is_none());
        assert!(key_header(vec![b'a'; MAX_KEY_FILE_BYTES as usize + 1].as_slice()).is_none());
    }
}
