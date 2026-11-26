use std::{sync::Arc, time::Duration};

use tao::{event_loop::EventLoopProxy, window::Window};

use crate::media;

use super::{PlayerEvent, iframe::Snapshot};

pub(super) struct Item<'a> {
    pub(super) player_generation: u64,
    pub(super) video_id: &'a str,
    pub(super) title: &'a str,
    pub(super) artist: Option<&'a str>,
    pub(super) sample: &'a Snapshot,
    pub(super) sample_age: Duration,
    pub(super) can_control: bool,
}

#[derive(Default)]
struct Projection {
    epoch: u64,
    binding: Option<Binding>,
}

struct Binding {
    player_generation: u64,
    video_id: String,
    metadata: Arc<media::Metadata>,
    status: media::Status,
    can_control: bool,
}

impl Projection {
    fn update(&mut self, item: Option<Item<'_>>) -> Option<media::State> {
        let playable = item.and_then(|item| {
            let sample = item.sample;
            if !sample.allows_playback_for(item.video_id) || !matches!(sample.state, Some(0..=3)) {
                return None;
            }
            let duration = u64::from(sample.duration.filter(|duration| *duration > 0)?) * 1_000;
            let position = sample
                .position_ms
                .map(u64::from)
                .or_else(|| sample.position.map(|seconds| u64::from(seconds) * 1_000))?;
            let rate = sample.playback_rate.unwrap_or(1.0);
            let elapsed = if sample.state == Some(1) {
                (item.sample_age.as_secs_f64() * rate * 1_000.0) as u64
            } else {
                0
            };
            let speed = if cfg!(target_os = "macos") && sample.state == Some(3) {
                0.0
            } else {
                rate
            };
            Some((
                item,
                duration,
                position.saturating_add(elapsed).min(duration),
                speed,
            ))
        });
        let Some((item, duration_ms, position_ms, speed)) = playable else {
            self.binding = None;
            return None;
        };

        let matching = self.binding.as_ref().is_some_and(|binding| {
            binding.player_generation == item.player_generation && binding.video_id == item.video_id
        });
        if !matching {
            self.epoch = self.epoch.wrapping_add(1);
            self.binding = Some(Binding {
                player_generation: item.player_generation,
                video_id: item.video_id.into(),
                metadata: Arc::default(),
                status: media::Status::Paused,
                can_control: false,
            });
        }
        let binding = self.binding.as_mut()?;
        if binding.metadata.title != item.title || binding.metadata.artist.as_deref() != item.artist
        {
            binding.metadata = Arc::new(media::Metadata {
                title: item.title.into(),
                artist: item.artist.map(str::to_owned),
                album: None,
            });
        }
        binding.status = match item.sample.state {
            Some(1) => media::Status::Playing,
            Some(3) if cfg!(target_os = "macos") => binding.status,
            Some(0) => media::Status::Stopped,
            _ => media::Status::Paused,
        };
        binding.can_control = item.can_control;
        Some(media::State {
            generation: self.epoch,
            metadata: Arc::clone(&binding.metadata),
            duration_ms,
            position_ms,
            position_revision: 0,
            speed,
            volume: if item.sample.muted == Some(true) {
                0.0
            } else {
                f64::from(item.sample.volume.unwrap_or(100)) / 100.0
            },
            status: binding.status,
            can_previous: false,
            can_next: false,
            can_stop: false,
            can_control: binding.can_control,
        })
    }

    fn requested_playback(
        &self,
        request: media::Request,
        player_generation: u64,
        video_id: &str,
    ) -> Option<bool> {
        let route = self.binding.as_ref().filter(|route| {
            request.generation == self.epoch
                && route.player_generation == player_generation
                && route.video_id == video_id
                && route.can_control
        })?;
        let playing = route.status == media::Status::Playing;
        match request.command {
            media::Command::Play if !playing => Some(true),
            media::Command::Pause if playing => Some(false),
            media::Command::Toggle => Some(!playing),
            _ => None,
        }
    }
}

pub(super) struct Session {
    events: EventLoopProxy<PlayerEvent>,
    projection: Projection,
    backend: Option<media::Backend>,
    attempted: bool,
}

impl Session {
    pub(super) fn new(events: EventLoopProxy<PlayerEvent>) -> Self {
        Self {
            events,
            projection: Projection::default(),
            backend: None,
            attempted: false,
        }
    }

    pub(super) fn update(&mut self, _window: &Window, item: Option<Item<'_>>) {
        let state = self.projection.update(item);
        if state.is_some() && !self.attempted {
            self.attempted = true;
            let events = self.events.clone();
            let dispatch = move |request| {
                let _ = events.send_event(PlayerEvent::SystemMedia(request));
            };
            #[cfg(target_os = "macos")]
            {
                self.backend = media::Backend::new(dispatch);
            }
            #[cfg(target_os = "linux")]
            {
                self.backend = media::Backend::new(media::SessionKind::OnlineQueue, dispatch);
            }
            #[cfg(target_os = "windows")]
            {
                self.backend = media::Backend::new(_window, dispatch);
            }
        }
        if let Some(backend) = &mut self.backend {
            backend.update(state);
        }
    }

    pub(super) fn requested_playback(
        &self,
        request: media::Request,
        player_generation: u64,
        video_id: &str,
    ) -> Option<bool> {
        self.projection
            .requested_playback(request, player_generation, video_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VIDEO: &str = "M7lc1UVf-VE";
    const NEXT: &str = "jNQXAC9IVRw";

    fn sample(id: &str, confirmed: bool) -> Snapshot {
        Snapshot::parse(&format!(
            r#"{{"ready":true,"hasPlayed":true,"nativePlaybackConfirmed":{confirmed},"videoId":"{id}","state":1,"position":2,"positionMs":2500,"duration":10,"ended":false,"blocked":false,"error":null}}"#,
        ))
        .unwrap()
    }

    fn item<'a>(id: &'a str, sample: &'a Snapshot) -> Item<'a> {
        Item {
            player_generation: 1,
            video_id: id,
            title: "Test video",
            artist: Some("Test artist"),
            sample,
            sample_age: Duration::ZERO,
            can_control: true,
        }
    }

    #[test]
    fn registers_only_after_the_selected_video_has_played() {
        let mut projection = Projection::default();
        let mut playback = sample(VIDEO, true);
        playback.has_played = false;
        assert!(projection.update(Some(item(VIDEO, &playback))).is_none());
        playback.has_played = true;
        assert!(projection.update(Some(item(NEXT, &playback))).is_none());
        let unconfirmed = sample(VIDEO, false);
        assert!(projection.update(Some(item(VIDEO, &unconfirmed))).is_none());

        let state = projection.update(Some(item(VIDEO, &playback))).unwrap();
        assert_eq!(state.status, media::Status::Playing);
        assert_eq!(state.position_ms, 2500);
        assert!(!state.can_stop);
        assert_eq!(
            projection.requested_playback(
                media::Request {
                    generation: state.generation,
                    command: media::Command::Toggle,
                },
                1,
                VIDEO,
            ),
            Some(false),
        );
    }

    #[test]
    fn invalidates_old_commands_after_an_in_place_handoff() {
        let mut projection = Projection::default();
        let previous = sample(VIDEO, true);
        let next = sample(NEXT, true);
        let old = projection.update(Some(item(VIDEO, &previous))).unwrap();
        let current = projection.update(Some(item(NEXT, &next))).unwrap();
        assert_ne!(old.generation, current.generation);
        let request = media::Request {
            generation: old.generation,
            command: media::Command::Pause,
        };
        assert_eq!(projection.requested_playback(request, 1, NEXT), None);
        assert!(projection.update(None).is_none());
        let reopened = projection.update(Some(item(NEXT, &next))).unwrap();
        assert_ne!(reopened.generation, current.generation);
    }

    #[test]
    fn play_and_pause_follow_the_current_controllable_session() {
        use media::Command::{Pause, Play};

        let mut projection = Projection::default();
        let mut playback = sample(VIDEO, true);
        let playing = projection.update(Some(item(VIDEO, &playback))).unwrap();
        assert_eq!(
            projection.requested_playback(
                media::Request {
                    generation: playing.generation,
                    command: Play,
                },
                1,
                VIDEO,
            ),
            None,
        );
        let pause = media::Request {
            generation: playing.generation,
            command: Pause,
        };
        assert_eq!(projection.requested_playback(pause, 1, VIDEO), Some(false));
        assert_eq!(projection.requested_playback(pause, 2, VIDEO), None);
        assert_eq!(projection.requested_playback(pause, 1, NEXT), None);

        playback.state = Some(2);
        let mut paused = item(VIDEO, &playback);
        paused.can_control = false;
        projection.update(Some(paused)).unwrap();
        let play = media::Request {
            command: Play,
            ..pause
        };
        assert_eq!(projection.requested_playback(play, 1, VIDEO), None);
        projection.update(Some(item(VIDEO, &playback))).unwrap();
        assert_eq!(projection.requested_playback(play, 1, VIDEO), Some(true));

        assert!(projection.update(None).is_none());
        assert_eq!(projection.requested_playback(play, 1, VIDEO), None);
        projection.update(Some(item(VIDEO, &playback))).unwrap();
        assert_eq!(projection.requested_playback(play, 1, VIDEO), None);
    }

    #[test]
    fn advances_now_playing_time_between_the_poll_and_its_reply() {
        let mut projection = Projection::default();
        let mut sample = sample(VIDEO, true);
        sample.playback_rate = Some(1.25);
        let observed = projection.update(Some(item(VIDEO, &sample))).unwrap();
        assert_eq!(observed.position_ms, 2500);

        let mut timer = item(VIDEO, &sample);
        timer.sample_age = Duration::from_millis(800);
        let waiting = projection.update(Some(timer)).unwrap();
        assert_eq!(waiting.position_ms, 3500);

        sample.position = Some(3);
        sample.position_ms = Some(3500);
        let received = projection.update(Some(item(VIDEO, &sample))).unwrap();
        assert_eq!(received.position_ms, waiting.position_ms);

        sample.state = Some(3);
        let mut buffering = item(VIDEO, &sample);
        buffering.sample_age = Duration::from_millis(800);
        let held = projection.update(Some(buffering)).unwrap();
        assert_eq!(held.position_ms, 3500);
        #[cfg(target_os = "macos")]
        assert_eq!((held.speed, held.status), (0.0, media::Status::Playing));
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        assert_eq!((held.speed, held.status), (1.25, media::Status::Paused));
    }
}
