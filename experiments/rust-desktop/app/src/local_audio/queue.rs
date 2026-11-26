use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const MAX_TRACKS: usize = 200;

#[derive(Default)]
pub(super) struct Queue {
    entries: Vec<Entry>,
    revision: u32,
    selected: Option<usize>,
    pending: Option<Pending>,
    repeat: RepeatMode,
    consecutive_failures: usize,
}

#[derive(Clone, PartialEq)]
struct Entry {
    path: PathBuf,
    title: String,
}

struct Pending {
    request: OpenRequest,
    index: usize,
    remaining: usize,
    skipped: usize,
}

enum OpenRequest {
    Replace(Vec<Entry>),
    Select { play: bool },
    Advance,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum RepeatMode {
    #[default]
    Off,
    Queue,
    Track,
}

#[derive(PartialEq, Eq)]
pub(super) enum End {
    Natural,
    DecodeError,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Advance {
    Open(PathBuf),
    Replay,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct View<'a> {
    pub(super) revision: u32,
    pub(super) selected: Option<usize>,
    pub(super) tracks: Vec<&'a str>,
    pub(super) can_shuffle: bool,
    pub(super) repeat: RepeatMode,
}

impl Queue {
    pub(super) fn view(&self) -> View<'_> {
        View {
            revision: self.revision,
            selected: self.selected,
            tracks: self
                .entries
                .iter()
                .map(|entry| entry.title.as_str())
                .collect(),
            can_shuffle: self.shuffle_span().is_some(),
            repeat: self.repeat,
        }
    }

    pub(super) fn opening(&self) -> bool {
        self.pending.is_some()
    }

    pub(super) fn replace(&mut self, paths: Vec<PathBuf>) -> Result<Option<PathBuf>, &'static str> {
        if self.opening() || paths.is_empty() {
            return Ok(None);
        }
        if paths.len() > MAX_TRACKS {
            return Err("Choose up to 200 audio files at a time.");
        }
        let entries: Vec<_> = paths
            .into_iter()
            .map(|path| Entry {
                title: super::metadata::filename(&path),
                path,
            })
            .collect();
        let first_path = entries[0].path.clone();
        self.pending = Some(Pending {
            remaining: entries.len(),
            request: OpenRequest::Replace(entries),
            index: 0,
            skipped: 0,
        });
        Ok(Some(first_path))
    }

    pub(super) fn select(&mut self, revision: u32, index: usize, play: bool) -> Option<PathBuf> {
        if self.opening() || revision != self.revision || self.selected == Some(index) {
            return None;
        }
        self.start_existing(index, 1, OpenRequest::Select { play })
    }

    pub(super) fn neighbors(&self) -> (Option<usize>, Option<usize>) {
        let Some(index) = self.selected else {
            return (None, None);
        };
        (
            index.checked_sub(1),
            (index + 1 < self.entries.len()).then_some(index + 1),
        )
    }

    pub(super) fn step(&mut self, next: bool, play: bool) -> Option<PathBuf> {
        let (previous_index, next_index) = self.neighbors();
        let index = if next { next_index } else { previous_index }?;
        self.select(self.revision, index, play)
    }

    pub(super) fn shuffle_upcoming(&mut self, revision: u32) -> bool {
        if self.opening() || revision != self.revision {
            return false;
        }
        let Some((start, different)) = self.shuffle_span() else {
            return false;
        };
        let upcoming = &mut self.entries[start..];
        let original = upcoming.to_vec();
        fastrand::shuffle(upcoming);
        if upcoming == original {
            upcoming.swap(0, different);
        }
        self.revision = self.revision.wrapping_add(1);
        self.consecutive_failures = 0;
        true
    }

    fn shuffle_span(&self) -> Option<(usize, usize)> {
        let start = self.selected? + 1;
        let upcoming = &self.entries[start..];
        let first = upcoming.first()?;
        let different = upcoming.iter().position(|entry| entry != first)?;
        Some((start, different))
    }

    pub(super) fn set_repeat(&mut self, revision: u32, mode: RepeatMode) -> bool {
        if self.opening() || revision != self.revision || self.entries.is_empty() {
            return false;
        }
        self.repeat = mode;
        true
    }

    pub(super) fn advance(&mut self, end: End) -> Option<Advance> {
        let selected = self.selected?;
        if self.opening() {
            return None;
        }
        if end == End::Natural {
            self.consecutive_failures = 0;
            if self.repeat == RepeatMode::Track
                || (self.repeat == RepeatMode::Queue && self.entries.len() == 1)
            {
                return Some(Advance::Replay);
            }
        } else {
            self.consecutive_failures += 1;
        }
        let next = selected + 1;
        let (index, remaining) = if self.repeat == RepeatMode::Queue {
            // Count failed streams as well as failed opens so corrupt files
            // which pass initial validation cannot cycle indefinitely.
            (
                next % self.entries.len(),
                self.entries.len().saturating_sub(self.consecutive_failures),
            )
        } else {
            (next, self.entries.len() - next)
        };
        self.start_existing(index, remaining, OpenRequest::Advance)
            .map(Advance::Open)
    }

    fn start_existing(
        &mut self,
        index: usize,
        remaining: usize,
        request: OpenRequest,
    ) -> Option<PathBuf> {
        if remaining == 0 {
            return None;
        }
        let path = self.entries.get(index)?.path.clone();
        self.pending = Some(Pending {
            request,
            index,
            remaining,
            skipped: 0,
        });
        Some(path)
    }

    pub(super) fn retry_after_read_error(&mut self) -> Option<PathBuf> {
        let pending = self.pending.as_mut()?;
        if pending.remaining > 1 {
            let entries = match &pending.request {
                OpenRequest::Replace(entries) => entries,
                _ => &self.entries,
            };
            pending.remaining -= 1;
            pending.skipped += 1;
            pending.index = (pending.index + 1) % entries.len();
            return Some(entries[pending.index].path.clone());
        }
        self.cancel();
        None
    }

    pub(super) fn finish(&mut self) -> (bool, usize) {
        let pending = self
            .pending
            .take()
            .expect("track opened without a pending request");
        let play = match pending.request {
            OpenRequest::Replace(entries) => {
                self.entries = entries;
                self.revision = self.revision.wrapping_add(1);
                self.consecutive_failures = 0;
                false
            }
            OpenRequest::Select { play } => {
                self.consecutive_failures = 0;
                play
            }
            OpenRequest::Advance => {
                self.consecutive_failures += pending.skipped;
                true
            }
        };
        self.selected = Some(pending.index);
        (play, pending.skipped)
    }

    pub(super) fn cancel(&mut self) {
        self.pending = None;
    }

    pub(super) fn output_failed(&mut self) {
        self.cancel();
        self.selected = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue_with(paths: &[&str], selected: usize) -> Queue {
        let mut queue = Queue::default();
        queue
            .replace(paths.iter().map(PathBuf::from).collect())
            .unwrap()
            .unwrap();
        queue.finish();
        if selected != 0 {
            queue
                .select(queue.view().revision, selected, false)
                .unwrap();
            assert_eq!(queue.finish(), (false, 0));
        }
        queue
    }

    #[test]
    fn shuffle_reorders_only_upcoming_tracks_and_rejects_stale_indices() {
        let mut queue = queue_with(&["First.wav", "Current.wav", "A.flac", "B.mp3"], 1);
        let revision = queue.view().revision;

        assert!(queue.view().can_shuffle);
        assert!(!queue.shuffle_upcoming(revision.wrapping_sub(1)));
        assert!(queue.shuffle_upcoming(revision));
        assert_eq!(
            queue.view().tracks,
            ["First.wav", "Current.wav", "B.mp3", "A.flac"]
        );
        assert_eq!(queue.view().selected, Some(1));
        assert_ne!(queue.view().revision, revision);
        assert!(!queue.opening());
        assert!(queue.select(revision, 2, true).is_none());
        assert_eq!(
            queue.advance(End::Natural),
            Some(Advance::Open("B.mp3".into()))
        );
        assert!(!queue.shuffle_upcoming(queue.view().revision));
        assert_eq!(queue.finish(), (true, 0));
    }

    #[test]
    fn shuffle_handles_duplicate_paths_and_duplicate_titles() {
        let mut queue = queue_with(&["Current.wav", "a/Track.wav", "a/Track.wav"], 0);
        let revision = queue.view().revision;
        assert!(!queue.view().can_shuffle);
        assert!(!queue.shuffle_upcoming(revision));
        assert_eq!(queue.view().revision, revision);

        let mut queue = queue_with(&["Current.wav", "a/Track.wav", "b/Track.wav"], 0);
        assert!(queue.shuffle_upcoming(queue.view().revision));
        assert_eq!(
            queue.advance(End::Natural),
            Some(Advance::Open("b/Track.wav".into()))
        );
    }

    #[test]
    fn repeat_track_replays_natural_end_and_still_skips_decode_errors() {
        let mut queue = queue_with(&["First.wav", "Next.flac"], 0);
        let revision = queue.view().revision;
        assert_eq!(queue.view().repeat, RepeatMode::Off);
        assert!(!queue.set_repeat(revision.wrapping_sub(1), RepeatMode::Track));
        assert!(queue.set_repeat(revision, RepeatMode::Track));

        assert_eq!(queue.advance(End::Natural), Some(Advance::Replay));
        assert!(!queue.opening());
        assert_eq!(queue.view().selected, Some(0));
        assert_eq!(queue.view().revision, revision);
        assert_eq!(
            queue.advance(End::DecodeError),
            Some(Advance::Open("Next.flac".into()))
        );
        assert!(!queue.set_repeat(revision, RepeatMode::Off));
        assert_eq!(queue.finish(), (true, 0));
        assert!(queue.advance(End::DecodeError).is_none());

        let mut queue = queue_with(&["Only.wav"], 0);
        assert!(queue.set_repeat(queue.view().revision, RepeatMode::Queue));
        assert_eq!(queue.advance(End::Natural), Some(Advance::Replay));
        assert!(queue.advance(End::DecodeError).is_none());
    }

    #[test]
    fn repeat_queue_wraps_past_unreadable_files_after_natural_end() {
        let mut queue = queue_with(&["Bad.mp3", "First.wav", "Last.flac"], 2);
        assert!(queue.set_repeat(queue.view().revision, RepeatMode::Queue));

        assert_eq!(
            queue.advance(End::Natural),
            Some(Advance::Open("Bad.mp3".into()))
        );
        assert_eq!(queue.retry_after_read_error(), Some("First.wav".into()));
        assert_eq!(queue.finish(), (true, 1));
        assert_eq!(queue.view().selected, Some(1));
        assert_eq!(
            queue.advance(End::Natural),
            Some(Advance::Open("Last.flac".into()))
        );
    }

    #[test]
    fn repeat_queue_stops_after_one_pass_of_read_or_decode_errors() {
        let mut queue = queue_with(&["First.wav", "Bad.mp3", "Last.flac"], 0);
        assert!(queue.set_repeat(queue.view().revision, RepeatMode::Queue));
        assert_eq!(
            queue.advance(End::Natural),
            Some(Advance::Open("Bad.mp3".into()))
        );
        assert_eq!(queue.retry_after_read_error(), Some("Last.flac".into()));
        assert_eq!(queue.retry_after_read_error(), Some("First.wav".into()));
        assert!(queue.retry_after_read_error().is_none());
        assert!(!queue.opening());

        assert_eq!(
            queue.advance(End::DecodeError),
            Some(Advance::Open("Bad.mp3".into()))
        );
        assert_eq!(queue.retry_after_read_error(), Some("Last.flac".into()));
        assert_eq!(queue.finish(), (true, 1));
        assert!(queue.advance(End::DecodeError).is_none());
        assert!(!queue.opening());
    }

    #[test]
    fn repeat_queue_uses_the_new_order_after_shuffle_during_a_failed_pass() {
        let mut queue = queue_with(&["Broken A.wav", "Good.wav", "Broken B.wav"], 2);
        assert!(queue.set_repeat(queue.view().revision, RepeatMode::Queue));
        assert_eq!(
            queue.advance(End::DecodeError),
            Some(Advance::Open("Broken A.wav".into()))
        );
        queue.finish();
        assert!(queue.shuffle_upcoming(queue.view().revision));
        assert_eq!(
            queue.advance(End::DecodeError),
            Some(Advance::Open("Broken B.wav".into()))
        );
        queue.finish();
        assert_eq!(
            queue.advance(End::DecodeError),
            Some(Advance::Open("Good.wav".into()))
        );
    }

    #[test]
    fn repeat_leaves_manual_selection_paused_and_resets_failed_pass() {
        let mut queue = queue_with(&["First.wav", "Last.flac"], 0);
        let revision = queue.view().revision;
        assert!(queue.set_repeat(revision, RepeatMode::Queue));
        assert_eq!(
            queue.advance(End::DecodeError),
            Some(Advance::Open("Last.flac".into()))
        );
        assert_eq!(queue.finish(), (true, 0));
        assert!(queue.advance(End::DecodeError).is_none());

        assert_eq!(queue.select(revision, 0, false), Some("First.wav".into()));
        assert_eq!(queue.finish(), (false, 0));
        assert_eq!(queue.view().repeat, RepeatMode::Queue);
        assert_eq!(
            queue.advance(End::DecodeError),
            Some(Advance::Open("Last.flac".into()))
        );
    }
}
