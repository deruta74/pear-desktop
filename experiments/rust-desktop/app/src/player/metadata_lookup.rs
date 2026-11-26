use std::{
    io,
    sync::mpsc::{self, SyncSender},
    thread,
    time::{Duration, Instant, SystemTime},
};

use tao::event_loop::EventLoopProxy;

use super::{
    PlayerEvent,
    metadata::{Client, LookupError, Metadata},
};

const RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
const CLOCK_CHECK_INTERVAL: Duration = Duration::from_secs(5 * 60);
const RETRY_DELAY: Duration = Duration::from_secs(30);
const THROTTLE_DELAY: Duration = Duration::from_secs(60);
const MAX_ATTEMPTS: u8 = 2;

pub(super) type Response = Result<Option<Metadata>, LookupError>;
type StartWorker = Box<dyn FnOnce() -> io::Result<SyncSender<String>>>;

pub(super) struct Retention {
    deadline: Instant,
    wall: SystemTime,
}

impl Retention {
    pub(super) fn new(time: Instant) -> Self {
        Self {
            deadline: time + RETENTION,
            wall: SystemTime::now() + RETENTION,
        }
    }

    pub(super) fn deadline(&self) -> Instant {
        let remaining = self
            .wall
            .duration_since(SystemTime::now())
            .unwrap_or_default();
        self.deadline
            .min(Instant::now() + remaining.min(CLOCK_CHECK_INTERVAL))
    }

    pub(super) fn expired(&self, time: Instant) -> bool {
        self.deadline <= time || self.wall <= SystemTime::now()
    }
}

pub(super) struct Lookup {
    start_worker: Option<StartWorker>,
    sender: Option<SyncSender<String>>,
    selected: Option<String>,
    requested: Option<String>,
    metadata: Option<Metadata>,
    expires: Option<Retention>,
    retry_after: Option<Instant>,
    attempts: u8,
    problem: Option<&'static str>,
}

impl Lookup {
    pub(super) fn new(client: Client, events: EventLoopProxy<PlayerEvent>) -> Self {
        Self::with_start_worker(move || {
            let (sender, receiver) = mpsc::sync_channel::<String>(1);
            thread::Builder::new()
                .name("youtube-metadata".into())
                .spawn(move || {
                    while let Ok(id) = receiver.recv() {
                        let response = client.lookup(&id);
                        if events
                            .send_event(PlayerEvent::Metadata(id, response))
                            .is_err()
                        {
                            break;
                        }
                    }
                })?;
            Ok(sender)
        })
    }

    #[cfg(test)]
    fn with_sender(sender: SyncSender<String>) -> Self {
        Self::with_start_worker(move || Ok(sender))
    }

    fn with_start_worker(
        start_worker: impl FnOnce() -> io::Result<SyncSender<String>> + 'static,
    ) -> Self {
        Self {
            start_worker: Some(Box::new(start_worker)),
            sender: None,
            selected: None,
            requested: None,
            metadata: None,
            expires: None,
            retry_after: None,
            attempts: 0,
            problem: None,
        }
    }

    pub(super) fn select(&mut self, id: Option<&str>) {
        if id == self.selected.as_deref() {
            return;
        }
        self.selected = id.map(str::to_owned);
        self.metadata = None;
        self.expires = None;
        self.attempts = 0;
        self.request(Instant::now());
    }

    fn can_request(&self) -> bool {
        self.selected.is_some()
            && self.requested.is_none()
            && self.problem.is_none()
            && self.attempts < MAX_ATTEMPTS
    }

    fn request(&mut self, time: Instant) {
        if !self.can_request() || self.retry_after.is_some_and(|retry| retry > time) {
            return;
        }
        let Some(id) = &self.selected else { return };
        self.retry_after = None;
        if let Some(start_worker) = self.start_worker.take() {
            match start_worker() {
                Ok(sender) => self.sender = Some(sender),
                Err(_) => {
                    self.problem =
                        Some("Could not start the YouTube details service. Restart Pear to retry.");
                    return;
                }
            }
        }
        if self
            .sender
            .as_ref()
            .is_some_and(|sender| sender.try_send(id.clone()).is_ok())
        {
            self.requested = Some(id.clone());
            self.attempts += 1;
        } else {
            self.problem = Some("The YouTube details service stopped. Restart Pear to retry.");
        }
    }

    pub(super) fn receive(&mut self, id: &str, response: Response, time: Instant) -> bool {
        if self.requested.as_deref() != Some(id) {
            return false;
        }
        self.requested = None;
        let is_current = self.selected.as_deref() == Some(id);
        if is_current {
            // The selection can return to a request that was still in flight.
            self.attempts = self.attempts.max(1);
        }
        match response {
            Ok(metadata) if is_current => {
                self.expires = metadata.as_ref().map(|_| Retention::new(time));
                self.metadata = metadata;
            }
            Ok(_) => {}
            Err(LookupError::InvalidKey) => {
                self.problem = Some("YouTube rejected the configured API key.");
            }
            Err(LookupError::InvalidKeyConfiguration) => {
                self.problem = Some("Could not read a YouTube API key from the configured file.");
            }
            Err(LookupError::QuotaExceeded) => {
                self.problem = Some("The configured YouTube API key has reached its quota.");
            }
            Err(LookupError::Throttled) => self.retry_after = Some(time + THROTTLE_DELAY),
            Err(LookupError::InvalidVideoId) => {}
            Err(_) => self.retry_after = Some(time + RETRY_DELAY),
        }
        if !is_current {
            self.request(time);
        }
        is_current || self.problem.is_some()
    }

    pub(super) fn deadline(&self) -> Option<Instant> {
        let clock_check = self.expires.as_ref().map(Retention::deadline);
        let retry = self.retry_after.filter(|_| self.can_request());
        clock_check.into_iter().chain(retry).min()
    }

    pub(super) fn tick(&mut self, time: Instant) -> bool {
        let expired = self
            .expires
            .as_ref()
            .is_some_and(|expiry| expiry.expired(time));
        if expired {
            self.metadata = None;
            self.expires = None;
            self.attempts = 0;
        }
        let retry_due = self.retry_after.is_some_and(|retry| retry <= time);
        if expired || retry_due {
            self.request(time);
        }
        expired || (retry_due && self.problem.is_some())
    }

    pub(super) fn metadata(&self) -> Option<&Metadata> {
        self.metadata.as_ref()
    }

    pub(super) fn problem(&self) -> Option<&'static str> {
        self.problem
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, rc::Rc, sync::mpsc::TryRecvError};

    const FIRST: &str = "M7lc1UVf-VE";
    const SECOND: &str = "jNQXAC9IVRw";
    const THIRD: &str = "aqz-KE-bpKQ";

    fn found(title: &str) -> Metadata {
        Metadata {
            title: title.into(),
            channel: "Example channel".into(),
            thumbnail_url: None,
        }
    }

    #[test]
    fn starts_the_worker_only_when_a_video_is_selected() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let starts = Rc::new(Cell::new(0));
        let recorded = Rc::clone(&starts);
        let mut lookup = Lookup::with_start_worker(move || {
            recorded.set(recorded.get() + 1);
            Ok(sender)
        });
        lookup.select(None);
        lookup.tick(Instant::now());
        assert_eq!(starts.get(), 0);
        assert_eq!(receiver.try_recv(), Err(TryRecvError::Empty));

        lookup.select(Some(FIRST));
        assert_eq!(starts.get(), 1);
        assert_eq!(receiver.try_recv().unwrap(), FIRST);
        assert!(lookup.receive(FIRST, Ok(None), Instant::now()));
        lookup.select(Some(SECOND));
        assert_eq!(starts.get(), 1);
        assert_eq!(receiver.try_recv().unwrap(), SECOND);
    }

    #[test]
    fn skips_intermediate_selections_and_discards_an_old_lookup() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut lookup = Lookup::with_sender(sender);
        lookup.select(Some(FIRST));
        lookup.select(Some(FIRST));
        assert_eq!(receiver.try_recv().unwrap(), FIRST);
        lookup.select(Some(SECOND));
        lookup.select(Some(THIRD));
        assert_eq!(receiver.try_recv(), Err(TryRecvError::Empty));
        assert!(!lookup.receive(FIRST, Ok(Some(found("Old"))), Instant::now()));
        assert!(lookup.metadata().is_none());
        assert_eq!(receiver.try_recv().unwrap(), THIRD);
        assert!(lookup.receive(THIRD, Ok(Some(found("Current"))), Instant::now()));
        assert_eq!(lookup.metadata().unwrap().title, "Current");
    }

    #[test]
    fn expires_transient_metadata_and_requests_current_selection_again() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut lookup = Lookup::with_sender(sender);
        let time = Instant::now();
        lookup.select(Some(FIRST));
        assert_eq!(receiver.try_recv().unwrap(), FIRST);
        assert!(lookup.receive(FIRST, Ok(Some(found("Title"))), time));
        assert!(!lookup.tick(time + RETENTION - Duration::from_secs(1)));
        assert!(lookup.tick(time + RETENTION));
        assert!(lookup.metadata().is_none());
        assert_eq!(receiver.try_recv().unwrap(), FIRST);
    }

    #[test]
    fn rejected_credentials_disable_further_requests_for_this_session() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut lookup = Lookup::with_sender(sender);
        lookup.select(Some(FIRST));
        assert_eq!(receiver.try_recv().unwrap(), FIRST);
        lookup.select(Some(SECOND));
        assert!(lookup.receive(FIRST, Err(LookupError::InvalidKey), Instant::now()));
        lookup.select(Some(THIRD));
        assert!(lookup.problem().is_some());
        assert_eq!(receiver.try_recv(), Err(TryRecvError::Empty));
    }

    #[test]
    fn retries_the_latest_selection_after_a_failed_lookup_without_retrying_forever() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut lookup = Lookup::with_sender(sender);
        let now = Instant::now();
        lookup.select(Some(FIRST));
        assert_eq!(receiver.try_recv().unwrap(), FIRST);
        lookup.select(Some(SECOND));
        assert!(!lookup.receive(FIRST, Err(LookupError::Throttled), now));
        assert_eq!(lookup.deadline(), Some(now + THROTTLE_DELAY));
        lookup.tick(now + THROTTLE_DELAY);
        assert_eq!(receiver.try_recv().unwrap(), SECOND);

        let next = now + THROTTLE_DELAY;
        assert!(lookup.receive(SECOND, Err(LookupError::Network), next));
        lookup.tick(next + RETRY_DELAY);
        assert_eq!(receiver.try_recv().unwrap(), SECOND);
        assert!(lookup.receive(SECOND, Err(LookupError::Network), next + RETRY_DELAY));
        assert_eq!(lookup.deadline(), None);
        lookup.tick(next + RETRY_DELAY * 2);
        assert_eq!(receiver.try_recv(), Err(TryRecvError::Empty));
    }

    #[test]
    fn uses_the_wall_clock_to_drop_cached_metadata_after_suspend() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut lookup = Lookup::with_sender(sender);
        let now = Instant::now();
        lookup.select(Some(FIRST));
        assert_eq!(receiver.try_recv().unwrap(), FIRST);
        assert!(lookup.receive(FIRST, Ok(Some(found("Old title"))), now));
        lookup.expires = Some(Retention {
            deadline: now + RETENTION,
            wall: SystemTime::UNIX_EPOCH,
        });
        assert!(lookup.tick(now));
        assert!(lookup.metadata().is_none());
        assert_eq!(receiver.try_recv().unwrap(), FIRST);
    }
}
