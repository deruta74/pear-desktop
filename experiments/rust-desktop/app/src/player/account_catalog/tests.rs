use super::*;
use std::collections::BTreeMap;
use ureq::{
    SendBody,
    http::{Method, Request, Response},
    middleware::MiddlewareNext,
};

const PLAYLIST: &str = "PL00000000000000000000000000000000";
const BEARER: &str = "test.oauth-token_42";

fn client_with_response(
    mime: &str,
    status: u16,
    body: impl Into<Vec<u8>>,
    inspect: impl Fn(Request<SendBody<'_>>) + Send + Sync + 'static,
) -> Client {
    let mime = mime.to_owned();
    let body = body.into();
    let agent = Agent::config_builder()
        .middleware(
            move |request: Request<SendBody<'_>>, _: MiddlewareNext<'_>| {
                inspect(request);
                Ok(Response::builder()
                    .status(status)
                    .body(Body::builder().mime_type(&mime).data(body.clone()))
                    .unwrap())
            },
        )
        .build()
        .new_agent();
    Client { agent }
}

fn fetch_fixture(collection: &Collection, body: impl Into<Vec<u8>>) -> Result<Page, Error> {
    client_with_response("application/json", 200, body, |_| {}).fetch(collection, None, BEARER)
}

#[test]
fn uses_direct_https_with_bounded_timeouts_and_no_redirects() {
    let client = Client::new();
    let config = client.agent.config();
    assert!(config.https_only());
    assert!(config.proxy().is_none());
    assert_eq!(config.max_redirects(), 0);
    assert_eq!(config.timeouts().connect, Some(Duration::from_secs(3)));
    assert_eq!(config.timeouts().global, Some(Duration::from_secs(8)));
}

#[test]
fn sends_only_fixed_get_requests_with_a_sensitive_authorization_header() {
    for (collection, endpoint, selector, part, fields, page_token) in [
        (
            Collection::OwnedPlaylists,
            "/youtube/v3/playlists",
            ("mine", "true"),
            "snippet",
            "nextPageToken,items(id,snippet(title))",
            None,
        ),
        (
            Collection::LikedVideos,
            "/youtube/v3/videos",
            ("myRating", "like"),
            "snippet,status",
            "nextPageToken,items(id,snippet(title,channelTitle),status(uploadStatus))",
            Some("opaque+/=_-%&mine=false"),
        ),
        (
            Collection::PlaylistItems(PLAYLIST.into()),
            "/youtube/v3/playlistItems",
            ("playlistId", PLAYLIST),
            "snippet",
            "nextPageToken,items(snippet(resourceId(videoId),title,videoOwnerChannelTitle))",
            None,
        ),
    ] {
        let client = client_with_response(
            "application/json",
            200,
            br#"{"items":[]}"#,
            move |request| {
                assert_eq!(request.method(), Method::GET);
                assert_eq!(request.uri().scheme_str(), Some("https"));
                assert_eq!(
                    request.uri().authority().unwrap().as_str(),
                    "www.googleapis.com"
                );
                assert_eq!(request.uri().path(), endpoint);
                assert_eq!(request.headers()[header::ACCEPT], "application/json");
                let authorization = &request.headers()[header::AUTHORIZATION];
                assert_eq!(authorization, "Bearer test.oauth-token_42");
                assert!(authorization.is_sensitive());
                let query: BTreeMap<_, _> =
                    url::form_urlencoded::parse(request.uri().query().unwrap().as_bytes())
                        .into_owned()
                        .collect();
                let mut expected = BTreeMap::from([
                    (selector.0.to_owned(), selector.1.to_owned()),
                    ("part".to_owned(), part.to_owned()),
                    ("fields".to_owned(), fields.to_owned()),
                    ("maxResults".to_owned(), "50".to_owned()),
                ]);
                if let Some(token) = page_token {
                    expected.insert("pageToken".to_owned(), token.to_owned());
                }
                assert_eq!(query, expected);
            },
        );
        let page = client.fetch(&collection, page_token, BEARER).unwrap();
        assert!(page.items.is_empty());
    }
}

#[test]
fn invalid_request_values_never_reach_the_transport() {
    let client = client_with_response("application/json", 200, b"", |_| {
        panic!("invalid input reached the transport");
    });
    for bearer in ["", "=abc", "Bearer another", "x\r\nX-Fake: y"] {
        assert_eq!(
            client.fetch(&Collection::OwnedPlaylists, None, bearer),
            Err(Error::Unauthorized)
        );
    }
    for token in ["", "spaces are invalid", "control\n", &"x".repeat(1025)] {
        assert_eq!(
            client.fetch(&Collection::LikedVideos, Some(token), BEARER),
            Err(Error::InvalidRequest)
        );
    }
    assert_eq!(
        client.fetch(
            &Collection::PlaylistItems("https://example.invalid/playlist".into()),
            None,
            BEARER,
        ),
        Err(Error::InvalidRequest)
    );
}

#[test]
fn owned_playlists_keep_valid_private_rows_and_skip_malformed_rows() {
    let body = br#"{
        "nextPageToken": "next+/=",
        "items": [
            null,
            {"id":"PL00000000000000000000000000000000","snippet":{"title":"My private collection","channelTitle":"Owner"},"status":{"privacyStatus":"private"}},
            {"id":"PL00000000000000000000000000000001","snippet":{"title":42}},
            {"id":"../../untrusted-data","snippet":{"title":"Wrong ID"}},
            {"id":"PL00000000000000000000000000000002","snippet":{"title":"\u202eSecond\n\tplaylist","description":"Not attribution"}}
        ]
    }"#;
    let page = fetch_fixture(&Collection::OwnedPlaylists, body).unwrap();
    assert_eq!(page.next_page_token.as_deref(), Some("next+/="));
    assert_eq!(
        page.items,
        [
            Item {
                id: PLAYLIST.into(),
                title: "My private collection".into(),
                attribution: None
            },
            Item {
                id: "PL00000000000000000000000000000002".into(),
                title: "Second playlist".into(),
                attribution: None
            },
        ]
    );
}

#[test]
fn playlist_items_use_video_ids_and_video_owner_attribution() {
    let body = br#"{
        "items": [
            {"id":"PL00000000000000000000000000000000","snippet":{"resourceId":{"videoId":"a2345678901"},"title":"Actually available","videoOwnerChannelTitle":"Real owner","channelTitle":"Playlist curator"}},
            {"snippet":{"resourceId":{"videoId":"b2345678901"},"title":"Private video"}},
            {"snippet":{"resourceId":{"videoId":"c2345678901"},"title":"Deleted video"}},
            {"snippet":{"resourceId":{"videoId":"d2345678901"},"title":"My own private upload","channelTitle":"Playlist curator"},"status":{"privacyStatus":"private"}},
            {"snippet":{"resourceId":{"playlistId":"PL00000000000000000000000000000000"},"title":"Invalid video row"}}
        ]
    }"#;
    let page = fetch_fixture(&Collection::PlaylistItems(PLAYLIST.into()), body).unwrap();
    assert_eq!(
        page.items,
        [
            Item {
                id: "a2345678901".into(),
                title: "Actually available".into(),
                attribution: Some("Real owner".into())
            },
            Item {
                id: "d2345678901".into(),
                title: "My own private upload".into(),
                attribution: None
            },
        ]
    );
}

#[test]
fn liked_videos_omit_unavailable_uploads() {
    let body = br#"{
        "items": [
            {"id":"a2345678901","snippet":{"title":"Ready","channelTitle":"Creator"},"status":{"uploadStatus":"processed"}},
            {"id":"b2345678901","snippet":{"title":"Removed"},"status":{"uploadStatus":"deleted"}},
            {"id":"c2345678901","snippet":{"title":"Still processing"},"status":{"uploadStatus":"uploaded"}},
            {"id":"d2345678901","snippet":{"title":"Blocked"},"status":{"uploadStatus":"rejected"}},
            {"id":"e2345678901","snippet":{"title":"Private title","channelTitle":"Creator"},"status":{"privacyStatus":"private","uploadStatus":"processed"}}
        ]
    }"#;
    let page = fetch_fixture(&Collection::LikedVideos, body).unwrap();
    assert_eq!(
        page.items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["a2345678901", "e2345678901"]
    );
}

#[test]
fn bounds_each_page_and_drops_unusable_continuation_tokens() {
    let rows: Vec<_> = (0..55)
        .map(|n| serde_json::json!({"id": format!("abcdefgh{n:03}"), "snippet": {"title": "界".repeat(200)}}))
        .collect();
    let body = serde_json::json!({"items": rows, "nextPageToken": "x".repeat(1025)});
    let page = fetch_fixture(&Collection::LikedVideos, body.to_string()).unwrap();
    assert_eq!(page.next_page_token, None);
    assert_eq!(page.items.len(), 50);
    assert_eq!(page.items[49].id, "abcdefgh049");
    assert_eq!(page.items[49].title.chars().count(), 180);
}

#[test]
fn rejects_oversized_malformed_and_non_json_success_responses() {
    let mut oversized = br#"{"items":[]}"#.to_vec();
    oversized.resize(128 * 1024 + 1, b' ');
    assert_eq!(
        fetch_fixture(&Collection::LikedVideos, oversized),
        Err(Error::InvalidResponse)
    );
    assert_eq!(
        fetch_fixture(&Collection::LikedVideos, br#"{"items":false}"#),
        Err(Error::InvalidResponse)
    );
    let client = client_with_response("text/html", 200, br#"{"items":[]}"#, |_| {});
    assert_eq!(
        client.fetch(&Collection::LikedVideos, None, BEARER),
        Err(Error::InvalidResponse)
    );
}

#[test]
fn returns_sanitized_statuses_without_returning_the_remote_message() {
    let quota = br#"{"error":{"message":"private server diagnostic","errors":[{"reason":"quotaExceeded"}]}}"#;
    let limit = br#"{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"reason":"RATE_LIMIT_EXCEEDED"}]}}"#;
    for (status, body, expected) in [
        (400, b"" as &[u8], Error::InvalidRequest),
        (401, b"", Error::Unauthorized),
        (403, quota, Error::QuotaExceeded),
        (403, limit, Error::Throttled),
        (403, b"private server diagnostic", Error::Forbidden),
        (404, b"", Error::NotFound),
        (429, b"", Error::Throttled),
        (302, b"", Error::Service),
        (503, b"", Error::Service),
    ] {
        let client = client_with_response("application/json", status, body, |_| {});
        let error = client
            .fetch(&Collection::LikedVideos, None, BEARER)
            .unwrap_err();
        assert_eq!(error, expected);
        assert!(!error.to_string().contains("private server diagnostic"));
    }
}
