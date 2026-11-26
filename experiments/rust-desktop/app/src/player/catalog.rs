use std::{
    io,
    sync::mpsc::{self, SyncSender},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use tao::event_loop::EventLoopProxy;

use super::{
    PlayerEvent,
    metadata::{Client, LookupError, PlaylistItems, SearchResult, normalize_query, playlist_id},
    metadata_lookup::Retention,
};

const THROTTLE_DELAY: Duration = Duration::from_secs(60);

pub(super) type Response = Result<Results, LookupError>;
type Request = (u64, Query);

pub(super) enum Results {
    Search(Vec<SearchResult>),
    Playlist(PlaylistItems),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Query {
    Search(String),
    Playlist(String),
}

impl Query {
    pub(super) fn parse(input: &str) -> Result<Self, &'static str> {
        if let Some(id) = playlist_id(input) {
            return Ok(Self::Playlist(id));
        }
        let first_word = input.split_whitespace().next().unwrap_or_default();
        let authority = first_word.split(['/', '?', '#']).next().unwrap_or_default();
        if input.contains("://")
            || first_word.starts_with("//")
            || (authority.contains('.') && authority.len() < first_word.len())
        {
            return Err("Enter a public YouTube playlist link or a search term.");
        }
        normalize_query(input)
            .map(Self::Search)
            .ok_or("Enter a search of up to 160 characters.")
    }

    fn value(&self) -> &str {
        match self {
            Self::Search(query) | Self::Playlist(query) => query,
        }
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistSummary {
    has_more: bool,
    unavailable: usize,
}

#[derive(Default, Serialize)]
pub(super) struct View {
    query: String,
    pending: bool,
    results: Vec<SearchResult>,
    problem: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    playlist: Option<PlaylistSummary>,
}

pub(super) struct Catalog {
    view: View,
    revision: u64,
    sender: SyncSender<Request>,
    in_flight: Option<Request>,
    waiting: Option<Request>,
    expires: Option<Retention>,
    throttled_until: Option<Instant>,
    unavailable: Option<&'static str>,
}

impl Catalog {
    pub(super) fn new(client: Client, events: EventLoopProxy<PlayerEvent>) -> io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel::<Request>(1);
        thread::Builder::new()
            .name("youtube-search".into())
            .spawn(move || {
                while let Ok((revision, query)) = receiver.recv() {
                    let results = match &query {
                        Query::Search(query) => client.search(query).map(Results::Search),
                        Query::Playlist(id) => client.playlist_items(id).map(Results::Playlist),
                    };
                    if events
                        .send_event(PlayerEvent::SearchResults(revision, results))
                        .is_err()
                    {
                        break;
                    }
                }
            })?;
        Ok(Self::with_sender(sender))
    }

    fn with_sender(sender: SyncSender<Request>) -> Self {
        Self {
            view: View::default(),
            revision: 0,
            sender,
            in_flight: None,
            waiting: None,
            expires: None,
            throttled_until: None,
            unavailable: None,
        }
    }

    pub(super) fn view(&self) -> &View {
        &self.view
    }

    pub(super) fn submit(&mut self, input: &str, time: Instant) {
        let query = Query::parse(input);
        if query.as_ref().map(Query::value) == Ok(self.view.query.as_str())
            && (self.view.pending
                || self
                    .expires
                    .as_ref()
                    .is_some_and(|expiry| !expiry.expired(time)))
        {
            return;
        }

        self.revision += 1;
        self.waiting = None;
        self.expires = None;
        self.view = View::default();
        let query = match query {
            Ok(query) => query,
            Err(problem) => {
                self.view.problem = Some(problem);
                return;
            }
        };
        self.view.query = query.value().to_owned();
        if matches!(query, Query::Playlist(_)) {
            self.view.playlist = Some(PlaylistSummary::default());
        }
        self.view.pending = true;
        if self
            .in_flight
            .as_ref()
            .is_some_and(|(_, active)| active == &query)
        {
            return;
        }
        self.waiting = Some((self.revision, query));
        self.send_next(time);
    }

    fn send_next(&mut self, time: Instant) {
        if self.in_flight.is_some() {
            return;
        }
        let Some((revision, query)) = self.waiting.take() else {
            return;
        };
        if let Some(reason) = self.unavailable {
            self.view.problem = Some(reason);
        } else if self.throttled_until.is_some_and(|until| until > time) {
            self.view.problem = Some("YouTube is limiting searches. Try again shortly.");
        } else if self.sender.try_send((revision, query.clone())).is_ok() {
            self.in_flight = Some((revision, query));
            return;
        } else {
            self.view.problem = Some("Could not start search. Restart Pear to retry.");
        }
        self.view.pending = false;
    }

    pub(super) fn receive(&mut self, revision: u64, response: Response, time: Instant) -> bool {
        let Some((_, query)) = self.in_flight.take_if(|(active, _)| *active == revision) else {
            return false;
        };
        let is_current = self.view.pending && self.view.query == query.value();
        match response {
            Ok(results) if is_current => {
                self.expires = Some(Retention::new(time));
                self.view.results = match results {
                    Results::Search(items) => items,
                    Results::Playlist(PlaylistItems {
                        items,
                        has_more,
                        unavailable,
                    }) => {
                        self.view.playlist = Some(PlaylistSummary {
                            has_more,
                            unavailable,
                        });
                        items
                    }
                };
                self.view.pending = false;
            }
            Ok(_) => {}
            Err(reason) => {
                let message = self.error_message(reason, time);
                if is_current {
                    self.view.problem = Some(message);
                    self.view.pending = false;
                }
            }
        }
        let was_pending = self.view.pending;
        self.send_next(time);
        is_current || was_pending != self.view.pending
    }

    fn error_message(&mut self, error: LookupError, time: Instant) -> &'static str {
        let unavailable = match error {
            LookupError::InvalidKey => "YouTube rejected the configured API key.",
            LookupError::InvalidKeyConfiguration => {
                "Could not read a YouTube API key from the configured file."
            }
            LookupError::QuotaExceeded => "The configured YouTube API key has reached its quota.",
            LookupError::Throttled => {
                self.throttled_until = Some(time + THROTTLE_DELAY);
                return "YouTube is limiting searches. Try again shortly.";
            }
            _ if self.view.playlist.is_some() => {
                return "Could not load this public YouTube playlist. Check the link and try again.";
            }
            _ => return "Could not search YouTube. Try again.",
        };
        self.unavailable = Some(unavailable);
        unavailable
    }

    pub(super) fn deadline(&self) -> Option<Instant> {
        self.expires.as_ref().map(Retention::deadline)
    }

    pub(super) fn can_open_playlist_video(&self, id: &str, time: Instant) -> bool {
        self.view.playlist.is_some()
            && self
                .expires
                .as_ref()
                .is_some_and(|expiry| !expiry.expired(time))
            && self.view.results.iter().any(|result| result.id == id)
    }

    pub(super) fn tick(&mut self, time: Instant) -> bool {
        if !self
            .expires
            .as_ref()
            .is_some_and(|expiry| expiry.expired(time))
        {
            return false;
        }
        self.view.results.clear();
        self.view.query.clear();
        self.view.playlist = None;
        self.expires = None;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::TryRecvError;

    fn result(title: &str) -> SearchResult {
        SearchResult {
            id: "M7lc1UVf-VE".into(),
            title: title.into(),
            channel: "Example".into(),
        }
    }

    #[test]
    fn skips_intermediate_jobs_and_ignores_stale_results() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut catalog = Catalog::with_sender(sender);
        let now = Instant::now();
        catalog.submit("first", now);
        let (first, _) = receiver.try_recv().unwrap();
        catalog.submit("second", now);
        catalog.submit("third", now);
        assert_eq!(receiver.try_recv(), Err(TryRecvError::Empty));
        assert!(!catalog.receive(first, Ok(Results::Search(vec![result("Old")])), now));
        let (third, query) = receiver.try_recv().unwrap();
        assert_eq!(query, Query::Search("third".into()));
        assert!(catalog.view().results.is_empty());
        assert!(catalog.receive(third, Ok(Results::Search(vec![result("Newest")])), now));
        assert_eq!(catalog.view().results[0].title, "Newest");
    }

    #[test]
    fn bounds_repeat_queries_and_short_term_rate_limiting() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut catalog = Catalog::with_sender(sender);
        let now = Instant::now();
        catalog.submit("first", now);
        let (first, _) = receiver.try_recv().unwrap();
        catalog.submit(" first ", now);
        assert_eq!(receiver.try_recv(), Err(TryRecvError::Empty));
        assert!(catalog.receive(first, Err(LookupError::Throttled), now));
        catalog.submit("second", now);
        assert!(!catalog.view().pending);
        assert!(catalog.view().problem.is_some());
        assert_eq!(receiver.try_recv(), Err(TryRecvError::Empty));
        catalog.submit("second", now + THROTTLE_DELAY);
        let (second, _) = receiver.try_recv().unwrap();
        assert!(catalog.receive(second, Ok(Results::Search(vec![])), now + THROTTLE_DELAY));
        catalog.submit("second", now + THROTTLE_DELAY);
        assert_eq!(receiver.try_recv(), Err(TryRecvError::Empty));
    }

    #[test]
    fn reuses_an_in_flight_query_after_switching_back_to_it() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut catalog = Catalog::with_sender(sender);
        let now = Instant::now();
        catalog.submit("first", now);
        let (first, _) = receiver.try_recv().unwrap();
        catalog.submit("second", now);
        catalog.submit("first", now);
        assert!(catalog.receive(first, Ok(Results::Search(vec![result("Reused")])), now));
        assert_eq!(catalog.view().results[0].title, "Reused");
        assert_eq!(receiver.try_recv(), Err(TryRecvError::Empty));
    }

    #[test]
    fn playlist_results_open_only_current_rows_until_expiry() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut catalog = Catalog::with_sender(sender);
        let now = Instant::now();
        let id = "PL_1234567890";
        catalog.submit("https://example.com/playlist?list=PL_1234567890", now);
        assert_eq!(receiver.try_recv(), Err(TryRecvError::Empty));

        catalog.submit(
            &format!("https://music.youtube.com/playlist?list={id}"),
            now,
        );
        let (revision, query) = receiver.try_recv().unwrap();
        assert_eq!(query, Query::Playlist(id.into()));
        assert!(!catalog.can_open_playlist_video("M7lc1UVf-VE", now));
        assert!(catalog.receive(
            revision,
            Ok(Results::Playlist(PlaylistItems {
                items: vec![result("Available")],
                has_more: true,
                unavailable: 1,
            })),
            now,
        ));
        assert_eq!(catalog.view().results[0].title, "Available");
        let playlist = catalog.view().playlist.as_ref().unwrap();
        assert!(playlist.has_more);
        assert_eq!(playlist.unavailable, 1);
        assert!(catalog.can_open_playlist_video("M7lc1UVf-VE", now));
        assert!(!catalog.can_open_playlist_video("dQw4w9WgXcQ", now));
        let expired = now + Duration::from_secs(25 * 60 * 60);
        assert!(!catalog.can_open_playlist_video("M7lc1UVf-VE", expired));
        assert!(catalog.tick(expired));
        assert!(catalog.view().playlist.is_none());
    }

    #[test]
    fn playlist_routing_does_not_send_share_parameters_or_intercept_artist_searches() {
        assert_eq!(
            Query::parse("FLEETWOODMAC"),
            Ok(Query::Search("FLEETWOODMAC".into()))
        );
        assert!(Query::parse("//example.com/playlist?list=PL_1234567890&si=share").is_err());
        assert!(Query::parse("example.com/playlist?list=PL_1234567890&si=share").is_err());
        assert_eq!(
            Query::parse("www.youtube.com/playlist?si=share&list=PL_1234567890"),
            Ok(Query::Playlist("PL_1234567890".into())),
        );
    }
}
