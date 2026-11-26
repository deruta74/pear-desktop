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
const MAX_PLAYLIST_PAGES: usize = 10;
const MAX_CONTINUATION_REQUESTS: usize = 12;

pub(super) type Response = Result<Results, LookupError>;
type Request = (u64, Work);

#[derive(Clone)]
#[cfg_attr(test, derive(Debug, PartialEq, Eq))]
enum Work {
    Initial(Query),
    MorePlaylist {
        id: String,
        token: String,
        revision: u64,
    },
}

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
    revision: u64,
    pending: bool,
    problem: Option<&'static str>,
    truncated: bool,
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
    // Tokens are retained only for the active playlist. The last is the next cursor.
    page_tokens: Vec<String>,
    page_requests: usize,
    throttled_until: Option<Instant>,
    unavailable: Option<&'static str>,
}

impl Catalog {
    pub(super) fn new(client: Client, events: EventLoopProxy<PlayerEvent>) -> io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel::<Request>(1);
        thread::Builder::new()
            .name("youtube-search".into())
            .spawn(move || {
                while let Ok((revision, work)) = receiver.recv() {
                    let results = match &work {
                        Work::Initial(Query::Search(query)) => {
                            client.search(query).map(Results::Search)
                        }
                        Work::Initial(Query::Playlist(id)) => {
                            client.playlist_items(id, None).map(Results::Playlist)
                        }
                        Work::MorePlaylist { id, token, .. } => client
                            .playlist_items(id, Some(token))
                            .map(Results::Playlist),
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
            page_tokens: Vec::new(),
            page_requests: 0,
            throttled_until: None,
            unavailable: None,
        }
    }

    pub(super) fn view(&self) -> &View {
        &self.view
    }

    pub(super) fn submit(&mut self, input: &str, time: Instant) {
        let query = Query::parse(input);
        if query
            .as_ref()
            .is_ok_and(|query| self.matches_view_query(query))
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
        self.clear_view();
        let query = match query {
            Ok(query) => query,
            Err(problem) => {
                self.view.problem = Some(problem);
                return;
            }
        };
        self.view.query = query.value().to_owned();
        if matches!(query, Query::Playlist(_)) {
            self.view.playlist = Some(PlaylistSummary {
                revision: self.revision,
                ..PlaylistSummary::default()
            });
        }
        self.view.pending = true;
        if self
            .in_flight
            .as_ref()
            .is_some_and(|(_, active)| matches!(active, Work::Initial(active) if active == &query))
        {
            return;
        }
        self.waiting = Some((self.revision, Work::Initial(query)));
        self.send_next(time);
    }

    pub(super) fn load_more(&mut self, revision: u64, time: Instant) {
        self.tick(time);
        let Some(playlist) = &mut self.view.playlist else {
            return;
        };
        if playlist.revision != revision || !playlist.has_more || playlist.pending {
            return;
        }
        let Some(token) = self.page_tokens.last() else {
            return;
        };
        playlist.pending = true;
        playlist.problem = None;
        self.revision += 1;
        self.waiting = Some((
            self.revision,
            Work::MorePlaylist {
                id: self.view.query.clone(),
                token: token.clone(),
                revision,
            },
        ));
        self.send_next(time);
    }

    fn matches_view_query(&self, query: &Query) -> bool {
        self.view.query == query.value()
            && self.view.playlist.is_some() == matches!(query, Query::Playlist(_))
    }

    fn send_next(&mut self, time: Instant) {
        if self.in_flight.is_some() {
            return;
        }
        let Some((revision, work)) = self.waiting.take() else {
            return;
        };
        let more = matches!(work, Work::MorePlaylist { .. });
        if let Some(reason) = self.unavailable {
            self.set_work_problem(more, reason, true);
        } else if self.throttled_until.is_some_and(|until| until > time) {
            self.set_work_problem(more, throttle_problem(more), false);
        } else if self.sender.try_send((revision, work.clone())).is_ok() {
            self.in_flight = Some((revision, work));
            if more {
                self.page_requests += 1;
            }
        } else {
            let problem = if more {
                "Could not load more playlist items. Restart Pear to retry."
            } else {
                "Could not start search. Restart Pear to retry."
            };
            self.set_work_problem(more, problem, true);
        }
    }

    pub(super) fn receive(&mut self, revision: u64, response: Response, time: Instant) -> bool {
        let Some((_, work)) = self.in_flight.take_if(|(active, _)| *active == revision) else {
            return false;
        };
        let expired = self.tick(time);
        let more = matches!(work, Work::MorePlaylist { .. });
        let is_current = match &work {
            Work::Initial(query) => self.view.pending && self.matches_view_query(query),
            Work::MorePlaylist { revision, .. } => self
                .view
                .playlist
                .as_ref()
                .is_some_and(|playlist| playlist.revision == *revision && playlist.pending),
        };
        match response {
            Ok(results) if is_current => {
                if !more {
                    // All pages expire together at the first page's retention deadline.
                    self.expires = Some(Retention::new(time));
                    self.view.pending = false;
                }
                match results {
                    Results::Search(items) => self.view.results = items,
                    Results::Playlist(page) => {
                        self.append_playlist_page(page);
                    }
                }
            }
            Ok(_) => {}
            Err(reason) => {
                let message = self.error_message(reason, time, more);
                if is_current {
                    self.set_work_problem(more, message, self.unavailable.is_some());
                }
            }
        }
        let was_pending = self.view.pending;
        self.send_next(time);
        expired || is_current || was_pending != self.view.pending
    }

    fn append_playlist_page(&mut self, page: PlaylistItems) {
        let Some(playlist) = &mut self.view.playlist else {
            return;
        };
        self.view.results.extend(page.items);
        playlist.unavailable += page.unavailable;
        playlist.pending = false;
        playlist.has_more = false;
        playlist.truncated = page.truncated;
        if let Some(token) = page.next_page_token {
            if self.page_tokens.len() >= MAX_PLAYLIST_PAGES - 1
                || self.page_requests >= MAX_CONTINUATION_REQUESTS
                || self.page_tokens.contains(&token)
            {
                playlist.truncated = true;
            } else {
                self.page_tokens.push(token);
                playlist.has_more = true;
            }
        }
    }

    fn set_work_problem(&mut self, more: bool, problem: &'static str, terminal: bool) {
        if more {
            if let Some(playlist) = &mut self.view.playlist {
                playlist.pending = false;
                playlist.truncated = self.page_requests >= MAX_CONTINUATION_REQUESTS;
                playlist.problem = Some(if playlist.truncated && !terminal {
                    "Pear reached the request limit for this playlist."
                } else {
                    problem
                });
                if terminal || playlist.truncated {
                    playlist.has_more = false;
                }
            }
        } else {
            self.view.problem = Some(problem);
            self.view.pending = false;
        }
    }

    fn error_message(&mut self, error: LookupError, time: Instant, more: bool) -> &'static str {
        let unavailable = match error {
            LookupError::InvalidKey => "YouTube rejected the configured API key.",
            LookupError::InvalidKeyConfiguration => {
                "Could not read a YouTube API key from the configured file."
            }
            LookupError::QuotaExceeded => "The configured YouTube API key has reached its quota.",
            LookupError::Throttled => {
                self.throttled_until = Some(time + THROTTLE_DELAY);
                return throttle_problem(more);
            }
            _ if more => return "Could not load more playlist items. Try again.",
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
        self.view.playlist.is_some() && self.has_current_video(id, time)
    }

    pub(super) fn can_queue_video(&self, id: &str, time: Instant) -> bool {
        self.view.playlist.is_none() && self.has_current_video(id, time)
    }

    pub(super) fn playlist_queue_ids(
        &self,
        revision: u64,
        loaded_count: usize,
        time: Instant,
    ) -> Option<impl Iterator<Item = &str>> {
        let playlist = self.view.playlist.as_ref()?;
        // Page responses append rows without changing the playlist revision.
        if playlist.revision != revision
            || playlist.pending
            || loaded_count == 0
            || loaded_count != self.view.results.len()
            || self
                .expires
                .as_ref()
                .is_none_or(|expiry| expiry.expired(time))
        {
            return None;
        }
        Some(self.view.results.iter().map(|result| result.id.as_str()))
    }

    fn has_current_video(&self, id: &str, time: Instant) -> bool {
        self.expires
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
        self.waiting = None;
        self.clear_view();
        true
    }

    fn clear_view(&mut self) {
        self.view = View::default();
        self.expires = None;
        self.page_tokens.clear();
        self.page_requests = 0;
    }
}

fn throttle_problem(more: bool) -> &'static str {
    if more {
        "YouTube is limiting playlist requests. Try again shortly."
    } else {
        "YouTube is limiting searches. Try again shortly."
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
        assert_eq!(query, Work::Initial(Query::Search("third".into())));
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
    fn play_next_accepts_current_video_search_results_only() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut catalog = Catalog::with_sender(sender);
        let now = Instant::now();
        let id = "M7lc1UVf-VE";
        catalog.submit("music", now);
        let (revision, _) = receiver.try_recv().unwrap();
        assert!(!catalog.can_queue_video(id, now));
        assert!(catalog.receive(revision, Ok(Results::Search(vec![result("Example")])), now));
        assert!(catalog.can_queue_video(id, now));
        assert!(!catalog.can_queue_video("dQw4w9WgXcQ", now));
        assert!(!catalog.can_queue_video(id, now + Duration::from_secs(25 * 60 * 60)));

        catalog.submit("https://www.youtube.com/playlist?list=PL_1234567890", now);
        let (revision, _) = receiver.try_recv().unwrap();
        assert!(catalog.receive(
            revision,
            Ok(Results::Playlist(PlaylistItems {
                items: vec![result("Example")],
                next_page_token: None,
                truncated: false,
                unavailable: 0,
            })),
            now,
        ));
        assert!(!catalog.can_queue_video(id, now));
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
        assert_eq!(query, Work::Initial(Query::Playlist(id.into())));
        assert!(!catalog.can_open_playlist_video("M7lc1UVf-VE", now));
        assert!(catalog.receive(
            revision,
            Ok(Results::Playlist(PlaylistItems {
                items: vec![result("Available")],
                next_page_token: Some("later".into()),
                truncated: false,
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
    fn playlist_queue_uses_only_the_current_displayed_rows() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut catalog = Catalog::with_sender(sender);
        let now = Instant::now();
        let revision = open_playlist(&mut catalog, &receiver, now, "later");
        assert_eq!(
            catalog
                .playlist_queue_ids(revision, 1, now)
                .unwrap()
                .collect::<Vec<_>>(),
            ["M7lc1UVf-VE"]
        );
        assert!(catalog.playlist_queue_ids(revision + 1, 1, now).is_none());
        assert!(receiver.try_recv().is_err());

        catalog.load_more(revision, now);
        let (request, _) = receiver.try_recv().unwrap();
        assert!(catalog.playlist_queue_ids(revision, 1, now).is_none());
        let mut later = result("Later");
        later.id = "dQw4w9WgXcQ".into();
        assert!(catalog.receive(request, playlist_page(vec![later], None, 2), now));
        assert!(catalog.playlist_queue_ids(revision, 1, now).is_none());
        assert_eq!(
            catalog
                .playlist_queue_ids(revision, 2, now)
                .unwrap()
                .collect::<Vec<_>>(),
            ["M7lc1UVf-VE", "dQw4w9WgXcQ"]
        );
        assert!(catalog.playlist_queue_ids(revision, 3, now).is_none());
        let expiry = now + Duration::from_secs(24 * 60 * 60);
        assert!(catalog.playlist_queue_ids(revision, 2, expiry).is_none());

        catalog.submit("replacement", now);
        let (request, _) = receiver.try_recv().unwrap();
        assert!(catalog.receive(request, Ok(Results::Search(vec![result("Other")])), now));
        assert!(catalog.playlist_queue_ids(revision, 1, now).is_none());
    }

    #[test]
    fn playlist_queue_rejects_a_playlist_without_any_available_rows() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut catalog = Catalog::with_sender(sender);
        let now = Instant::now();
        catalog.submit("https://www.youtube.com/playlist?list=PL_1234567890", now);
        let (request, _) = receiver.try_recv().unwrap();
        let revision = catalog.view().playlist.as_ref().unwrap().revision;
        assert!(catalog.receive(request, playlist_page(vec![], None, 2), now));
        assert!(catalog.playlist_queue_ids(revision, 0, now).is_none());
    }

    #[test]
    fn playlist_continuation_appends_ordered_occurrences_and_keeps_the_token_private() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut catalog = Catalog::with_sender(sender);
        let now = Instant::now();
        let token = "opaque+cursor&1";
        let revision = open_playlist(&mut catalog, &receiver, now, token);
        assert!(receiver.try_recv().is_err());
        catalog.load_more(revision + 1, now);
        assert!(receiver.try_recv().is_err());

        catalog.load_more(revision, now);
        let (request, _) = receiver.try_recv().unwrap();
        catalog.load_more(revision, now);
        assert!(receiver.try_recv().is_err());
        let wire = serde_json::to_value(catalog.view()).unwrap();
        assert_eq!(wire["pending"], false);
        assert_eq!(wire["playlist"]["pending"], true);
        assert!(!wire.to_string().contains(token));

        let mut later = result("Last");
        later.id = "dQw4w9WgXcQ".into();
        assert!(catalog.receive(
            request,
            playlist_page(vec![result("Repeated"), later], None, 2),
            now
        ));
        assert_eq!(
            catalog
                .view()
                .results
                .iter()
                .map(|item| item.title.as_str())
                .collect::<Vec<_>>(),
            ["First", "Repeated", "Last"]
        );
        assert_eq!(catalog.view().results[0].id, catalog.view().results[1].id);
        let playlist = catalog.view().playlist.as_ref().unwrap();
        assert_eq!(playlist.unavailable, 3);
        assert!(!playlist.has_more);
        assert!(catalog.can_open_playlist_video("dQw4w9WgXcQ", now));
    }

    #[test]
    fn playlist_continuation_retries_only_on_request_and_preserves_previous_rows() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut catalog = Catalog::with_sender(sender);
        let now = Instant::now();
        let revision = open_playlist(&mut catalog, &receiver, now, "later");
        catalog.load_more(revision, now);
        let (failed, page) = receiver.try_recv().unwrap();
        assert!(catalog.receive(failed, Err(LookupError::Throttled), now));
        assert!(receiver.try_recv().is_err());
        assert_eq!(catalog.view().results[0].title, "First");
        assert!(catalog.view().problem.is_none());
        let playlist = catalog.view().playlist.as_ref().unwrap();
        assert!(playlist.has_more && !playlist.pending && playlist.problem.is_some());

        catalog.load_more(revision, now);
        assert!(receiver.try_recv().is_err());
        catalog.load_more(revision, now + THROTTLE_DELAY);
        let (retry, requested_page) = receiver.try_recv().unwrap();
        assert_ne!(failed, retry);
        assert_eq!(requested_page, page);
        assert!(!catalog.receive(
            failed,
            playlist_page(vec![result("Stale retry")], None, 0),
            now
        ));
        assert!(catalog.receive(
            retry,
            playlist_page(vec![result("New")], None, 0),
            now + THROTTLE_DELAY
        ));
        assert!(catalog.view().playlist.as_ref().unwrap().problem.is_none());
        assert_eq!(catalog.view().results[1].title, "New");
    }

    #[test]
    fn playlist_continuation_cannot_revive_an_expired_or_replaced_catalog() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut catalog = Catalog::with_sender(sender);
        let now = Instant::now();
        let revision = open_playlist(&mut catalog, &receiver, now, "later");
        catalog.load_more(revision, now);
        let (stale, _) = receiver.try_recv().unwrap();
        catalog.submit("replacement", now);
        assert!(!catalog.receive(stale, playlist_page(vec![result("Stale")], None, 0), now));
        let (current, _) = receiver.try_recv().unwrap();
        assert!(catalog.receive(current, Ok(Results::Search(vec![result("Search")])), now));
        assert!(catalog.view().playlist.is_none());
        assert_eq!(catalog.view().results[0].title, "Search");

        let revision = open_playlist(&mut catalog, &receiver, now, "later");
        let expired = now + Duration::from_secs(24 * 60 * 60);
        catalog.load_more(revision, expired - Duration::from_secs(1));
        let (stale, _) = receiver.try_recv().unwrap();
        assert!(catalog.receive(
            stale,
            playlist_page(vec![result("Expired")], None, 0),
            expired
        ));
        assert!(catalog.view().playlist.is_none());
        assert!(catalog.view().results.is_empty());
        catalog.load_more(revision, expired);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn playlist_continuation_stops_when_a_cursor_repeats() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut catalog = Catalog::with_sender(sender);
        let now = Instant::now();
        let revision = open_playlist(&mut catalog, &receiver, now, "same");
        catalog.load_more(revision, now);
        let (request, _) = receiver.try_recv().unwrap();
        assert!(catalog.receive(
            request,
            playlist_page(vec![result("Second")], Some("same"), 0),
            now
        ));
        let playlist = catalog.view().playlist.as_ref().unwrap();
        assert!(!playlist.has_more);
        assert!(playlist.truncated);
        assert_eq!(catalog.view().results[1].title, "Second");
        catalog.load_more(revision, now);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn playlist_continuation_bounds_rows_and_dispatched_retries() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut catalog = Catalog::with_sender(sender);
        let now = Instant::now();
        let id = "https://www.youtube.com/playlist?list=PL_1234567890";
        catalog.submit(id, now);
        let (first, _) = receiver.try_recv().unwrap();
        let full_page = |page: usize| {
            playlist_page(
                (0..50).map(|_| result("Track")).collect(),
                Some(&format!("cursor-{page}")),
                0,
            )
        };
        assert!(catalog.receive(first, full_page(1), now));
        let revision = catalog.view().playlist.as_ref().unwrap().revision;
        for page in 2..=10 {
            catalog.load_more(revision, now);
            let (request, _) = receiver.try_recv().unwrap();
            assert!(catalog.receive(request, full_page(page), now));
        }
        assert_eq!(catalog.view().results.len(), 500);
        assert!(catalog.view().playlist.as_ref().unwrap().truncated);
        catalog.load_more(revision, now);
        assert!(receiver.try_recv().is_err());

        catalog.submit("replacement.invalid/", now);
        let revision = open_playlist(&mut catalog, &receiver, now, "retry");
        for _ in 0..12 {
            catalog.load_more(revision, now);
            let (request, _) = receiver.try_recv().unwrap();
            assert!(catalog.receive(request, Err(LookupError::Network), now));
        }
        let playlist = catalog.view().playlist.as_ref().unwrap();
        assert!(playlist.truncated);
        assert!(!playlist.has_more);
        assert_eq!(catalog.view().results[0].title, "First");
        catalog.load_more(revision, now);
        assert!(receiver.try_recv().is_err());
    }

    fn open_playlist(
        catalog: &mut Catalog,
        receiver: &mpsc::Receiver<Request>,
        time: Instant,
        token: &str,
    ) -> u64 {
        catalog.submit("https://www.youtube.com/playlist?list=PL_1234567890", time);
        let (request, _) = receiver.try_recv().unwrap();
        assert!(catalog.receive(
            request,
            playlist_page(vec![result("First")], Some(token), 1),
            time
        ));
        catalog.view().playlist.as_ref().unwrap().revision
    }

    fn playlist_page(
        items: Vec<SearchResult>,
        token: Option<&str>,
        unavailable: usize,
    ) -> Response {
        Ok(Results::Playlist(PlaylistItems {
            items,
            next_page_token: token.map(str::to_owned),
            truncated: false,
            unavailable,
        }))
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
