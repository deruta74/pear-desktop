//! Session-only account browsing for the local Library.
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tao::event_loop::EventLoopProxy;

use super::{PlayerEvent, account_catalog as catalog, account_oauth as oauth};

#[cfg(test)]
mod tests;

// Cancellation may leave an eight-second token exchange and an eight-second revocation.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(20);

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ShutdownStatus {
    Waiting,
    Finished,
    RevocationFailed,
    TimedOut,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Command {
    ConnectAccount {},
    CancelAccount {},
    DisconnectAccount {},
    ShowAccountCollection { collection: TopLevel },
    OpenAccountPlaylist { page: u32, row: usize },
    OpenAccountVideo { page: u32, row: usize },
    NextAccountPage { page: u32 },
    RetryAccountPage {},
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TopLevel {
    OwnedPlaylists,
    LikedVideos,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct View<'a> {
    status: &'static str,
    message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    collection: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    page: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rows: Option<Vec<Row<'a>>>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    has_next: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    retry: bool,
}

#[derive(Serialize)]
struct Row<'a> {
    title: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    attribution: Option<&'a str>,
}

pub(super) struct Panel {
    config: Option<oauth::ClientConfig>,
    phase: Phase,
    sequence: u32,
    message: &'static str,
}

enum Phase {
    Unavailable,
    Disconnected,
    RevocationFailed,
    Connecting {
        stamp: u32,
        cancelled: Arc<AtomicBool>,
    },
    Cancelling(u32),
    RevokingCancelledSignIn(u32),
    Connected {
        session: Arc<oauth::Session>,
        browse: Box<Browse>,
    },
    Disconnecting(u32),
}

#[derive(Clone)]
struct Query {
    collection: catalog::Collection,
    token: Option<String>,
    title: Option<String>,
}

struct Browse {
    query: Query,
    stamp: u32,
    result: Option<Result<catalog::Page, catalog::Error>>,
}

pub(super) struct Job {
    stamp: u32,
    kind: JobKind,
}

enum JobKind {
    Authorize {
        config: oauth::ClientConfig,
        cancelled: Arc<AtomicBool>,
    },
    Fetch {
        session: Arc<oauth::Session>,
        query: Query,
    },
    Revoke(Arc<oauth::Session>),
    Open(String),
}

pub(super) enum Outcome {
    Authorized(Result<oauth::Session, oauth::Error>),
    Page(Result<catalog::Page, catalog::Error>),
    Revoked(Result<(), oauth::Error>),
    OpenFailed,
    WorkerUnavailable,
}

impl Panel {
    pub(super) fn from_env() -> Option<Self> {
        match oauth::ClientConfig::from_env() {
            Ok(None) => None,
            Ok(Some(config)) => Some(Self::configured(config)),
            Err(error) => Some(Self {
                config: None,
                phase: Phase::Unavailable,
                sequence: 0,
                message: error.message(),
            }),
        }
    }

    fn configured(config: oauth::ClientConfig) -> Self {
        Self {
            config: Some(config),
            phase: Phase::Disconnected,
            sequence: 0,
            message: "Connect to browse your YouTube account.",
        }
    }

    fn stamp(&mut self) -> u32 {
        self.sequence = self.sequence.wrapping_add(1);
        self.sequence
    }

    pub(super) fn deadline(&self) -> Option<Instant> {
        match &self.phase {
            Phase::Connected { session, .. } => Some(session.expires_at()),
            _ => None,
        }
    }

    pub(super) fn expire(&mut self, now: Instant) -> bool {
        if let Phase::Connected { session, .. } = &self.phase
            && (now >= session.expires_at() || session.bearer().is_none())
        {
            self.disconnected("Your YouTube session expired. Connect again.");
            return true;
        }
        false
    }

    fn cancel_sign_in(&mut self) {
        if let Phase::Connecting { stamp, cancelled } = &self.phase {
            cancelled.store(true, Ordering::Release);
            self.phase = Phase::Cancelling(*stamp);
            self.message = "Cancelling YouTube sign-in…";
        }
    }

    pub(super) fn begin_shutdown(&mut self, now: Instant) -> Option<Instant> {
        self.cancel_sign_in();
        if self.cleanup_pending() {
            return Some(now + SHUTDOWN_GRACE);
        }
        if let Phase::Connected { session, .. } = &self.phase {
            session.disconnect();
            self.disconnected("YouTube account disconnected.");
        }
        None
    }

    pub(super) fn shutdown_status(&self, deadline: Instant, now: Instant) -> ShutdownStatus {
        if self.cleanup_pending() {
            if now < deadline {
                ShutdownStatus::Waiting
            } else {
                ShutdownStatus::TimedOut
            }
        } else if matches!(self.phase, Phase::RevocationFailed) {
            ShutdownStatus::RevocationFailed
        } else {
            ShutdownStatus::Finished
        }
    }

    fn cleanup_pending(&self) -> bool {
        matches!(
            self.phase,
            Phase::Cancelling(_) | Phase::RevokingCancelledSignIn(_) | Phase::Disconnecting(_)
        )
    }

    pub(super) fn apply(&mut self, command: Command) -> Option<Job> {
        self.expire(Instant::now());
        match command {
            Command::ConnectAccount {}
                if matches!(self.phase, Phase::Disconnected | Phase::RevocationFailed) =>
            {
                let config = self.config.clone()?;
                let stamp = self.stamp();
                let cancelled = Arc::new(AtomicBool::new(false));
                self.phase = Phase::Connecting {
                    stamp,
                    cancelled: cancelled.clone(),
                };
                self.message = "Complete Google sign-in in your browser.";
                Some(Job {
                    stamp,
                    kind: JobKind::Authorize { config, cancelled },
                })
            }
            Command::CancelAccount {} => {
                self.cancel_sign_in();
                None
            }
            Command::DisconnectAccount {} => {
                let (session, _) = self.connected()?;
                session.disconnect();
                let session = session.clone();
                let stamp = self.stamp();
                self.phase = Phase::Disconnecting(stamp);
                self.message = "Disconnecting from YouTube…";
                Some(Job {
                    stamp,
                    kind: JobKind::Revoke(session),
                })
            }
            Command::ShowAccountCollection { collection } => {
                let (_, browse) = self.connected()?;
                // Hold at most one catalog request at a time for each session.
                browse.result.as_ref()?;
                self.fetch(Query::top_level(collection))
            }
            Command::OpenAccountPlaylist { page, row } => {
                let (_, browse) = self.connected()?;
                if !browse.is_playlists() {
                    return None;
                }
                let playlist = browse.page(page)?.items.get(row)?;
                self.fetch(Query {
                    collection: catalog::Collection::PlaylistItems(playlist.id.clone()),
                    token: None,
                    title: Some(playlist.title.clone()),
                })
            }
            Command::OpenAccountVideo { page, row } => {
                let (_, browse) = self.connected()?;
                if browse.is_playlists() {
                    return None;
                }
                let video = browse.page(page)?.items.get(row)?;
                crate::library::valid_id(&video.id).then(|| Job {
                    stamp: page,
                    kind: JobKind::Open(format!("https://www.youtube.com/watch?v={}", video.id)),
                })
            }
            Command::NextAccountPage { page } => {
                let (_, browse) = self.connected()?;
                let token = browse.page(page)?.next_page_token.clone()?;
                self.fetch(Query {
                    token: Some(token),
                    ..browse.query.clone()
                })
            }
            Command::RetryAccountPage {} => {
                let (_, browse) = self.connected()?;
                browse.result.as_ref()?.as_ref().err()?;
                self.fetch(browse.query.clone())
            }
            _ => None,
        }
    }

    fn connected(&self) -> Option<(&Arc<oauth::Session>, &Browse)> {
        match &self.phase {
            Phase::Connected { session, browse } => Some((session, browse)),
            _ => None,
        }
    }

    fn fetch(&mut self, query: Query) -> Option<Job> {
        let (session, _) = self.connected()?;
        let session = session.clone();
        Some(self.start_fetch(session, query))
    }

    fn start_fetch(&mut self, session: Arc<oauth::Session>, query: Query) -> Job {
        let stamp = self.stamp();
        self.phase = Phase::Connected {
            session: session.clone(),
            browse: Box::new(Browse {
                query: query.clone(),
                stamp,
                result: None,
            }),
        };
        self.message = "Loading your YouTube account…";
        Job {
            stamp,
            kind: JobKind::Fetch { session, query },
        }
    }

    fn disconnected(&mut self, message: &'static str) {
        self.phase = Phase::Disconnected;
        self.message = message;
    }

    fn revocation_failed(&mut self) {
        self.phase = Phase::RevocationFailed;
        self.message = oauth::Error::Revocation.message();
    }

    pub(super) fn receive(&mut self, stamp: u32, outcome: Outcome) -> (Option<Job>, bool) {
        if self.expire(Instant::now()) {
            return (None, true);
        }
        match (&mut self.phase, outcome) {
            (Phase::Connecting { stamp: active, .. }, Outcome::Authorized(result))
                if *active == stamp =>
            {
                match result {
                    Ok(session) if session.bearer().is_some() => {
                        let first = self.start_fetch(
                            Arc::new(session),
                            Query::top_level(TopLevel::OwnedPlaylists),
                        );
                        return (Some(first), true);
                    }
                    Ok(_) => self.disconnected("Your YouTube session expired. Connect again."),
                    Err(oauth::Error::Revocation) => self.revocation_failed(),
                    Err(error) => self.disconnected(error.message()),
                }
            }
            (Phase::Connecting { stamp: active, .. }, Outcome::WorkerUnavailable)
                if *active == stamp =>
            {
                self.disconnected(oauth::Error::Unavailable.message());
            }
            (Phase::Cancelling(active), Outcome::Authorized(result)) if *active == stamp => {
                match result {
                    Ok(session) => {
                        let stamp = self.stamp();
                        self.phase = Phase::RevokingCancelledSignIn(stamp);
                        return (
                            Some(Job {
                                stamp,
                                kind: JobKind::Revoke(Arc::new(session)),
                            }),
                            true,
                        );
                    }
                    Err(oauth::Error::Revocation) => self.revocation_failed(),
                    Err(_) => self.disconnected(oauth::Error::Cancelled.message()),
                }
            }
            (Phase::Cancelling(active), Outcome::WorkerUnavailable) if *active == stamp => {
                self.disconnected(oauth::Error::Cancelled.message());
            }
            (Phase::RevokingCancelledSignIn(active), Outcome::Revoked(Ok(())))
                if *active == stamp =>
            {
                self.disconnected(oauth::Error::Cancelled.message());
            }
            (Phase::Disconnecting(active), Outcome::Revoked(Ok(()))) if *active == stamp => {
                self.disconnected("YouTube account disconnected.");
            }
            (
                Phase::RevokingCancelledSignIn(active) | Phase::Disconnecting(active),
                Outcome::Revoked(Err(_)) | Outcome::WorkerUnavailable,
            ) if *active == stamp => {
                self.revocation_failed();
            }
            (Phase::Connected { browse, .. }, Outcome::Page(result))
                if browse.stamp == stamp && browse.result.is_none() =>
            {
                if matches!(result, Err(catalog::Error::Unauthorized)) {
                    self.disconnected(catalog::Error::Unauthorized.message());
                } else {
                    self.message = browse.page_message(&result);
                    browse.result = Some(result);
                }
            }
            (Phase::Connected { browse, .. }, Outcome::WorkerUnavailable)
                if browse.stamp == stamp =>
            {
                if browse.result.is_some() {
                    self.message = "Pear could not open the video in your browser.";
                } else {
                    self.message = catalog::Error::Service.message();
                    browse.result = Some(Err(catalog::Error::Service));
                }
            }
            (Phase::Connected { browse, .. }, Outcome::OpenFailed) if browse.stamp == stamp => {
                self.message = "Pear could not open the video in your browser.";
            }
            _ => return (None, false),
        }
        (None, true)
    }

    pub(super) fn view(&self) -> View<'_> {
        let status = match self.phase {
            Phase::Unavailable => "unavailable",
            Phase::Disconnected | Phase::RevocationFailed => "disconnected",
            Phase::Connecting { .. } => "connecting",
            Phase::Cancelling(_) | Phase::RevokingCancelledSignIn(_) => "cancelling",
            Phase::Connected { .. } => "connected",
            Phase::Disconnecting(_) => "disconnecting",
        };
        let mut view = View {
            status,
            message: self.message,
            collection: None,
            title: None,
            page: None,
            rows: None,
            has_next: false,
            retry: false,
        };
        if let Some((_, browse)) = self.connected() {
            view.collection = Some(match browse.query.collection {
                catalog::Collection::OwnedPlaylists => "owned_playlists",
                catalog::Collection::LikedVideos => "liked_videos",
                catalog::Collection::PlaylistItems(_) => "playlist_items",
            });
            view.title = browse.query.title.as_deref();
            if let Some(result) = &browse.result {
                view.retry = result.is_err();
                if let Ok(page) = result {
                    view.page = Some(browse.stamp);
                    view.has_next = page.next_page_token.is_some();
                    view.rows = Some(
                        page.items
                            .iter()
                            .map(|item| Row {
                                title: &item.title,
                                attribution: (!browse.is_playlists())
                                    .then_some(item.attribution.as_deref())
                                    .flatten(),
                            })
                            .collect(),
                    );
                }
            }
        }
        view
    }
}

impl Query {
    fn top_level(collection: TopLevel) -> Self {
        let collection = match collection {
            TopLevel::OwnedPlaylists => catalog::Collection::OwnedPlaylists,
            TopLevel::LikedVideos => catalog::Collection::LikedVideos,
        };
        Self {
            collection,
            token: None,
            title: None,
        }
    }
}

impl Browse {
    fn is_playlists(&self) -> bool {
        self.query.collection == catalog::Collection::OwnedPlaylists
    }

    fn page(&self, stamp: u32) -> Option<&catalog::Page> {
        if self.stamp != stamp {
            return None;
        }
        self.result.as_ref()?.as_ref().ok()
    }

    fn page_message(&self, result: &Result<catalog::Page, catalog::Error>) -> &'static str {
        match result {
            Ok(page) if page.items.is_empty() && self.is_playlists() => {
                "No playlists on this page."
            }
            Ok(page) if page.items.is_empty() => "No videos on this page.",
            Ok(_) if self.is_playlists() => "YouTube playlists loaded.",
            Ok(_) => "YouTube videos loaded.",
            Err(error) => error.message(),
        }
    }
}

impl Job {
    pub(super) fn spawn(self, events: &EventLoopProxy<PlayerEvent>) {
        let stamp = self.stamp;
        let worker_events = events.clone();
        let worker = std::thread::Builder::new().name("youtube-account".into());
        if worker
            .spawn(move || {
                let outcome = match self.kind {
                    JobKind::Authorize { config, cancelled } => {
                        Outcome::Authorized(oauth::authorize(&config, &cancelled))
                    }
                    JobKind::Fetch { session, query } => Outcome::Page(
                        session
                            .bearer()
                            .ok_or(catalog::Error::Unauthorized)
                            .and_then(|bearer| {
                                catalog::Client::new().fetch(
                                    &query.collection,
                                    query.token.as_deref(),
                                    bearer,
                                )
                            }),
                    ),
                    JobKind::Revoke(session) => Outcome::Revoked(session.revoke()),
                    JobKind::Open(url) => {
                        if open::that_detached_with_timeout(url, Duration::from_millis(250)).is_ok()
                        {
                            return;
                        }
                        Outcome::OpenFailed
                    }
                };
                let _ = worker_events.send_event(PlayerEvent::Account(stamp, outcome));
            })
            .is_err()
        {
            let _ = events.send_event(PlayerEvent::Account(stamp, Outcome::WorkerUnavailable));
        }
    }
}
