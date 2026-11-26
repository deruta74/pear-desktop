use std::path::PathBuf;

use serde::Serialize;

const MAX_TRACKS: usize = 200;

#[derive(Default)]
pub(super) struct Queue {
    entries: Vec<Entry>,
    revision: u32,
    selected: Option<usize>,
    pending: Option<Pending>,
}

struct Entry {
    path: PathBuf,
    title: String,
}

struct Pending {
    replacement: Option<Vec<Entry>>,
    first: usize,
    index: usize,
    play: bool,
    skip_unreadable: bool,
}

#[derive(Serialize)]
pub(super) struct View<'a> {
    pub(super) revision: u32,
    pub(super) selected: Option<usize>,
    pub(super) tracks: Vec<&'a str>,
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
                title: super::title(&path),
                path,
            })
            .collect();
        let first_path = entries[0].path.clone();
        self.pending = Some(Pending {
            replacement: Some(entries),
            first: 0,
            index: 0,
            play: false,
            skip_unreadable: true,
        });
        Ok(Some(first_path))
    }

    pub(super) fn select(&mut self, revision: u32, index: usize, play: bool) -> Option<PathBuf> {
        if revision != self.revision || self.selected == Some(index) {
            return None;
        }
        self.start_existing(index, play, false)
    }

    pub(super) fn advance(&mut self) -> Option<PathBuf> {
        let index = self.selected? + 1;
        self.start_existing(index, true, true)
    }

    fn start_existing(
        &mut self,
        index: usize,
        play: bool,
        skip_unreadable: bool,
    ) -> Option<PathBuf> {
        if self.opening() {
            return None;
        }
        let path = self.entries.get(index)?.path.clone();
        self.pending = Some(Pending {
            replacement: None,
            first: index,
            index,
            play,
            skip_unreadable,
        });
        Some(path)
    }

    pub(super) fn retry_after_read_error(&mut self) -> Option<PathBuf> {
        let pending = self.pending.as_mut()?;
        let entries = pending.replacement.as_deref().unwrap_or(&self.entries);
        if pending.skip_unreadable
            && let Some(entry) = entries.get(pending.index + 1)
        {
            pending.index += 1;
            return Some(entry.path.clone());
        }
        self.cancel();
        None
    }

    pub(super) fn finish(&mut self) -> (bool, usize) {
        let pending = self
            .pending
            .take()
            .expect("track opened without a pending request");
        if let Some(entries) = pending.replacement {
            self.entries = entries;
            self.revision = self.revision.wrapping_add(1);
        }
        self.selected = Some(pending.index);
        (pending.play, pending.index - pending.first)
    }

    pub(super) fn cancel(&mut self) {
        self.pending = None;
    }

    pub(super) fn output_failed(&mut self) {
        self.cancel();
        self.selected = None;
    }
}
