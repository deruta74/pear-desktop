use std::{fs::File, io::Read, path::Path, time::Duration};

use serde::{Deserialize, Serialize};
use ureq::{
    Agent, Body, RequestBuilder,
    http::{HeaderValue, header},
    tls::{RootCerts, TlsConfig, TlsProvider},
    typestate::WithoutBody,
};

use crate::library::valid_id;

const VIDEOS_ENDPOINT: &str = "https://www.googleapis.com/youtube/v3/videos";
const SEARCH_ENDPOINT: &str = "https://www.googleapis.com/youtube/v3/search";
const EMBED_ENDPOINT: &str = "https://www.youtube.com/oembed";
const MAX_VIDEO_BODY_BYTES: u64 = 16 * 1024;
const MAX_SEARCH_BODY_BYTES: u64 = 48 * 1024;
const MAX_SEARCH_QUERY_CHARS: usize = 160;
const MAX_SEARCH_RESULTS: usize = 12;
const MAX_FIELD_CHARS: usize = 180;
const MAX_KEY_FILE_BYTES: u64 = 512;

#[derive(Clone)]
pub(super) struct Client {
    agent: Agent,
    source: Source,
}

#[derive(Clone)]
enum Source {
    DataApi(Option<HeaderValue>),
    PublicEmbed,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub(super) struct Metadata {
    pub(super) title: String,
    pub(super) channel: String,
    #[serde(rename = "thumbnailUrl", skip_serializing_if = "Option::is_none")]
    pub(super) thumbnail_url: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub(super) struct SearchResult {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) channel: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum LookupError {
    InvalidVideoId,
    InvalidQuery,
    InvalidKey,
    InvalidKeyConfiguration,
    QuotaExceeded,
    Throttled,
    Network,
    InvalidResponse,
    Service,
}

impl Client {
    pub(super) fn public_embed() -> Self {
        Self::new(Source::PublicEmbed)
    }

    pub(super) fn from_env() -> Option<Self> {
        let path = std::env::var_os("PEAR_YOUTUBE_API_KEY_FILE")?;
        let api_key = read_key_file(Path::new(&path));
        Some(Self::new(Source::DataApi(api_key)))
    }

    fn new(source: Source) -> Self {
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

        Self { agent, source }
    }

    pub(super) fn lookup(&self, id: &str) -> Result<Option<Metadata>, LookupError> {
        if !valid_id(id) {
            return Err(LookupError::InvalidVideoId);
        }
        if matches!(self.source, Source::PublicEmbed) {
            let watch_url = format!("https://www.youtube.com/watch?v={id}");
            let mut response = self
                .json_request(EMBED_ENDPOINT, &[("url", &watch_url), ("format", "json")])
                .call()
                .map_err(transport_error)?;
            return interpret_embed_response(response.status().as_u16(), response.body_mut(), id);
        }
        let mut response = self.data_api_get(
            VIDEOS_ENDPOINT,
            &[
                ("part", "snippet,id"),
                ("id", id),
                (
                    "fields",
                    "items(id,snippet(title,channelTitle,thumbnails/high/url))",
                ),
            ],
        )?;
        interpret_response(response.status().as_u16(), response.body_mut(), id)
    }

    pub(super) fn search(&self, query: &str) -> Result<Vec<SearchResult>, LookupError> {
        let query = normalize_query(query).ok_or(LookupError::InvalidQuery)?;
        let max_results = MAX_SEARCH_RESULTS.to_string();
        let mut response = self.data_api_get(
            SEARCH_ENDPOINT,
            &[
                ("part", "snippet"),
                ("q", &query),
                ("type", "video"),
                ("videoCategoryId", "10"),
                ("videoEmbeddable", "true"),
                ("order", "relevance"),
                ("maxResults", &max_results),
                ("fields", "items(id(videoId),snippet(title,channelTitle))"),
            ],
        )?;
        interpret_search_response(response.status().as_u16(), response.body_mut())
    }

    fn json_request(&self, endpoint: &str, params: &[(&str, &str)]) -> RequestBuilder<WithoutBody> {
        self.agent
            .get(endpoint)
            .query_pairs(params.iter().copied())
            .header(header::ACCEPT, "application/json")
    }

    fn data_api_get(
        &self,
        endpoint: &str,
        params: &[(&str, &str)],
    ) -> Result<ureq::http::Response<Body>, LookupError> {
        let Source::DataApi(Some(api_key)) = &self.source else {
            return Err(LookupError::InvalidKeyConfiguration);
        };
        self.json_request(endpoint, params)
            .header("x-goog-api-key", api_key.clone())
            .call()
            .map_err(transport_error)
    }
}

pub(super) fn normalize_query(query: &str) -> Option<String> {
    let trimmed = query.trim();
    if trimmed.is_empty()
        || trimmed.chars().nth(MAX_SEARCH_QUERY_CHARS).is_some()
        || query.chars().any(char::is_control)
    {
        return None;
    }
    Some(trimmed.to_owned())
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
    thumbnails: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct EmbedResponse {
    title: String,
    author_name: String,
    thumbnail_url: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct SearchList {
    items: Vec<SearchItem>,
}

#[derive(Deserialize)]
struct SearchItem {
    id: SearchVideoId,
    snippet: VideoSnippet,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchVideoId {
    video_id: String,
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
    let Some(bytes) = read_api_response(status, body, MAX_VIDEO_BODY_BYTES)? else {
        return Ok(None);
    };
    let list: VideoList =
        serde_json::from_slice(&bytes).map_err(|_| LookupError::InvalidResponse)?;
    match list.items.as_slice() {
        [] => Ok(None),
        [item] if item.id == id => Ok(Some(Metadata {
            title: display_field(&item.snippet.title)?,
            channel: display_field(&item.snippet.channel_title)?,
            thumbnail_url: canonical_thumbnail(
                id,
                item.snippet
                    .thumbnails
                    .as_ref()
                    .and_then(|value| value.pointer("/high/url")),
            ),
        })),
        _ => Err(LookupError::InvalidResponse),
    }
}

fn interpret_embed_response(
    status: u16,
    body: &mut Body,
    id: &str,
) -> Result<Option<Metadata>, LookupError> {
    match status {
        200 => {}
        401 | 404 => return Ok(None),
        429 => return Err(LookupError::Throttled),
        _ => return Err(LookupError::Service),
    }
    if !has_json_mime(body) {
        return Err(LookupError::InvalidResponse);
    }
    let bytes = read_body(body, MAX_VIDEO_BODY_BYTES)?;
    let embed: EmbedResponse =
        serde_json::from_slice(&bytes).map_err(|_| LookupError::InvalidResponse)?;
    Ok(Some(Metadata {
        title: display_field(&embed.title)?,
        channel: display_field(&embed.author_name)?,
        thumbnail_url: canonical_thumbnail(id, embed.thumbnail_url.as_ref()),
    }))
}

fn canonical_thumbnail(id: &str, url: Option<&serde_json::Value>) -> Option<String> {
    let canonical = format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg");
    (url.and_then(serde_json::Value::as_str) == Some(canonical.as_str())).then_some(canonical)
}

fn interpret_search_response(
    status: u16,
    body: &mut Body,
) -> Result<Vec<SearchResult>, LookupError> {
    let bytes =
        read_api_response(status, body, MAX_SEARCH_BODY_BYTES)?.ok_or(LookupError::Service)?;
    let list: SearchList =
        serde_json::from_slice(&bytes).map_err(|_| LookupError::InvalidResponse)?;
    let mut results: Vec<SearchResult> =
        Vec::with_capacity(list.items.len().min(MAX_SEARCH_RESULTS));
    for item in list.items {
        let id = item.id.video_id;
        if !valid_id(&id) {
            return Err(LookupError::InvalidResponse);
        }
        if results.iter().any(|result| result.id == id) {
            continue;
        }
        results.push(SearchResult {
            id,
            title: display_field(&html_escape::decode_html_entities(&item.snippet.title))?,
            channel: display_field(&html_escape::decode_html_entities(
                &item.snippet.channel_title,
            ))?,
        });
        if results.len() == MAX_SEARCH_RESULTS {
            break;
        }
    }
    Ok(results)
}

fn read_api_response(
    status: u16,
    body: &mut Body,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, LookupError> {
    match status {
        200 | 400 | 403 | 404 => {}
        401 => return Err(LookupError::InvalidKey),
        429 => return Err(LookupError::Throttled),
        _ => return Err(LookupError::Service),
    }

    if !has_json_mime(body) {
        return Err(if status == 200 {
            LookupError::InvalidResponse
        } else {
            LookupError::Service
        });
    }
    let bytes = read_body(body, max_bytes)?;
    if status == 200 {
        return Ok(Some(bytes));
    }
    classify_api_error(status, &bytes)?;
    Ok(None)
}

fn has_json_mime(body: &Body) -> bool {
    body.mime_type()
        .is_some_and(|mime| mime.eq_ignore_ascii_case("application/json"))
}

fn read_body(body: &mut Body, max_bytes: u64) -> Result<Vec<u8>, LookupError> {
    body.with_config()
        .limit(max_bytes)
        .read_to_vec()
        .map_err(transport_error)
}

fn classify_api_error(status: u16, bytes: &[u8]) -> Result<(), LookupError> {
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
            "videoNotFound" if status == 404 => return Ok(()),
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
                thumbnail_url: None,
            }))
        );
    }

    #[test]
    fn accepts_the_data_api_thumbnail_only_for_the_returned_video() {
        let mut item = serde_json::json!({
            "items": [{"id": VIDEO_ID, "snippet": {
                "title": "Track", "channelTitle": "Artist",
                "thumbnails": {"high": {"url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"}},
            }}],
        });
        let metadata = response(200, item.to_string()).unwrap().unwrap();
        assert_eq!(
            metadata.thumbnail_url.as_deref(),
            Some("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"),
        );
        item["items"][0]["snippet"]["thumbnails"]["high"]["url"] =
            "https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg".into();
        assert_eq!(
            response(200, item.to_string())
                .unwrap()
                .unwrap()
                .thumbnail_url,
            None,
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

    fn embed_response(
        status: u16,
        json: impl Into<Vec<u8>>,
    ) -> Result<Option<Metadata>, LookupError> {
        let mut body = Body::builder().mime_type("application/json").data(json);
        interpret_embed_response(status, &mut body, VIDEO_ID)
    }

    #[test]
    fn public_embed_requests_only_the_canonical_watch_url_and_json_format() {
        let mut client = Client::public_embed();
        client.agent = Agent::config_builder()
            .middleware(
                |request: ureq::http::Request<ureq::SendBody>,
                 _: ureq::middleware::MiddlewareNext<'_>| {
                    let uri = url::Url::parse(&request.uri().to_string()).unwrap();
                    assert_eq!(uri.scheme(), "https");
                    assert_eq!(uri.host_str(), Some("www.youtube.com"));
                    assert_eq!(uri.path(), "/oembed");
                    let params: Vec<_> = uri.query_pairs().collect();
                    assert_eq!(
                        params,
                        [
                            (
                                "url".into(),
                                "https://www.youtube.com/watch?v=dQw4w9WgXcQ".into()
                            ),
                            ("format".into(), "json".into()),
                        ],
                    );
                    assert!(!request.headers().contains_key("x-goog-api-key"));
                    assert!(!request.headers().contains_key(header::AUTHORIZATION));
                    Ok(ureq::http::Response::new(
                        Body::builder()
                            .mime_type("application/json")
                            .data(br#"{"title":"Public video","author_name":"Channel"}"#),
                    ))
                },
            )
            .build()
            .new_agent();
        assert_eq!(
            client.lookup("https://youtu.be/dQw4w9WgXcQ?t=30"),
            Err(LookupError::InvalidVideoId),
        );
        assert_eq!(
            client.lookup(VIDEO_ID).unwrap().unwrap().title,
            "Public video",
        );
        assert_eq!(
            client.search("Björk"),
            Err(LookupError::InvalidKeyConfiguration)
        );
    }

    #[test]
    fn extracts_only_display_fields_and_a_canonical_thumbnail() {
        let json = br#"{"title":"  A public\n video  ","author_name":"  Author ","thumbnail_url":"https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg","html":{"unexpected":"<iframe src=other>"}}"#;
        let metadata = embed_response(200, json).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(metadata).unwrap(),
            serde_json::json!({
                "title": "A public video",
                "channel": "Author",
                "thumbnailUrl": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
            }),
        );
    }

    #[test]
    fn discards_an_unsafe_thumbnail_without_losing_the_title() {
        for invalid in [
            serde_json::json!("http://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"),
            serde_json::json!("https://i.ytimg.com.attacker.test/vi/dQw4w9WgXcQ/hqdefault.jpg"),
            serde_json::json!("https://name:password@i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"),
            serde_json::json!("https://i.ytimg.com:8443/vi/dQw4w9WgXcQ/hqdefault.jpg"),
            serde_json::json!("https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg"),
            serde_json::json!("https://i.ytimg.com/vi/dQw4w9WgXcQ/image.jpg"),
            serde_json::json!("https://i.ytimg.com/vi/dQw4w9WgXcQ/../dQw4w9WgXcQ/hqdefault.jpg"),
            serde_json::json!("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg?trace=value"),
            serde_json::json!("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg#anchor"),
            serde_json::json!(123),
        ] {
            let json = serde_json::json!({
                "title": "Public video", "author_name": "Channel", "thumbnail_url": invalid,
            });
            let metadata = embed_response(200, json.to_string()).unwrap().unwrap();
            assert_eq!(metadata.title, "Public video");
            assert!(metadata.thumbnail_url.is_none());
        }
    }

    #[test]
    fn handles_embed_statuses_without_data_api_key_errors() {
        assert_eq!(embed_response(401, b""), Ok(None));
        assert_eq!(embed_response(404, b""), Ok(None));
        assert_eq!(embed_response(429, b""), Err(LookupError::Throttled));
        for status in [301, 400, 403, 500] {
            assert_eq!(embed_response(status, b""), Err(LookupError::Service));
        }
    }

    #[test]
    fn bounds_embed_html_as_part_of_the_decoded_response() {
        let json = serde_json::json!({
            "title": "Public video", "author_name": "Channel", "html": "a".repeat(16 * 1024),
        });
        assert_eq!(
            embed_response(200, json.to_string()),
            Err(LookupError::InvalidResponse)
        );
    }

    fn search_response(
        status: u16,
        json: impl Into<Vec<u8>>,
    ) -> Result<Vec<SearchResult>, LookupError> {
        let mut body = Body::builder().mime_type("application/json").data(json);
        interpret_search_response(status, &mut body)
    }

    #[test]
    fn trims_multilingual_searches_and_rejects_controls_or_excess_length() {
        assert_eq!(
            normalize_query("  Björk  音楽 موسيقى  "),
            Some("Björk  音楽 موسيقى".into())
        );
        assert_eq!(normalize_query(&"界".repeat(160)), Some("界".repeat(160)));
        assert_eq!(normalize_query(&"界".repeat(161)), None);
        assert_eq!(normalize_query("   "), None);
        assert_eq!(normalize_query("query\n"), None);
        assert_eq!(normalize_query("mu\u{007f}sic"), None);
    }

    #[test]
    fn validates_search_before_credentials_or_network() {
        let client = Client {
            agent: Agent::new_with_defaults(),
            source: Source::DataApi(None),
        };
        assert_eq!(client.search("\n"), Err(LookupError::InvalidQuery));
        assert_eq!(
            client.search("Björk"),
            Err(LookupError::InvalidKeyConfiguration)
        );
    }

    #[test]
    fn keeps_unique_video_ids_in_search_result_order() {
        let json = br#"{
            "items": [
                {"id": {"videoId": "jNQXAC9IVRw"}, "snippet": {"title": " First\nSong ", "channelTitle": " First Band "}},
                {"id": {"videoId": "dQw4w9WgXcQ"}, "snippet": {"title": "Second Song", "channelTitle": "Second Band"}},
                {"id": {"videoId": "jNQXAC9IVRw"}, "snippet": {"title": "Duplicate", "channelTitle": "First Band"}}
            ]
        }"#;
        assert_eq!(
            search_response(200, json),
            Ok(vec![
                SearchResult {
                    id: "jNQXAC9IVRw".into(),
                    title: "First Song".into(),
                    channel: "First Band".into(),
                },
                SearchResult {
                    id: "dQw4w9WgXcQ".into(),
                    title: "Second Song".into(),
                    channel: "Second Band".into(),
                }
            ])
        );
    }

    #[test]
    fn rejects_a_value_that_isnt_an_exact_video_id() {
        let json = br#"{"items":[{"id":{"videoId":"abcdefghij?"},"snippet":{"title":"Song","channelTitle":"Band"}}]}"#;
        assert_eq!(
            search_response(200, json),
            Err(LookupError::InvalidResponse)
        );
    }

    #[test]
    fn returns_an_empty_list_for_no_search_hits() {
        assert_eq!(search_response(200, br#"{"items":[]}"#), Ok(vec![]));
    }

    #[test]
    fn displays_search_character_references_as_literally_decoded_text() {
        let json = br#"{"items":[{"id":{"videoId":"dQw4w9WgXcQ"},"snippet":{"title":"Rock &amp; Roll &lt;b&gt;Don&#39;t&lt;/b&gt; &amp;lt;","channelTitle":"A &amp; B"}}]}"#;
        let hits = search_response(200, json).unwrap();
        assert_eq!(hits[0].title, "Rock & Roll <b>Don't</b> &lt;");
        assert_eq!(hits[0].channel, "A & B");
    }

    #[test]
    fn caps_results_at_twelve_unique_video_ids() {
        let items: Vec<_> = (0..14)
            .map(|index| {
                serde_json::json!({
                    "id": {"videoId": format!("videoID{index:04}")},
                    "snippet": {"title": "Song", "channelTitle": "Band"},
                })
            })
            .collect();
        let json = serde_json::json!({"items": items}).to_string();
        let hits = search_response(200, json).unwrap();
        assert_eq!(hits.len(), 12);
        assert_eq!(hits[11].id, "videoID0011");
    }

    #[test]
    fn bounds_decoded_search_response_before_parsing() {
        let mut json = br#"{"items":[]}"#.to_vec();
        json.resize(48 * 1024 + 1, b' ');
        assert_eq!(
            search_response(200, json),
            Err(LookupError::InvalidResponse)
        );
    }

    #[test]
    fn preserves_separate_search_quota_and_throttle_outcomes() {
        let quota = br#"{"error":{"errors":[{"reason":"quotaExceeded"}]}}"#;
        let throttled = br#"{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}"#;
        assert_eq!(search_response(403, quota), Err(LookupError::QuotaExceeded));
        assert_eq!(search_response(403, throttled), Err(LookupError::Throttled));
        assert_eq!(search_response(429, b""), Err(LookupError::Throttled));
    }
}
