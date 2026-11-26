use std::{
    num::NonZeroU32,
    time::{Duration, Instant},
};

use super::{
    iframe::{Action, Snapshot},
    preferences::RepeatMode,
};
use crate::library::QueueState;

const SWITCH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub(super) struct Advance {
    armed: Option<(String, Target)>,
    pending: Option<Switch>,
    repeat_mode: RepeatMode,
}

enum Target {
    Next(String),
    Replay(NonZeroU32),
}

struct Switch {
    from: String,
    to: String,
    wraps_queue: bool,
    deadline: Instant,
    first_position: Option<u32>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Resolution {
    Playing(String),
    NeedsPlay(String),
    KeepCurrent,
    Superseded,
}

impl Advance {
    pub(super) fn set_repeat_mode(&mut self, mode: RepeatMode) {
        if (self.repeat_mode == RepeatMode::Track) != (mode == RepeatMode::Track) {
            self.disarm();
        }
        self.repeat_mode = mode;
    }

    pub(super) fn pending(&self) -> bool {
        self.pending.is_some()
    }

    pub(super) fn pending_wrap(&self) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|switch| switch.wraps_queue)
    }

    pub(super) fn deadline(&self) -> Option<Instant> {
        self.pending.as_ref().map(|switch| switch.deadline)
    }

    pub(super) fn cancel(&mut self) -> bool {
        self.disarm();
        self.pending.take().is_some()
    }

    pub(super) fn disarm(&mut self) {
        self.armed = None;
    }

    pub(super) fn retarget_after_queue_edit(&mut self, queue: &QueueState) {
        if let Some((armed_from, Target::Next(armed_to))) = &mut self.armed
            && let Some((from, to)) = queue_next(queue, self.repeat_mode)
            && armed_from == from
        {
            to.clone_into(armed_to);
        }
    }

    pub(super) fn observe(
        &mut self,
        queue: &QueueState,
        sample: &Snapshot,
        foreground_automatic: bool,
        now: Instant,
    ) -> Option<Action> {
        if !foreground_automatic {
            self.disarm();
            return None;
        }
        if self.pending() {
            return None;
        }
        if self.repeat_mode == RepeatMode::Track {
            return self.observe_repeat_track(queue, sample);
        }
        let Some((from, to)) = queue_next(queue, self.repeat_mode) else {
            self.disarm();
            return None;
        };
        if sample.state == Some(1)
            && sample.ready
            && sample.has_played
            && !sample.blocked
            && sample.error.is_none()
            && sample.video_id.as_deref() == Some(from)
        {
            if self.armed.as_ref().is_none_or(|(a, target)| {
                a != from || !matches!(target, Target::Next(b) if b == to)
            }) {
                self.armed = Some((from.to_owned(), Target::Next(to.to_owned())));
            }
            return None;
        }
        if !sample.ended || sample.state != Some(0) {
            return None;
        }
        let (armed_from, Target::Next(armed_to)) = self.armed.take()? else {
            return None;
        };
        if armed_from == from && armed_to == to {
            self.begin(queue, sample, now)
        } else {
            None
        }
    }

    fn observe_repeat_track(&mut self, queue: &QueueState, sample: &Snapshot) -> Option<Action> {
        let current = queue.current.as_deref().filter(|id| {
            queue.entries.iter().any(|entry| entry == *id) && sample.allows_playback_for(id)
        });
        let Some(id) = current else {
            self.disarm();
            return None;
        };
        match (sample.state, sample.repeat_cycle) {
            (Some(1), Some(cycle)) => {
                if self.armed.as_ref().is_none_or(|(armed_id, target)| {
                    armed_id != id || !matches!(target, Target::Replay(armed) if *armed == cycle)
                }) {
                    self.armed = Some((id.to_owned(), Target::Replay(cycle)));
                }
                None
            }
            (Some(0), Some(cycle)) => match self.armed.take() {
                Some((expected_id, Target::Replay(armed)))
                    if expected_id == id && armed == cycle =>
                {
                    Some(Action::RepeatTrack { expected_id, cycle })
                }
                _ => None,
            },
            (Some(2 | 3), None) => None,
            _ => {
                self.disarm();
                None
            }
        }
    }

    fn begin(&mut self, queue: &QueueState, sample: &Snapshot, now: Instant) -> Option<Action> {
        let (from, to) = queue_next(queue, self.repeat_mode)?;
        if self.pending()
            || sample.video_id.as_deref() != Some(from)
            || !sample.ready
            || !sample.has_played
            || !sample.ended
            || sample.state != Some(0)
            || sample.blocked
            || sample.error.is_some()
        {
            return None;
        }
        let wraps_queue = queue.entries.first().is_some_and(|first| first == to);
        let from = from.to_owned();
        let to = to.to_owned();
        self.pending = Some(Switch {
            from: from.clone(),
            to: to.clone(),
            wraps_queue,
            deadline: now + SWITCH_TIMEOUT,
            first_position: None,
        });
        Some(Action::Advance { from, to })
    }

    pub(super) fn resolve(
        &mut self,
        queue: &QueueState,
        sample: Option<&Snapshot>,
        now: Instant,
    ) -> Option<Resolution> {
        let switch = self.pending.as_mut()?;
        let expected = (switch.from.as_str(), switch.to.as_str());
        if queue_next(queue, self.repeat_mode) != Some(expected)
            || sample.is_some_and(|sample| {
                sample.source_replayed && sample.video_id.as_deref() == Some(switch.from.as_str())
            })
            || sample
                .and_then(|sample| sample.video_id.as_deref())
                .is_some_and(|id| id != switch.from && id != switch.to)
        {
            self.pending = None;
            return Some(Resolution::Superseded);
        }
        if sample.is_some_and(|sample| {
            sample.video_id.as_deref() == Some(switch.from.as_str())
                && sample.has_played
                && sample.state == Some(1)
        }) {
            self.pending = None;
            return Some(Resolution::KeepCurrent);
        }
        if now >= switch.deadline
            || sample.is_some_and(|sample| sample.blocked || sample.error.is_some())
        {
            return self.manual();
        }
        let sample = sample?;
        if sample.video_id.as_deref() != Some(switch.to.as_str())
            || !sample.ready
            || !sample.has_played
            || sample.state != Some(1)
        {
            return None;
        }
        let position = sample.position_ms?;
        let first = switch.first_position.get_or_insert(position);
        if position <= *first {
            return None;
        }
        self.pending
            .take()
            .map(|switch| Resolution::Playing(switch.to))
    }

    pub(super) fn manual(&mut self) -> Option<Resolution> {
        self.pending
            .take()
            .map(|switch| Resolution::NeedsPlay(switch.to))
    }
}

fn queue_next(queue: &QueueState, mode: RepeatMode) -> Option<(&str, &str)> {
    if mode == RepeatMode::Track {
        return None;
    }
    let current = queue.current.as_deref()?;
    let position = queue.entries.iter().position(|entry| entry == current)?;
    let next = queue.entries.get(position + 1).or_else(|| {
        (mode == RepeatMode::Queue && queue.entries.len() > 1).then(|| &queue.entries[0])
    })?;
    Some((current, next))
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "jNQXAC9IVRw";
    const B: &str = "M7lc1UVf-VE";
    const C: &str = "dQw4w9WgXcQ";

    fn queue() -> QueueState {
        QueueState {
            current: Some(A.into()),
            entries: vec![A.into(), B.into(), C.into()],
            ..QueueState::default()
        }
    }

    fn sample(id: &str, state: i32, position_ms: u32, blocked: bool) -> Snapshot {
        let json = serde_json::json!({
            "ready": true, "hasPlayed": true, "state": state, "position": position_ms / 1000,
            "positionMs": position_ms, "duration": 20, "ended": state == 0,
            "error": null, "blocked": blocked, "videoId": id,
        });
        Snapshot::parse(&json.to_string()).unwrap()
    }

    fn repeat_sample(id: &str, state: i32, cycle: u32) -> Snapshot {
        let json = serde_json::json!({
            "ready": true, "hasPlayed": true, "state": state, "position": if state == 0 { 20 } else { 19 },
            "duration": 20, "ended": state == 0, "error": null, "blocked": false,
            "videoId": id, "nativePlaybackConfirmed": true, "repeatCycle": cycle,
        });
        Snapshot::parse(&json.to_string()).unwrap()
    }

    #[test]
    fn repeat_track_replays_a_single_video_once_per_observed_playback_cycle() {
        let now = Instant::now();
        let mut queue = queue();
        queue.entries.truncate(1);
        let mut state = Advance::default();
        state.set_repeat_mode(RepeatMode::Track);

        assert!(
            state
                .observe(&queue, &repeat_sample(A, 0, 1), true, now)
                .is_none()
        );
        for cycle in [2, 3] {
            assert!(
                state
                    .observe(&queue, &repeat_sample(A, 1, cycle), true, now)
                    .is_none()
            );
            assert!(matches!(
                state.observe(&queue, &repeat_sample(A, 0, cycle), true, now),
                Some(Action::RepeatTrack { expected_id, cycle: issued }) if expected_id == A && issued.get() == cycle
            ));
            assert!(
                state
                    .observe(&queue, &repeat_sample(A, 0, cycle), true, now)
                    .is_none()
            );
            assert!(!state.pending());
        }
        assert_eq!(queue.current.as_deref(), Some(A));
        assert_eq!(queue.entries, [A]);
    }

    #[test]
    fn repeat_track_requires_a_matching_cycle_and_fresh_foreground_playback_after_disarm() {
        let now = Instant::now();
        let mut queue = queue();
        let mut state = Advance::default();
        state.set_repeat_mode(RepeatMode::Track);
        state.observe(&queue, &repeat_sample(A, 1, 2), true, now);
        assert!(
            state
                .observe(&queue, &repeat_sample(A, 0, 3), true, now)
                .is_none()
        );

        state.observe(&queue, &repeat_sample(A, 1, 3), true, now);
        state.disarm();
        assert!(
            state
                .observe(&queue, &repeat_sample(A, 0, 3), true, now)
                .is_none()
        );

        state.observe(&queue, &repeat_sample(A, 1, 4), true, now);
        assert!(
            state
                .observe(&queue, &repeat_sample(A, 0, 4), false, now)
                .is_none()
        );
        assert!(
            state
                .observe(&queue, &repeat_sample(A, 0, 4), true, now)
                .is_none()
        );

        state.observe(&queue, &repeat_sample(A, 1, 5), true, now);
        queue.current = Some(B.into());
        assert!(
            state
                .observe(&queue, &repeat_sample(A, 0, 5), true, now)
                .is_none()
        );
        assert!(
            state
                .observe(&queue, &repeat_sample(B, 0, 5), true, now)
                .is_none()
        );

        queue.current = Some(A.into());
        state.observe(&queue, &repeat_sample(A, 1, 6), true, now);
        assert!(
            state
                .observe(&queue, &sample(A, 1, 19_000, false), true, now)
                .is_none()
        );
        assert!(
            state
                .observe(&queue, &repeat_sample(A, 0, 6), true, now)
                .is_none()
        );
    }

    #[test]
    fn only_switches_after_the_current_video_ended_then_confirms_advancing_target() {
        let now = Instant::now();
        let queue = queue();
        let mut state = Advance::default();
        assert!(
            state
                .begin(&queue, &sample(B, 0, 20_000, false), now)
                .is_none()
        );
        assert!(
            state
                .begin(&queue, &sample(A, 2, 20_000, false), now)
                .is_none()
        );
        let ended = sample(A, 0, 20_000, false);
        assert!(
            matches!(state.begin(&queue, &ended, now), Some(Action::Advance { from, to }) if from == A && to == B)
        );
        assert!(state.begin(&queue, &ended, now).is_none());
        assert_eq!(state.resolve(&queue, Some(&ended), now), None);
        for position in [1200, 1200] {
            assert_eq!(
                state.resolve(&queue, Some(&sample(B, 1, position, false)), now),
                None
            );
        }
        assert_eq!(
            state.resolve(&queue, Some(&sample(B, 1, 2120, false)), now),
            Some(Resolution::Playing(B.into()))
        );
        assert!(!state.pending());
    }

    #[test]
    fn blocked_and_overdue_transitions_fall_back_to_one_manual_start() {
        let now = Instant::now();
        let queue = queue();
        let mut state = Advance::default();
        let ended = sample(A, 0, 20_000, false);
        state.begin(&queue, &ended, now);
        assert_eq!(
            state.resolve(&queue, Some(&sample(B, 2, 0, true)), now),
            Some(Resolution::NeedsPlay(B.into()))
        );
        assert_eq!(state.resolve(&queue, None, now), None);

        state.begin(&queue, &ended, now);
        assert_eq!(
            state.resolve(&queue, None, now + SWITCH_TIMEOUT),
            Some(Resolution::NeedsPlay(B.into()))
        );
        assert_eq!(state.deadline(), None);
    }

    #[test]
    fn reordering_or_changing_the_queue_never_commits_the_old_target() {
        let now = Instant::now();
        let mut queue = queue();
        let mut state = Advance::default();
        state.begin(&queue, &sample(A, 0, 20_000, false), now);
        queue.entries.swap(1, 2);
        assert_eq!(
            state.resolve(&queue, Some(&sample(B, 1, 1500, false)), now),
            Some(Resolution::Superseded)
        );
        assert!(!state.pending());
    }

    #[test]
    fn replaying_the_source_cancels_the_wait_without_reloading_it() {
        let now = Instant::now();
        let queue = queue();
        let mut state = Advance::default();
        state.begin(&queue, &sample(A, 0, 20_000, false), now);
        assert_eq!(
            state.resolve(&queue, Some(&sample(A, 1, 750, false)), now),
            Some(Resolution::KeepCurrent)
        );
        assert!(!state.pending());
    }

    #[test]
    fn only_an_armed_foreground_playback_can_trigger_automatic_advance() {
        let now = Instant::now();
        let mut queue = queue();
        let mut state = Advance::default();
        let playing = sample(A, 1, 15_000, false);
        let ended = sample(A, 0, 20_000, false);
        assert!(state.observe(&queue, &ended, true, now).is_none());
        state.observe(&queue, &playing, true, now);
        state.disarm();
        assert!(state.observe(&queue, &ended, false, now).is_none());
        assert!(state.observe(&queue, &ended, true, now).is_none());
        state.observe(&queue, &playing, true, now);
        queue.entries.swap(1, 2);
        assert!(state.observe(&queue, &ended, true, now).is_none());
        state.observe(&queue, &playing, true, now);
        assert!(matches!(
            state.observe(&queue, &ended, true, now),
            Some(Action::Advance { from, to }) if from == A && to == C
        ));
    }

    #[test]
    fn reordering_an_armed_queue_advances_to_its_new_next_video() {
        let now = Instant::now();
        let mut queue = queue();
        let mut state = Advance::default();
        state.observe(&queue, &sample(A, 1, 19_000, false), true, now);

        queue.entries.swap(1, 2);
        state.retarget_after_queue_edit(&queue);
        assert!(matches!(
            state.observe(&queue, &sample(A, 0, 20_000, false), true, now),
            Some(Action::Advance { from, to }) if from == A && to == C
        ));
    }

    #[test]
    fn appending_to_an_armed_wrap_advances_to_the_appended_video() {
        let now = Instant::now();
        let mut queue = queue();
        queue.current = Some(C.into());
        let mut state = Advance::default();
        state.set_repeat_mode(RepeatMode::Queue);
        state.observe(&queue, &sample(C, 1, 19_000, false), true, now);
        assert!(!state.pending_wrap());

        let appended = "aqz-KE-bpKQ";
        queue.entries.push(appended.into());
        state.retarget_after_queue_edit(&queue);
        assert!(matches!(
            state.observe(&queue, &sample(C, 0, 20_000, false), true, now),
            Some(Action::Advance { from, to }) if from == C && to == appended
        ));
        assert!(state.pending());
        assert!(!state.pending_wrap());
    }

    #[test]
    fn a_confirmed_issued_source_replay_drops_the_old_handoff() {
        let now = Instant::now();
        let queue = queue();
        let mut state = Advance::default();
        state.begin(&queue, &sample(A, 0, 20_000, false), now);
        let encoded = serde_json::json!({
            "ready": true, "hasPlayed": false, "state": null, "position": null,
            "positionMs": null, "duration": null, "ended": false,
            "error": null, "blocked": false, "videoId": A, "sourceReplayed": true,
        });
        let replay = Snapshot::parse(&encoded.to_string()).unwrap();
        assert_eq!(
            state.resolve(&queue, Some(&replay), now),
            Some(Resolution::Superseded)
        );
        assert!(!state.pending());
    }

    #[test]
    fn repeat_advances_from_the_final_video_to_the_first_in_foreground() {
        let now = Instant::now();
        let mut queue = queue();
        queue.current = Some(C.into());
        let playing = sample(C, 1, 19_000, false);
        let ended = sample(C, 0, 20_000, false);
        let mut state = Advance::default();

        state.observe(&queue, &playing, true, now);
        assert!(state.observe(&queue, &ended, true, now).is_none());

        state.set_repeat_mode(RepeatMode::Queue);
        assert!(state.observe(&queue, &ended, true, now).is_none());
        state.observe(&queue, &playing, true, now);
        assert!(state.observe(&queue, &ended, false, now).is_none());
        assert!(state.observe(&queue, &ended, true, now).is_none());
        state.observe(&queue, &playing, true, now);
        assert!(matches!(
            state.observe(&queue, &ended, true, now),
            Some(Action::Advance { from, to }) if from == C && to == A
        ));
        assert_eq!(
            state.resolve(&queue, Some(&sample(A, 1, 1000, false)), now),
            None
        );
        assert_eq!(
            state.resolve(&queue, Some(&sample(A, 1, 1500, false)), now),
            Some(Resolution::Playing(A.into()))
        );
        assert_eq!(queue.entries, [A, B, C]);
    }

    #[test]
    fn repeat_needs_multiple_queue_entries_and_matching_current_video() {
        let now = Instant::now();
        let mut queue = queue();
        queue.current = Some(C.into());
        let mut state = Advance::default();
        state.set_repeat_mode(RepeatMode::Queue);
        state.observe(&queue, &sample(B, 1, 19000, false), true, now);
        assert!(
            state
                .observe(&queue, &sample(B, 0, 20000, false), true, now)
                .is_none()
        );

        queue.entries = vec![C.into()];
        state.observe(&queue, &sample(C, 1, 19000, false), true, now);
        assert!(
            state
                .observe(&queue, &sample(C, 0, 20000, false), true, now)
                .is_none()
        );
    }

    #[test]
    fn disabling_repeat_invalidates_armed_and_pending_wraps() {
        let now = Instant::now();
        let mut queue = queue();
        queue.current = Some(C.into());
        let playing = sample(C, 1, 19_000, false);
        let ended = sample(C, 0, 20_000, false);
        let mut state = Advance::default();

        state.set_repeat_mode(RepeatMode::Queue);
        state.observe(&queue, &playing, true, now);
        state.set_repeat_mode(RepeatMode::Off);
        assert!(state.observe(&queue, &ended, true, now).is_none());

        state.set_repeat_mode(RepeatMode::Queue);
        state.observe(&queue, &playing, true, now);
        assert!(state.observe(&queue, &ended, true, now).is_some());
        assert_eq!(
            state.resolve(&queue, None, now + SWITCH_TIMEOUT),
            Some(Resolution::NeedsPlay(A.into()))
        );

        state.observe(&queue, &playing, true, now);
        assert!(state.observe(&queue, &ended, true, now).is_some());
        assert!(state.pending_wrap());
        state.set_repeat_mode(RepeatMode::Off);
        assert_eq!(
            state.resolve(&queue, None, now),
            Some(Resolution::Superseded)
        );
        assert!(state.resolve(&queue, None, now + SWITCH_TIMEOUT).is_none());
        assert!(!state.pending_wrap());
    }

    #[test]
    fn changing_repeat_leaves_regular_armed_and_pending_advances_intact() {
        let now = Instant::now();
        let queue = queue();
        let mut state = Advance::default();
        state.observe(&queue, &sample(A, 1, 19_000, false), true, now);
        state.set_repeat_mode(RepeatMode::Queue);
        assert!(matches!(
            state.observe(&queue, &sample(A, 0, 20_000, false), true, now),
            Some(Action::Advance { from, to }) if from == A && to == B
        ));
        state.set_repeat_mode(RepeatMode::Off);
        assert_eq!(state.resolve(&queue, None, now), None);
        assert_eq!(
            state.resolve(&queue, None, now + SWITCH_TIMEOUT),
            Some(Resolution::NeedsPlay(B.into()))
        );
    }
}
