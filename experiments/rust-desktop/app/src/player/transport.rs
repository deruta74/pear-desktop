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
    playing: bool,
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
        self.playing = false;
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
        let expired = self
            .sampled_at
            .is_some_and(|sample| time.duration_since(sample) >= POLL_TIMEOUT)
            && self.snapshot.take().is_some();
        if expired {
            self.playing = false;
        }
        expired
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

    pub(super) fn discard_pending_observation(&mut self, now: Instant) {
        self.pending = None;
        self.deadline = self.deadline.map(|_| now);
    }

    pub(super) fn receive(&mut self, sequence: u64, response: &str, time: Instant) -> bool {
        if self.pending != Some(sequence) {
            return false;
        }
        self.pending = None;
        self.deadline = Some(time + POLL_INTERVAL);
        if let Some(snapshot) = Snapshot::parse(response) {
            let buffering = snapshot.state == Some(3) && !snapshot.ended;
            self.playing = snapshot.state == Some(1) || (buffering && self.playing);
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

    pub(super) fn snapshot(&self) -> Option<&Snapshot> {
        self.snapshot.as_ref()
    }

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows", test))]
    pub(super) fn fresh_snapshot(&self, now: Instant) -> Option<(&Snapshot, Instant)> {
        let sampled_at = self.sampled_at?;
        let age = now.checked_duration_since(sampled_at)?;
        self.snapshot
            .as_ref()
            .filter(|_| age < POLL_TIMEOUT)
            .map(|snapshot| (snapshot, sampled_at))
    }

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows", test))]
    pub(super) fn native_playback_available(&self, expected_id: &str, now: Instant) -> bool {
        !self.refresh_controls
            && self
                .fresh_snapshot(now)
                .is_some_and(|(state, _)| state.allows_playback_for(expected_id))
    }

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    pub(super) fn perform_native_playback(
        &mut self,
        view: &WebView,
        expected_id: &str,
        playing: bool,
        now: Instant,
    ) -> Result<()> {
        if !self.native_playback_available(expected_id, now) {
            return Err("Native playback controls are unavailable for this video.".into());
        }
        Page::perform(
            view,
            Action::NativePlayback {
                expected_id: expected_id.to_owned(),
                playing,
            },
        )?;
        self.refresh_after_command(now);
        Ok(())
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
            Action::SetRate(rate) => state
                .playback_rates
                .as_ref()
                .is_some_and(|rates| rates.contains(rate)),
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

    fn controls(&self, has_video: bool) -> Option<Controls> {
        let snapshot = self.snapshot.as_ref();
        has_video.then(|| Controls {
            ready: self.ready(),
            has_played: snapshot.is_some_and(|state| state.has_played),
            playing: self.playing,
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
        })
    }

    pub(super) fn render(&mut self, view: &WebView, has_video: bool) -> Result<()> {
        let controls = self.controls(has_video);
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
    const VIDEO_ID: &str = "M7lc1UVf-VE";

    fn native_playback_sample() -> serde_json::Value {
        let mut sample: serde_json::Value = serde_json::from_str(PAUSED).unwrap();
        sample["videoId"] = serde_json::json!(VIDEO_ID);
        sample["nativePlaybackConfirmed"] = serde_json::json!(true);
        sample
    }

    #[test]
    fn discarded_observations_cannot_supply_a_sample_after_a_focus_change() {
        let mut transport = Transport::default();
        transport.reset(true);
        let now = Instant::now();
        let before_focus = transport.begin(now).unwrap();
        let after_focus = now + Duration::from_millis(10);
        transport.discard_pending_observation(after_focus);
        let current = transport.begin(after_focus).unwrap();
        assert!(!transport.receive(before_focus, PAUSED, after_focus));
        assert!(transport.observed_at(after_focus).is_none());
        assert!(transport.receive(current, PAUSED, after_focus));
        assert!(transport.observed_at(after_focus).is_some());
    }

    #[test]
    fn native_playback_requires_a_fresh_sample_before_the_poll_expires() {
        let now = Instant::now();
        let transport = Transport {
            snapshot: Snapshot::parse(&native_playback_sample().to_string()),
            sampled_at: Some(now),
            ..Transport::default()
        };
        assert!(transport.fresh_snapshot(now + POLL_INTERVAL).is_some());
        assert!(transport.fresh_snapshot(now + POLL_TIMEOUT).is_none());
        assert!(transport.native_playback_available(VIDEO_ID, now + POLL_INTERVAL));
        assert!(!transport.native_playback_available(VIDEO_ID, now + POLL_TIMEOUT));
    }

    #[test]
    fn native_playback_is_ineligible_until_a_post_command_sample_arrives() {
        let mut transport = Transport::default();
        transport.reset(true);
        let now = Instant::now();
        let sample = native_playback_sample().to_string();
        let sequence = transport.begin(now).unwrap();
        assert!(transport.receive(sequence, &sample, now));
        assert!(transport.native_playback_available(VIDEO_ID, now));

        let command = now + POLL_INTERVAL;
        let before = transport.begin(command).unwrap();
        transport.refresh_after_command(command);
        assert!(!transport.receive(before, &sample, command));
        assert!(!transport.native_playback_available(VIDEO_ID, command));

        let refresh = command + COMMAND_REFRESH;
        let sequence = transport.begin(refresh).unwrap();
        assert!(transport.receive(sequence, "null", refresh));
        assert!(!transport.native_playback_available(VIDEO_ID, refresh));
        let refresh = refresh + POLL_INTERVAL;
        let sequence = transport.begin(refresh).unwrap();
        assert!(transport.receive(sequence, &sample, refresh));
        assert!(transport.native_playback_available(VIDEO_ID, refresh));
    }

    #[test]
    fn native_playback_requires_the_matching_previously_played_video() {
        let now = Instant::now();
        let mut sample = native_playback_sample();
        let mut transport = Transport {
            snapshot: Snapshot::parse(&sample.to_string()),
            sampled_at: Some(now),
            ..Transport::default()
        };
        assert!(transport.native_playback_available(VIDEO_ID, now));
        assert!(!transport.native_playback_available("jNQXAC9IVRw", now));
        for (field, value) in [
            ("videoId", serde_json::Value::Null),
            ("hasPlayed", serde_json::json!(false)),
            ("blocked", serde_json::json!(true)),
            ("error", serde_json::json!(100)),
        ] {
            let mut ineligible = sample.clone();
            ineligible["nativePlaybackConfirmed"] = serde_json::json!(false);
            ineligible[field] = value;
            transport.snapshot = Some(Snapshot::parse(&ineligible.to_string()).unwrap());
            assert!(
                !transport.native_playback_available(VIDEO_ID, now),
                "{field}"
            );
        }

        sample["ended"] = serde_json::json!(true);
        sample["state"] = serde_json::json!(0);
        transport.snapshot = Some(Snapshot::parse(&sample.to_string()).unwrap());
        assert!(transport.native_playback_available(VIDEO_ID, now));
    }

    #[test]
    fn transport_tracks_buffering_after_playback_without_a_visible_panel() {
        let mut transport = Transport::default();
        transport.reset(true);
        let started = Instant::now();
        let sequence = transport.begin(started).unwrap();
        let playing = PAUSED.replace("\"state\":2", "\"state\":1");
        assert!(transport.receive(sequence, &playing, started));

        let later = started + POLL_INTERVAL;
        let sequence = transport.begin(later).unwrap();
        let sample = PAUSED
            .replace("\"state\":2", "\"state\":3")
            .replace("\"position\":10", "\"position\":17");
        assert!(transport.receive(sequence, &sample, later));
        let controls = transport.controls(true).unwrap();
        assert!(controls.playing);
        assert_eq!(controls.position, Some(17));
        assert!(!controls.clock_running);

        assert!(transport.expire(later + POLL_TIMEOUT));
        let sequence = transport.begin(later + POLL_TIMEOUT).unwrap();
        assert!(transport.receive(sequence, &sample, later + POLL_TIMEOUT));
        assert!(!transport.controls(true).unwrap().playing);
    }

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
