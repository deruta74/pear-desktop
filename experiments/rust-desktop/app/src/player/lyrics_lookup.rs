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
    lyrics::{Client, Document, LookupError, normalize_query},
    metadata_lookup::Retention,
};

pub(super) type Response = Result<Option<Document>, LookupError>;

struct Request {
    revision: u64,
    title: String,
    artist: String,
    duration: u32,
}

#[derive(Default, Serialize)]
pub(super) struct View {
    track: String,
    artist: String,
    duration: Option<u32>,
    pending: bool,
    problem: Option<&'static str>,
    result: Option<Document>,
}

pub(super) struct Lookup {
    sender: SyncSender<Request>,
    selected: Option<String>,
    view: View,
    revision: u64,
    submitted: bool,
    in_flight: Option<u64>,
    waiting: Option<Request>,
    expires: Option<Retention>,
    throttled_until: Option<Instant>,
}

impl Lookup {
    pub(super) fn new(events: EventLoopProxy<PlayerEvent>) -> io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel::<Request>(1);
        thread::Builder::new()
            .name("lrclib".into())
            .spawn(move || {
                let client = Client::new();
                while let Ok(request) = receiver.recv() {
                    let response = client.lookup(&request.title, &request.artist, request.duration);
                    if events
                        .send_event(PlayerEvent::LyricsResult(request.revision, response))
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
            sender,
            selected: None,
            view: View::default(),
            revision: 0,
            submitted: false,
            in_flight: None,
            waiting: None,
            expires: None,
            throttled_until: None,
        }
    }

    pub(super) fn select(&mut self, id: Option<&str>, title: Option<&str>, channel: Option<&str>) {
        if self.selected.as_deref() != id {
            self.revision += 1;
            self.selected = id.map(str::to_owned);
            self.view = View::default();
            self.waiting = None;
            self.expires = None;
            self.submitted = false;
        }
        if !self.submitted && self.selected.is_some() {
            let title = title.unwrap_or_default();
            let (artist, track) = title
                .split_once(" - ")
                .or_else(|| title.split_once(" – "))
                .unwrap_or_else(|| {
                    let channel = channel.unwrap_or_default();
                    (channel.strip_suffix(" - Topic").unwrap_or(channel), title)
                });
            self.view.artist = normalize_query(artist).unwrap_or_default();
            self.view.track = normalize_query(track).unwrap_or_default();
        }
    }

    pub(super) fn set_duration(&mut self, duration: Option<u32>) -> bool {
        let duration = duration.filter(|duration| self.selected.is_some() && *duration > 0);
        if self.view.duration == duration {
            return false;
        }
        self.view.duration = duration;
        true
    }

    pub(super) fn submit(&mut self, title: &str, artist: &str, time: Instant) {
        if self.selected.is_none() {
            return;
        }
        self.revision += 1;
        self.waiting = None;
        self.view.result = None;
        self.view.pending = false;
        self.view.problem = None;
        self.expires = None;
        let (Some(title), Some(artist)) = (normalize_query(title), normalize_query(artist)) else {
            self.view.problem = Some("Enter a track and artist of up to 160 characters each.");
            return;
        };
        self.submitted = true;
        self.view.track.clone_from(&title);
        self.view.artist.clone_from(&artist);
        let Some(duration) = self.view.duration else {
            self.view.problem = Some("Start the video before looking up lyrics.");
            return;
        };
        self.waiting = Some(Request {
            revision: self.revision,
            title,
            artist,
            duration,
        });
        self.view.pending = true;
        self.send_next(time);
    }

    fn send_next(&mut self, time: Instant) {
        if self.in_flight.is_some() {
            return;
        }
        let Some(request) = self.waiting.take() else {
            return;
        };
        let revision = request.revision;
        if self.throttled_until.is_some_and(|until| until > time) {
            self.view.problem = Some("LRCLIB is limiting requests. Try again shortly.");
        } else if self.sender.try_send(request).is_ok() {
            self.in_flight = Some(revision);
            return;
        } else {
            self.view.problem = Some("Could not start lyrics lookup. Restart Pear to retry.");
        }
        self.view.pending = false;
    }

    pub(super) fn receive(&mut self, revision: u64, response: Response, time: Instant) -> bool {
        if self.in_flight != Some(revision) {
            return false;
        }
        self.in_flight = None;
        let is_current = revision == self.revision;
        if matches!(response, Err(LookupError::Throttled)) {
            self.throttled_until = Some(time + Duration::from_secs(60));
        }
        if is_current {
            self.view.pending = false;
            match response {
                Ok(Some(document)) => {
                    self.view.result = Some(document);
                    self.expires = Some(Retention::new(time));
                }
                Ok(None) => self.view.problem = Some("No lyrics found for this recording."),
                Err(LookupError::Throttled) => {
                    self.view.problem = Some("LRCLIB is limiting requests. Try again shortly.");
                }
                Err(_) => self.view.problem = Some("Could not load lyrics from LRCLIB. Try again."),
            }
        }
        let was_pending = self.view.pending;
        self.send_next(time);
        is_current || was_pending != self.view.pending
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
        self.expires = None;
        self.view.result = None;
        true
    }

    pub(super) fn view(&self) -> Option<&View> {
        self.selected.as_ref().map(|_| &self.view)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lyrics_lookup_requires_duration_and_ignores_a_previous_video_result() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut lookup = Lookup::with_sender(sender);
        let now = Instant::now();
        lookup.select(Some("first"), Some("Artist - Track"), None);
        lookup.submit("Track", "Artist", now);
        assert!(lookup.view().unwrap().problem.is_some());
        assert!(receiver.try_recv().is_err());

        assert!(lookup.set_duration(Some(200)));
        lookup.submit("Track", "Artist", now);
        let first = receiver.try_recv().unwrap();
        assert_eq!(first.duration, 200);
        lookup.select(Some("second"), Some("Next track"), Some("Band - Topic"));
        assert!(lookup.set_duration(Some(190)));
        lookup.submit("Next track", "Band", now);
        assert!(!lookup.receive(first.revision, Ok(Some(Document::Instrumental)), now));
        let second = receiver.try_recv().unwrap();
        assert_eq!(second.artist, "Band");
        assert!(lookup.view().unwrap().result.is_none());
        assert!(lookup.receive(second.revision, Ok(Some(Document::Instrumental)), now));
        assert!(lookup.view().unwrap().result.is_some());
    }
}
