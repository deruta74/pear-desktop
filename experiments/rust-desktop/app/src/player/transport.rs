use std::time::{Duration, Instant};

use serde::Serialize;
use wry::WebView;

use super::iframe::{Action, AudioOutput, Page, Snapshot};
use crate::Result;

const POLL_INTERVAL: Duration = Duration::from_secs(1);
const POLL_TIMEOUT: Duration = Duration::from_secs(3);
const COMMAND_REFRESH: Duration = Duration::from_millis(100);
const OUTPUT_CONFIRM_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Default)]
pub(super) struct Transport {
    snapshot: Option<Snapshot>,
    sampled_at: Option<Instant>,
    deadline: Option<Instant>,
    pending: Option<u64>,
    sequence: u64,
    refresh_controls: bool,
    rendered: Option<Option<Controls>>,
    requested_volume: Option<(u8, Instant)>,
    requested_muted: Option<(bool, Instant)>,
}

#[derive(PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Controls {
    ready: bool,
    has_played: bool,
    playing: bool,
    position: Option<u32>,
    position_ms: Option<u32>,
    playback_rate: Option<f64>,
    duration: Option<u32>,
    blocked: bool,
    clock_running: bool,
    volume: Option<u8>,
    muted: Option<bool>,
}

impl Transport {
    pub(super) fn reset(&mut self, has_video: bool) {
        self.snapshot = None;
        self.sampled_at = None;
        self.deadline = has_video.then(Instant::now);
        self.pending = None;
        self.refresh_controls = false;
        self.rendered = None;
        self.requested_volume = None;
        self.requested_muted = None;
    }

    pub(super) fn deadline(&self) -> Option<Instant> {
        let expiry = self
            .snapshot
            .as_ref()
            .and(self.sampled_at)
            .map(|time| time + POLL_TIMEOUT);
        self.deadline.into_iter().chain(expiry).min()
    }

    pub(super) fn expire(&mut self, time: Instant) -> bool {
        self.sampled_at
            .is_some_and(|sample| time.duration_since(sample) >= POLL_TIMEOUT)
            && self.snapshot.take().is_some()
    }

    pub(super) fn is_stale(&self) -> bool {
        self.sampled_at.is_some() && self.snapshot.is_none()
    }

    pub(super) fn begin(&mut self, time: Instant) -> Option<u64> {
        if self.deadline.is_none_or(|deadline| deadline > time) {
            return None;
        }
        self.sequence += 1;
        self.pending = Some(self.sequence);
        self.deadline = Some(time + POLL_TIMEOUT);
        Some(self.sequence)
    }

    pub(super) fn receive(&mut self, sequence: u64, response: &str, time: Instant) -> bool {
        if self.pending != Some(sequence) {
            return false;
        }
        self.pending = None;
        self.deadline = Some(time + POLL_INTERVAL);
        if let Some(snapshot) = Snapshot::parse(response) {
            self.snapshot = Some(snapshot);
            self.sampled_at = Some(time);
            if std::mem::take(&mut self.refresh_controls) {
                self.rendered = None;
            }
        }
        true
    }

    pub(super) fn ready(&self) -> bool {
        self.snapshot.as_ref().is_some_and(|state| state.ready)
    }

    pub(super) fn duration(&self) -> Option<u32> {
        self.snapshot.as_ref()?.duration
    }

    pub(super) fn observed_at(&self, time: Instant) -> Option<&Snapshot> {
        self.snapshot
            .as_ref()
            .filter(|_| self.sampled_at == Some(time))
    }

    pub(super) fn confirmed_output(&mut self, time: Instant) -> AudioOutput {
        let (volume, muted) = self
            .observed_at(time)
            .map_or((None, None), |sample| (sample.volume, sample.muted));
        AudioOutput {
            volume: confirm_request(&mut self.requested_volume, volume, time),
            muted: confirm_request(&mut self.requested_muted, muted, time),
        }
    }

    pub(super) fn problem(&self) -> Option<&'static str> {
        Some(match self.snapshot.as_ref()?.error? {
            100 => "This video is unavailable.",
            101 | 150 => "The owner disabled embedded playback. Use Open in browser.",
            153 => "YouTube could not identify the embedded player. Use Open in browser.",
            _ => "Could not run the video player. Use Reload Player or Open in browser.",
        })
    }

    pub(super) fn perform(&mut self, view: &WebView, action: Action) -> Result<()> {
        let state = self
            .snapshot
            .as_ref()
            .filter(|state| state.ready && !state.blocked && state.error.is_none())
            .ok_or("Start playback in the video first.")?;
        let available = match &action {
            Action::SetVolume(_) => state.volume.is_some(),
            Action::SetMuted(_) => state.muted.is_some(),
            _ => state.has_played,
        };
        if !available {
            return Err("That control is unavailable for this video.".into());
        }
        if let Action::Seek(position) = action
            && state.duration.is_none_or(|duration| position > duration)
        {
            return Err("This position is outside the video.".into());
        }
        let output = match &action {
            Action::SetVolume(volume) => AudioOutput {
                volume: Some(*volume),
                muted: None,
            },
            Action::SetMuted(muted) => AudioOutput {
                volume: None,
                muted: Some(*muted),
            },
            _ => AudioOutput::default(),
        };
        Page::perform(view, action)?;
        let now = Instant::now();
        if let Some(volume) = output.volume {
            self.requested_volume = Some((volume, now + OUTPUT_CONFIRM_TIMEOUT));
        }
        if let Some(muted) = output.muted {
            self.requested_muted = Some((muted, now + OUTPUT_CONFIRM_TIMEOUT));
        }
        self.refresh_after_command(now);
        Ok(())
    }

    fn refresh_after_command(&mut self, time: Instant) {
        // A reply from an observation made before this command is already stale.
        self.pending = None;
        self.deadline = Some(time + COMMAND_REFRESH);
        self.refresh_controls = true;
    }

    pub(super) fn resend_controls(&mut self) {
        self.rendered = None;
    }

    pub(super) fn render(&mut self, view: &WebView, has_video: bool) -> Result<()> {
        let snapshot = self.snapshot.as_ref();
        let controls = has_video.then(|| Controls {
            ready: self.ready(),
            has_played: snapshot.is_some_and(|state| state.has_played),
            playing: snapshot.is_some_and(|state| {
                state.state == Some(1)
                    || (state.state == Some(3)
                        && !state.ended
                        && self
                            .rendered
                            .as_ref()
                            .and_then(Option::as_ref)
                            .is_some_and(|view| view.playing))
            }),
            position: snapshot.and_then(|state| state.position),
            position_ms: snapshot.and_then(|state| state.position_ms),
            playback_rate: snapshot.and_then(|state| state.playback_rate),
            duration: snapshot.and_then(|state| state.duration),
            blocked: snapshot.is_some_and(|state| state.blocked),
            volume: snapshot.and_then(|state| state.volume),
            muted: snapshot.and_then(|state| state.muted),
            clock_running: snapshot.is_some_and(|state| {
                state.state == Some(1) && !state.blocked && state.error.is_none()
            }),
        });
        if self.rendered.as_ref() != Some(&controls) {
            let value = serde_json::to_string(&controls)?;
            view.evaluate_script(&format!("window.renderPearTransport({value});"))?;
            self.rendered = Some(controls);
        }
        Ok(())
    }
}

fn confirm_request<T: Copy + Eq>(
    request: &mut Option<(T, Instant)>,
    observed: Option<T>,
    now: Instant,
) -> Option<T> {
    let (value, deadline) = (*request)?;
    if now > deadline {
        *request = None;
    } else if observed == Some(value) {
        *request = None;
        return Some(value);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAUSED: &str = r#"{"ready":true,"hasPlayed":true,"state":2,"position":10,"duration":20,"ended":false,"error":null,"blocked":false}"#;

    #[test]
    fn remembers_only_confirmed_output_changes_from_fresh_samples() {
        let now = Instant::now();
        let sample = |volume| {
            Snapshot::parse(&PAUSED.replace(
                "\"blocked\":false",
                &format!("\"blocked\":false,\"volume\":{volume},\"muted\":true"),
            ))
        };
        let mut transport = Transport {
            requested_volume: Some((31, now + OUTPUT_CONFIRM_TIMEOUT)),
            requested_muted: Some((true, now + OUTPUT_CONFIRM_TIMEOUT)),
            snapshot: sample(100),
            sampled_at: Some(now),
            ..Transport::default()
        };
        assert_eq!(
            transport.confirmed_output(now + COMMAND_REFRESH),
            AudioOutput::default()
        );
        assert_eq!(
            transport.confirmed_output(now),
            AudioOutput {
                volume: None,
                muted: Some(true)
            }
        );
        transport.snapshot = sample(31);
        transport.sampled_at = Some(now + COMMAND_REFRESH);
        assert_eq!(
            transport.confirmed_output(now + COMMAND_REFRESH),
            AudioOutput {
                volume: Some(31),
                muted: None
            }
        );
        assert_eq!(
            transport.confirmed_output(now + COMMAND_REFRESH),
            AudioOutput::default()
        );
        transport.requested_volume = Some((31, now));
        transport.requested_muted = Some((true, now + OUTPUT_CONFIRM_TIMEOUT));
        assert_eq!(
            transport.confirmed_output(now + COMMAND_REFRESH),
            AudioOutput {
                volume: None,
                muted: Some(true)
            }
        );
        assert!(transport.requested_volume.is_none());
    }

    #[test]
    fn stale_reply_cannot_replace_the_active_request() {
        let mut transport = Transport::default();
        transport.reset(true);
        let time = Instant::now();
        let first = transport.begin(time).unwrap();
        assert!(transport.begin(time + POLL_INTERVAL).is_none());
        let replacement = transport.begin(time + POLL_TIMEOUT).unwrap();
        assert!(!transport.receive(first, "null", time + POLL_TIMEOUT));
        assert!(transport.receive(replacement, "null", time + POLL_TIMEOUT));
        assert!(!transport.receive(replacement, "null", time + POLL_TIMEOUT));
        assert!(!transport.ready());
    }

    #[test]
    fn replacing_the_player_invalidates_its_pending_reply() {
        let mut transport = Transport::default();
        transport.reset(true);
        let old = transport.begin(Instant::now()).unwrap();
        transport.reset(false);
        assert!(transport.deadline().is_none());
        assert!(!transport.receive(old, "null", Instant::now()));
        transport.reset(true);
        assert_ne!(transport.begin(Instant::now()).unwrap(), old);
    }

    #[test]
    fn invalid_observations_cannot_keep_controls_enabled_indefinitely() {
        let mut transport = Transport::default();
        transport.reset(true);
        let time = Instant::now();
        let first = transport.begin(time).unwrap();
        assert!(transport.receive(first, PAUSED, time));
        let next = transport.begin(time + POLL_INTERVAL).unwrap();
        assert!(transport.receive(next, "null", time + POLL_INTERVAL));
        assert!(!transport.expire(time + POLL_INTERVAL));
        assert!(transport.expire(time + POLL_TIMEOUT));
        assert!(!transport.ready());
        assert!(transport.is_stale());
        let recovery = transport.begin(time + POLL_TIMEOUT).unwrap();
        assert!(transport.receive(recovery, PAUSED, time + POLL_TIMEOUT));
        assert!(transport.ready());
        assert!(!transport.is_stale());
    }

    #[test]
    fn command_replaces_old_observation_and_refreshes_even_if_seek_did_not_move() {
        let mut transport = Transport::default();
        transport.reset(true);
        let time = Instant::now();
        let first = transport.begin(time).unwrap();
        assert!(transport.receive(first, PAUSED, time));
        let next = transport.begin(time + POLL_INTERVAL).unwrap();
        transport.rendered = Some(None);
        let command = time + POLL_INTERVAL;
        transport.refresh_after_command(command);
        assert!(!transport.receive(next, PAUSED, command));
        let refreshed = transport.begin(command + COMMAND_REFRESH).unwrap();
        assert!(transport.receive(refreshed, PAUSED, command + COMMAND_REFRESH));
        assert!(transport.rendered.is_none());
    }
}
