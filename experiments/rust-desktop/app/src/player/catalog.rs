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
    metadata::{Client, LookupError, SearchResult, normalize_query},
    metadata_lookup::Retention,
};

const THROTTLE_DELAY: Duration = Duration::from_secs(60);

pub(super) type Response = Result<Vec<SearchResult>, LookupError>;
type Request = (u64, String);

#[derive(Default, Serialize)]
pub(super) struct View {
    query: String,
    pending: bool,
    results: Vec<SearchResult>,
    problem: Option<&'static str>,
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
                    if events
                        .send_event(PlayerEvent::SearchResults(revision, client.search(&query)))
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
        let query = normalize_query(input);
        if query.as_deref() == Some(self.view.query.as_str())
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
        let Some(query) = query else {
            self.view.problem = Some("Enter a search of up to 160 characters.");
            return;
        };
        self.view.query.clone_from(&query);
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
        let is_current = self.view.pending && self.view.query == query;
        match response {
            Ok(results) if is_current => {
                self.expires = Some(Retention::new(time));
                self.view.results = results;
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
            _ => return "Could not search YouTube. Try again.",
        };
        self.unavailable = Some(unavailable);
        unavailable
    }

    pub(super) fn deadline(&self) -> Option<Instant> {
        self.expires.as_ref().map(Retention::deadline)
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
        assert!(!catalog.receive(first, Ok(vec![result("Old")]), now));
        let (third, query) = receiver.try_recv().unwrap();
        assert_eq!(query, "third");
        assert!(catalog.view().results.is_empty());
        assert!(catalog.receive(third, Ok(vec![result("Newest")]), now));
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
        assert!(catalog.receive(second, Ok(vec![]), now + THROTTLE_DELAY));
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
        assert!(catalog.receive(first, Ok(vec![result("Reused")]), now));
        assert_eq!(catalog.view().results[0].title, "Reused");
        assert_eq!(receiver.try_recv(), Err(TryRecvError::Empty));
    }
}
