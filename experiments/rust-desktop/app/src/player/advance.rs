use std::time::{Duration, Instant};

use super::iframe::{Action, Snapshot};
use crate::library::QueueState;

const SWITCH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub(super) struct Advance {
    armed: Option<(String, String)>,
    pending: Option<Switch>,
    repeat_queue: bool,
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
    pub(super) fn set_repeat_queue(&mut self, repeat_queue: bool) {
        self.repeat_queue = repeat_queue;
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
        if let Some((armed_from, armed_to)) = &mut self.armed
            && let Some((from, to)) = queue_next(queue, self.repeat_queue)
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
        let Some((from, to)) = queue_next(queue, self.repeat_queue) else {
            self.disarm();
            return None;
        };
        if self.pending() {
            return None;
        }
        if sample.state == Some(1)
            && sample.ready
            && sample.has_played
            && !sample.blocked
            && sample.error.is_none()
            && sample.video_id.as_deref() == Some(from)
        {
            if self
                .armed
                .as_ref()
                .is_none_or(|(a, b)| a != from || b != to)
            {
                self.armed = Some((from.to_owned(), to.to_owned()));
            }
            return None;
        }
        if !sample.ended || sample.state != Some(0) {
            return None;
        }
        let (armed_from, armed_to) = self.armed.take()?;
        if armed_from == from && armed_to == to {
            self.begin(queue, sample, now)
        } else {
            None
        }
    }

    fn begin(&mut self, queue: &QueueState, sample: &Snapshot, now: Instant) -> Option<Action> {
        let (from, to) = queue_next(queue, self.repeat_queue)?;
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
        if queue_next(queue, self.repeat_queue) != Some(expected)
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

fn queue_next(queue: &QueueState, repeat_queue: bool) -> Option<(&str, &str)> {
    let current = queue.current.as_deref()?;
    let position = queue.entries.iter().position(|entry| entry == current)?;
    let next = queue
        .entries
        .get(position + 1)
        .or_else(|| (repeat_queue && queue.entries.len() > 1).then(|| &queue.entries[0]))?;
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
        state.set_repeat_queue(true);
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

        state.set_repeat_queue(true);
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
        state.set_repeat_queue(true);
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

        state.set_repeat_queue(true);
        state.observe(&queue, &playing, true, now);
        state.set_repeat_queue(false);
        assert!(state.observe(&queue, &ended, true, now).is_none());

        state.set_repeat_queue(true);
        state.observe(&queue, &playing, true, now);
        assert!(state.observe(&queue, &ended, true, now).is_some());
        assert_eq!(
            state.resolve(&queue, None, now + SWITCH_TIMEOUT),
            Some(Resolution::NeedsPlay(A.into()))
        );

        state.observe(&queue, &playing, true, now);
        assert!(state.observe(&queue, &ended, true, now).is_some());
        assert!(state.pending_wrap());
        state.set_repeat_queue(false);
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
        state.set_repeat_queue(true);
        assert!(matches!(
            state.observe(&queue, &sample(A, 0, 20_000, false), true, now),
            Some(Action::Advance { from, to }) if from == A && to == B
        ));
        state.set_repeat_queue(false);
        assert_eq!(state.resolve(&queue, None, now), None);
        assert_eq!(
            state.resolve(&queue, None, now + SWITCH_TIMEOUT),
            Some(Resolution::NeedsPlay(B.into()))
        );
    }
}
