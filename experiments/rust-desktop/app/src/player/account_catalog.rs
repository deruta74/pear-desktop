//! A read-only YouTube Data API client for the signed-in account view.
use std::{fmt, time::Duration};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use ureq::{
    Agent, Body,
    http::{HeaderValue, header},
    tls::{RootCerts, TlsConfig, TlsProvider},
};

use crate::library::valid_id;

const MAX_PAGE_ITEMS: usize = 50;
const MAX_PAGE_TOKEN_BYTES: usize = 1024;
const MAX_BEARER_BYTES: usize = 8192;
const MAX_RESPONSE_BYTES: u64 = 128 * 1024;
const MAX_ERROR_BYTES: u64 = 16 * 1024;
const MAX_DISPLAY_CHARS: usize = 180;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Collection {
    OwnedPlaylists,
    LikedVideos,
    PlaylistItems(String),
}

#[cfg_attr(test, derive(Debug, PartialEq, Eq))]
pub(super) struct Page {
    pub(super) items: Vec<Item>,
    pub(super) next_page_token: Option<String>,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(Debug, PartialEq, Eq))]
#[serde(rename_all = "camelCase")]
pub(super) struct Item {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) attribution: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Error {
    InvalidRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    QuotaExceeded,
    Throttled,
    Network,
    InvalidResponse,
    Service,
}

impl fmt::Display for Error {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::InvalidRequest => "That YouTube account page could not be requested.",
            Self::Unauthorized => "Your YouTube session needs a new sign-in.",
            Self::Forbidden => "YouTube denied access to this account collection.",
            Self::NotFound => "YouTube could not find this collection.",
            Self::QuotaExceeded => "The YouTube account service has reached its quota.",
            Self::Throttled => "YouTube is limiting requests. Try again shortly.",
            Self::Network => "Could not connect to the YouTube account service.",
            Self::InvalidResponse => "YouTube returned an invalid account response.",
            Self::Service => "The YouTube account service is unavailable.",
        })
    }
}

#[derive(Clone)]
pub(super) struct Client {
    agent: Agent,
}

impl Client {
    pub(super) fn new() -> Self {
        let agent = Agent::config_builder()
            .https_only(true)
            .proxy(None)
            .max_redirects(0)
            .timeout_connect(Some(Duration::from_secs(3)))
            .timeout_global(Some(Duration::from_secs(8)))
            .http_status_as_error(false)
            .tls_config(
                TlsConfig::builder()
                    .provider(TlsProvider::NativeTls)
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .build()
            .new_agent();
        Self { agent }
    }

    pub(super) fn fetch(
        &self,
        collection: &Collection,
        page_token: Option<&str>,
        bearer: &str,
    ) -> Result<Page, Error> {
        if page_token.is_some_and(|token| !valid_page_token(token)) {
            return Err(Error::InvalidRequest);
        }
        let authorization = bearer_header(bearer)?;
        let request = match collection {
            Collection::OwnedPlaylists => self
                .agent
                .get("https://www.googleapis.com/youtube/v3/playlists")
                .query("mine", "true")
                .query("part", "snippet")
                .query(
                    "fields",
                    "nextPageToken,items(id,snippet(title,channelTitle))",
                ),
            Collection::LikedVideos => self
                .agent
                .get("https://www.googleapis.com/youtube/v3/videos")
                .query("myRating", "like")
                .query("part", "snippet,status")
                .query(
                    "fields",
                    "nextPageToken,items(id,snippet(title,channelTitle),status(uploadStatus))",
                ),
            Collection::PlaylistItems(id) => {
                if !valid_playlist_id(id) {
                    return Err(Error::InvalidRequest);
                }
                self.agent
                    .get("https://www.googleapis.com/youtube/v3/playlistItems")
                    .query("playlistId", id)
                    .query("part", "snippet")
                    .query("fields", "nextPageToken,items(snippet(resourceId(videoId),title,videoOwnerChannelTitle))")
            }
        };
        let request = request
            .query("maxResults", MAX_PAGE_ITEMS.to_string())
            .query_pairs(page_token.map(|token| ("pageToken", token)))
            .header(header::ACCEPT, "application/json")
            .header(header::AUTHORIZATION, authorization);
        let mut response = request.call().map_err(transport_error)?;
        match response.status().as_u16() {
            200 => {
                let page: RawPage = read_json(response.body_mut(), MAX_RESPONSE_BYTES)?;
                Ok(page.into_page(collection))
            }
            400 => Err(Error::InvalidRequest),
            401 => Err(Error::Unauthorized),
            403 => Err(classify_forbidden(response.body_mut())),
            404 => Err(Error::NotFound),
            429 => Err(Error::Throttled),
            _ => Err(Error::Service),
        }
    }
}

fn valid_page_token(token: &str) -> bool {
    (1..=MAX_PAGE_TOKEN_BYTES).contains(&token.len())
        && token.bytes().all(|byte| byte.is_ascii_graphic())
}

fn valid_playlist_id(id: &str) -> bool {
    (2..=128).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn bearer_header(bearer: &str) -> Result<HeaderValue, Error> {
    let token = bearer.trim_end_matches('=');
    if bearer.len() > MAX_BEARER_BYTES
        || token.is_empty()
        || !token.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'+' | b'/')
        })
    {
        return Err(Error::Unauthorized);
    }
    let mut header =
        HeaderValue::from_str(&format!("Bearer {bearer}")).map_err(|_| Error::Unauthorized)?;
    header.set_sensitive(true);
    Ok(header)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPage {
    items: Vec<Value>,
    next_page_token: Option<Value>,
}

impl RawPage {
    fn into_page(self, collection: &Collection) -> Page {
        let next_page_token = self
            .next_page_token
            .as_ref()
            .and_then(Value::as_str)
            .filter(|token| valid_page_token(token))
            .map(str::to_owned);
        let items = self
            .items
            .iter()
            .take(MAX_PAGE_ITEMS)
            .filter_map(|row| account_item(collection, row))
            .collect();
        Page {
            items,
            next_page_token,
        }
    }
}

fn account_item(collection: &Collection, row: &Value) -> Option<Item> {
    let snippet = &row["snippet"];
    let (id, attribution) = match collection {
        Collection::OwnedPlaylists => (
            row["id"].as_str().filter(|id| valid_playlist_id(id))?,
            &snippet["channelTitle"],
        ),
        Collection::LikedVideos => {
            if row["status"]["uploadStatus"]
                .as_str()
                .is_some_and(|status| status != "processed")
            {
                return None;
            }
            (
                row["id"].as_str().filter(|id| valid_id(id))?,
                &snippet["channelTitle"],
            )
        }
        Collection::PlaylistItems(_) => (
            snippet["resourceId"]["videoId"]
                .as_str()
                .filter(|id| valid_id(id))?,
            &snippet["videoOwnerChannelTitle"],
        ),
    };
    let title = snippet["title"].as_str().and_then(display_field)?;
    // Unavailable playlist entries can retain a valid-looking video ID.
    if matches!(collection, Collection::PlaylistItems(_))
        && (title.eq_ignore_ascii_case("Private video")
            || title.eq_ignore_ascii_case("Deleted video"))
    {
        return None;
    }
    Some(Item {
        id: id.to_owned(),
        title,
        attribution: attribution.as_str().and_then(display_field),
    })
}

fn display_field(value: &str) -> Option<String> {
    let cleaned: String = value
        .chars()
        .filter(|&ch| {
            (ch.is_whitespace() || !ch.is_control())
                && !matches!(ch, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .collect();
    let normalized = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    let end = normalized
        .char_indices()
        .nth(MAX_DISPLAY_CHARS)
        .map_or(normalized.len(), |(index, _)| index);
    Some(normalized[..end].trim_end().to_owned())
}

fn read_json<T: DeserializeOwned>(body: &mut Body, limit: u64) -> Result<T, Error> {
    if !body
        .mime_type()
        .is_some_and(|mime| mime.eq_ignore_ascii_case("application/json"))
    {
        return Err(Error::InvalidResponse);
    }
    let bytes = body
        .with_config()
        .limit(limit)
        .read_to_vec()
        .map_err(transport_error)?;
    serde_json::from_slice(&bytes).map_err(|_| Error::InvalidResponse)
}

fn classify_forbidden(body: &mut Body) -> Error {
    let Ok(json) = read_json::<Value>(body, MAX_ERROR_BYTES) else {
        return Error::Forbidden;
    };
    let error = &json["error"];
    ["errors", "details"]
        .into_iter()
        .flat_map(|key| {
            error[key]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|reason| reason["reason"].as_str())
        })
        .chain(error["status"].as_str())
        .find_map(|reason| match reason {
            "quotaExceeded" | "dailyLimitExceeded" | "QUOTA_EXCEEDED" | "DAILY_LIMIT_EXCEEDED" => {
                Some(Error::QuotaExceeded)
            }
            "rateLimitExceeded"
            | "userRateLimitExceeded"
            | "RATE_LIMIT_EXCEEDED"
            | "RESOURCE_EXHAUSTED" => Some(Error::Throttled),
            _ => None,
        })
        .unwrap_or(Error::Forbidden)
}

fn transport_error(error: ureq::Error) -> Error {
    match error {
        ureq::Error::BodyExceedsLimit(_)
        | ureq::Error::Decompress(_, _)
        | ureq::Error::LargeResponseHeader(_, _)
        | ureq::Error::Protocol(_) => Error::InvalidResponse,
        _ => Error::Network,
    }
}

#[cfg(test)]
mod tests;
