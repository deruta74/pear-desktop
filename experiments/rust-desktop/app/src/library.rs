pub(crate) mod playlists;

use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};
use url::form_urlencoded;

const MAX_ENTRIES: usize = 500;
const MAX_TITLE_CHARS: usize = 180;
const MAX_TITLE_INPUT_BYTES: usize = 4096;
// Allow 500 titles at four bytes per character plus IDs and JSON structure.
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_SOURCE_BYTES: usize = 4096;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Add {
        source: String,
    },
    PlayNext {
        id: String,
    },
    Select {
        id: String,
    },
    SelectSearchResult {
        id: String,
    },
    SelectPublicPlaylistVideo {
        revision: u64,
        id: String,
    },
    Remove {
        id: String,
    },
    MoveUp {
        id: String,
    },
    MoveDown {
        id: String,
    },
    Previous {},
    Next {},
    ShuffleUpcoming {},
    Ready {},
    AcceptLegal {
        revision: u32,
    },
    CloseLegal {},
    DeclineLegal {},
    OpenLocalAudio {},
    OpenLegalLink {
        link: LegalLink,
    },
    OpenBrowser {},
    Search {
        query: String,
    },
    LoadMorePlaylist {
        revision: u64,
    },
    QueuePublicPlaylist {
        revision: u64,
        loaded_count: usize,
    },
    OpenMusicSearch {
        query: String,
    },
    OpenPlaylistVideo {
        id: String,
    },
    PlayPublicPlaylist {
        source: String,
    },
    ReturnToQueue {},
    FindLyrics {
        title: String,
        artist: String,
    },
    SetPlayback {
        playing: bool,
    },
    Seek {
        position: u32,
    },
    SetVolume {
        volume: u8,
    },
    SetMuted {
        muted: bool,
    },
    #[serde(untagged)]
    Playlist(playlists::Command),
    #[serde(untagged)]
    Account(crate::player::account::Command),
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegalLink {
    YoutubeTerms,
    GooglePrivacy,
}

impl LegalLink {
    pub fn url(&self) -> &'static str {
        match self {
            Self::YoutubeTerms => "https://www.youtube.com/t/terms",
            Self::GooglePrivacy => "https://www.google.com/policies/privacy",
        }
    }
}

#[derive(Clone, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct QueueState {
    pub entries: Vec<String>,
    pub current: Option<String>,
    #[serde(default)]
    pub titles: BTreeMap<String, String>,
}

impl QueueState {
    fn append_ids(&mut self, ids: impl IntoIterator<Item = String>) -> io::Result<()> {
        for id in ids {
            if !self.entries.contains(&id) {
                self.entries.push(id);
            }
        }
        if self.entries.len() > MAX_ENTRIES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("The queue can hold up to {MAX_ENTRIES} videos."),
            ));
        }
        if self.current.is_none() {
            self.current = self.entries.first().cloned();
        }
        Ok(())
    }
}

pub struct Library {
    path: PathBuf,
    state: QueueState,
}

impl Library {
    pub fn load(path: PathBuf) -> io::Result<Self> {
        let state = read_state(&path).map_err(|error| {
            io::Error::new(error.kind(), format!("Could not load the queue: {error}"))
        })?;
        Ok(Self { path, state })
    }

    pub fn state(&self) -> &QueueState {
        &self.state
    }

    pub fn remember_title(&mut self, id: &str, title: &str) -> io::Result<bool> {
        if !self.state.entries.iter().any(|entry| entry == id) {
            return Ok(false);
        }
        let Some(title) = normalized_title(title) else {
            return Ok(false);
        };
        if self.state.titles.get(id).map(String::as_str) == Some(title) {
            return Ok(false);
        }

        let mut state = self.state.clone();
        state.titles.insert(id.to_owned(), title.to_owned());
        self.store_state(state)?;
        Ok(true)
    }

    pub fn apply(&mut self, command: Command) -> io::Result<bool> {
        let mut state = self.state.clone();
        match command {
            Command::Add { source } => {
                state.append_ids(video_ids(&source)?)?;
            }
            Command::PlayNext { id } => {
                if !valid_id(&id) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "Enter a valid YouTube video ID.",
                    ));
                }
                state.append_ids([id.clone()])?;
                if let Some(current) = &state.current
                    && current != &id
                {
                    let old_index = entry_index(&state.entries, &id)?;
                    state.entries.remove(old_index);
                    let next_index = entry_index(&state.entries, current)? + 1;
                    state.entries.insert(next_index, id);
                }
            }
            Command::Select { id } => {
                entry_index(&state.entries, &id)?;
                state.current = Some(id);
            }
            Command::SelectSearchResult { id } | Command::SelectPublicPlaylistVideo { id, .. } => {
                if !valid_id(&id) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "Enter a valid YouTube video ID.",
                    ));
                }
                state.append_ids([id.clone()])?;
                state.current = Some(id);
            }
            Command::Remove { id } => {
                let index = entry_index(&state.entries, &id)?;
                state.entries.remove(index);
                state.titles.remove(&id);
                if state.current.as_ref() == Some(&id) {
                    state.current = state
                        .entries
                        .get(index)
                        .or_else(|| state.entries.last())
                        .cloned();
                }
            }
            Command::MoveUp { ref id } | Command::MoveDown { ref id } => {
                let index = entry_index(&state.entries, id)?;
                let neighbor = if matches!(command, Command::MoveUp { .. }) {
                    index.checked_sub(1)
                } else {
                    Some(index + 1).filter(|&next| next < state.entries.len())
                };
                let Some(neighbor) = neighbor else {
                    return Ok(false);
                };
                state.entries.swap(index, neighbor);
            }
            Command::Previous {} | Command::Next {} => {
                let Some(current) = &state.current else {
                    return Ok(false);
                };
                let index = entry_index(&state.entries, current)?;
                let neighbor = if matches!(command, Command::Previous {}) {
                    index.checked_sub(1)
                } else {
                    Some(index + 1)
                };
                let Some(id) = neighbor.and_then(|index| state.entries.get(index)) else {
                    return Ok(false);
                };
                state.current = Some(id.clone());
            }
            Command::ShuffleUpcoming {} => {
                let Some(current) = &state.current else {
                    return Ok(false);
                };
                let start = entry_index(&state.entries, current)? + 1;
                let upcoming = &mut state.entries[start..];
                if upcoming.len() < 2 {
                    return Ok(false);
                }
                // Discard the original permutation so a shuffle always changes the order.
                let original = &self.state.entries[start..];
                loop {
                    fastrand::shuffle(upcoming);
                    if upcoming != original {
                        break;
                    }
                }
            }
            Command::Ready {}
            | Command::AcceptLegal { .. }
            | Command::CloseLegal {}
            | Command::DeclineLegal {}
            | Command::OpenLocalAudio {}
            | Command::OpenLegalLink { .. }
            | Command::OpenBrowser {}
            | Command::Search { .. }
            | Command::LoadMorePlaylist { .. }
            | Command::QueuePublicPlaylist { .. }
            | Command::OpenMusicSearch { .. }
            | Command::OpenPlaylistVideo { .. }
            | Command::PlayPublicPlaylist { .. }
            | Command::ReturnToQueue {}
            | Command::Playlist(_)
            | Command::Account(_) => {
                return Ok(false);
            }
            Command::SetPlayback { .. }
            | Command::Seek { .. }
            | Command::SetVolume { .. }
            | Command::SetMuted { .. }
            | Command::FindLyrics { .. } => {
                return Ok(false);
            }
        }

        self.update_state(state)
    }

    pub(crate) fn enqueue_public_playlist<'a>(
        &mut self,
        ids: impl IntoIterator<Item = &'a str>,
    ) -> io::Result<bool> {
        let mut state = self.state.clone();
        state.append_ids(ids.into_iter().map(str::to_owned))?;
        self.update_state(state)
    }

    pub(crate) fn enqueue_saved(
        &mut self,
        playlist: &playlists::Playlist,
        selected: Option<&str>,
    ) -> io::Result<bool> {
        let entries = match selected {
            Some(id) => {
                let index = playlist
                    .entries
                    .iter()
                    .position(|entry| entry == id)
                    .ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "That track is no longer in the playlist.",
                        )
                    })?;
                &playlist.entries[index..=index]
            }
            None => playlist.entries.as_slice(),
        };
        let mut state = self.state.clone();
        state.append_ids(entries.iter().cloned())?;
        for id in entries {
            if let Some(title) = playlist.titles.get(id) {
                state
                    .titles
                    .entry(id.clone())
                    .or_insert_with(|| title.clone());
            }
        }
        if let Some(id) = selected {
            state.current = Some(id.to_owned());
        }
        self.update_state(state)
    }

    fn update_state(&mut self, state: QueueState) -> io::Result<bool> {
        if state == self.state {
            return Ok(false);
        }
        let reload = state.current != self.state.current;
        self.store_state(state)?;
        Ok(reload)
    }

    fn store_state(&mut self, state: QueueState) -> io::Result<()> {
        save_state(&self.path, &state).map_err(|error| {
            io::Error::new(error.kind(), format!("Could not save the queue: {error}"))
        })?;
        self.state = state;
        Ok(())
    }
}

fn entry_index(entries: &[String], id: &str) -> io::Result<usize> {
    entries.iter().position(|entry| entry == id).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "That video is no longer in the queue.",
        )
    })
}

pub(crate) fn valid_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn normalized_title(title: &str) -> Option<&str> {
    if title.len() > MAX_TITLE_INPUT_BYTES || title.chars().any(char::is_control) {
        return None;
    }
    let title = title.trim();
    let end = title
        .char_indices()
        .nth(MAX_TITLE_CHARS)
        .map_or(title.len(), |(index, _)| index);
    let title = title[..end].trim_end();
    (!title.is_empty()).then_some(title)
}

fn video_ids(source: &str) -> io::Result<Vec<String>> {
    let invalid_source = || {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Enter a YouTube video link or ID.",
        )
    };
    if source.len() > MAX_SOURCE_BYTES {
        return Err(invalid_source());
    }

    let inputs = source
        .lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty());
    if inputs.clone().nth(1).is_none() {
        let id = video_id(source).ok_or_else(invalid_source)?;
        return Ok(vec![id]);
    }

    inputs
        .map(|(index, line)| {
            video_id(line).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("Enter a YouTube video link or ID on line {}.", index + 1),
                )
            })
        })
        .collect()
}

fn video_id(source: &str) -> Option<String> {
    if source.len() > MAX_SOURCE_BYTES {
        return None;
    }
    let source = source.trim();
    if valid_id(source) {
        return Some(source.to_owned());
    }
    if source
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace() || ch == '\\')
    {
        return None;
    }

    let (scheme, rest) = source.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let (authority, target) = rest.split_at(rest.find(['/', '?', '#'])?);
    // Match the literal authority and path before URL normalization can change them.
    let host = authority
        .strip_suffix(":443")
        .unwrap_or(authority)
        .to_ascii_lowercase();
    let target = target.split('#').next()?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let mut video_parameters = form_urlencoded::parse(query.as_bytes())
        .filter_map(|(key, value)| (key == "v").then_some(value));
    let video_parameter = video_parameters.next();
    if video_parameters.next().is_some() {
        return None;
    }

    let id = match (host.as_str(), path, video_parameter) {
        (
            "youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com",
            "/watch",
            Some(id),
        ) => id.into_owned(),
        ("youtu.be", path, None) => path.strip_prefix('/')?.to_owned(),
        ("youtube.com" | "www.youtube.com" | "m.youtube.com", path, None) => path
            .strip_prefix("/shorts/")
            .or_else(|| path.strip_prefix("/embed/"))?
            .to_owned(),
        ("www.youtube-nocookie.com", path, None) => path.strip_prefix("/embed/")?.to_owned(),
        _ => return None,
    };
    valid_id(&id).then_some(id)
}

fn read_state(path: &Path) -> io::Result<QueueState> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(QueueState::default()),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "The queue file is too large.",
        ));
    }
    let state: QueueState = serde_json::from_slice(&bytes).map_err(|_| invalid_state())?;
    validate_state(&state)?;
    Ok(state)
}

fn invalid_state() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "The queue file contains invalid data.",
    )
}

fn validate_state(state: &QueueState) -> io::Result<()> {
    validate_tracks(&state.entries, &state.titles)?;
    if match &state.current {
        Some(id) => !state.entries.contains(id),
        None => !state.entries.is_empty(),
    } {
        return Err(invalid_state());
    }
    Ok(())
}

fn validate_tracks(entries: &[String], titles: &BTreeMap<String, String>) -> io::Result<()> {
    let mut unique_ids = HashSet::with_capacity(entries.len().min(MAX_ENTRIES));
    if entries.len() > MAX_ENTRIES
        || entries
            .iter()
            .any(|id| !valid_id(id) || !unique_ids.insert(id))
        || titles
            .iter()
            .any(|(id, title)| !unique_ids.contains(id) || normalized_title(title) != Some(title))
    {
        return Err(invalid_state());
    }
    Ok(())
}

fn save_state(path: &Path, state: &QueueState) -> io::Result<()> {
    validate_state(state)?;
    let bytes = serde_json::to_vec(state).map_err(io::Error::other)?;
    write_atomic(path, &bytes)
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_atomic_with(path, |file| file.write_all(bytes))
}

fn write_atomic_with(
    path: &Path,
    write: impl FnOnce(&mut File) -> io::Result<()>,
) -> io::Result<()> {
    let directory = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(directory)?;
    let (temp_path, mut temp_file) = create_temp_file(directory)?;
    let written = write(&mut temp_file).and_then(|()| temp_file.sync_all());
    drop(temp_file);

    let result = written.and_then(|()| fs::rename(&temp_path, path));
    if result.is_err() {
        let _ = fs::remove_file(temp_path);
    }
    result
}

fn create_temp_file(directory: &Path) -> io::Result<(PathBuf, File)> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    loop {
        let path = directory.join(format!(
            ".queue-{}-{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        match options.open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::*;

    const FIRST: &str = "dQw4w9WgXcQ";
    const SECOND: &str = "M7lc1UVf-VE";
    const THIRD: &str = "5qap5aO4i8I";

    #[test]
    fn enqueuing_saved_tracks_preserves_current_playback_and_known_titles() {
        let dir = TestDirectory::new();
        let path = dir.queue_path();
        let mut queue = Library::load(path.clone()).unwrap();
        assert!(queue.apply(add(FIRST)).unwrap());
        queue.remember_title(FIRST, "Current title").unwrap();
        let playlist = playlists::Playlist {
            id: 1,
            name: "Saved".into(),
            entries: vec![SECOND.into(), FIRST.into(), THIRD.into()],
            titles: BTreeMap::from([
                (FIRST.into(), "Old title".into()),
                (SECOND.into(), "Another track".into()),
            ]),
        };

        assert!(queue.enqueue_saved(&playlist, Some("other")).is_err());
        assert!(queue.enqueue_saved(&playlist, Some(SECOND)).unwrap());
        assert_eq!(queue.state().entries, [FIRST, SECOND]);
        assert_eq!(queue.state().current.as_deref(), Some(SECOND));
        assert!(!queue.enqueue_saved(&playlist, None).unwrap());
        assert_eq!(queue.state().entries, [FIRST, SECOND, THIRD]);
        assert_eq!(queue.state().titles[FIRST], "Current title");
        assert_eq!(queue.state().titles[SECOND], "Another track");
        assert!(Library::load(path).unwrap().state() == queue.state());
    }

    #[test]
    fn shuffle_upcoming_keeps_the_played_prefix_and_persists_without_reloading() {
        const FOURTH: &str = "fourthVideo";
        const FIFTH: &str = "fifthVideo_";
        let dir = TestDirectory::new();
        let path = dir.queue_path();
        let mut queue = Library::load(path.clone()).unwrap();
        let shuffle = || serde_json::from_str(r#"{"type":"shuffle_upcoming"}"#).unwrap();

        assert!(!queue.apply(shuffle()).unwrap());
        assert!(!path.exists());
        for id in [FIRST, SECOND, THIRD, FOURTH, FIFTH] {
            queue.apply(add(id)).unwrap();
        }
        queue.remember_title(FOURTH, "An upcoming video").unwrap();
        queue.apply(select(FOURTH)).unwrap();
        let before = fs::read(&path).unwrap();
        assert!(!queue.apply(shuffle()).unwrap());
        assert_eq!(fs::read(&path).unwrap(), before);
        queue.apply(select(THIRD)).unwrap();

        assert!(!queue.apply(shuffle()).unwrap());
        let persisted = Library::load(path).unwrap();
        assert!(persisted.state() == queue.state());
        assert_eq!(persisted.state().current.as_deref(), Some(THIRD));
        assert_eq!(
            persisted.state().entries,
            [FIRST, SECOND, THIRD, FIFTH, FOURTH]
        );
        assert_eq!(persisted.state().titles[FOURTH], "An upcoming video");
    }

    #[test]
    fn play_next_moves_an_existing_track_and_persists_without_reloading() {
        const FOURTH: &str = "fourthVideo";
        let dir = TestDirectory::new();
        let path = dir.queue_path();
        let mut queue = Library::load(path.clone()).unwrap();
        for id in [FIRST, SECOND, THIRD, FOURTH] {
            queue.apply(add(id)).unwrap();
        }
        queue.apply(select(SECOND)).unwrap();
        queue
            .remember_title(FIRST, "A previously played track")
            .unwrap();

        assert!(!queue.apply(play_next(FOURTH)).unwrap());
        assert_eq!(queue.state().entries, [FIRST, SECOND, FOURTH, THIRD]);
        assert!(!queue.apply(play_next(FIRST)).unwrap());
        assert_eq!(queue.state().entries, [SECOND, FIRST, FOURTH, THIRD]);

        assert_eq!(queue.state().current.as_deref(), Some(SECOND));
        assert_eq!(queue.state().titles[FIRST], "A previously played track");
        assert!(Library::load(path).unwrap().state() == queue.state());
        assert!(queue.apply(Command::Next {}).unwrap());
        assert_eq!(queue.state().current.as_deref(), Some(FIRST));
    }

    #[test]
    fn play_next_inserts_new_tracks_and_selects_the_first_track_of_an_empty_queue() {
        let dir = TestDirectory::new();
        let path = dir.queue_path();
        let mut queue = Library::load(path.clone()).unwrap();
        let invalid = queue.apply(play_next("invalid")).unwrap_err();
        assert_eq!(invalid.kind(), io::ErrorKind::InvalidInput);
        assert!(!path.exists());

        assert!(queue.apply(play_next(FIRST)).unwrap());
        assert_eq!(queue.state().entries, [FIRST]);
        assert_eq!(queue.state().current.as_deref(), Some(FIRST));

        queue.apply(add(SECOND)).unwrap();
        assert!(!queue.apply(play_next(THIRD)).unwrap());
        assert_eq!(queue.state().entries, [FIRST, THIRD, SECOND]);
        assert_eq!(queue.state().current.as_deref(), Some(FIRST));
    }

    #[test]
    fn play_next_can_move_a_track_at_capacity_but_rejects_new_tracks() {
        let dir = TestDirectory::new();
        let path = dir.queue_path();
        let entries: Vec<String> = (0..MAX_ENTRIES)
            .map(|index| format!("video{index:06}"))
            .collect();
        let saved = serde_json::json!({"entries": entries, "current": entries[1]}).to_string();
        fs::write(&path, &saved).unwrap();
        let mut queue = Library::load(path.clone()).unwrap();

        let error = queue.apply(play_next(FIRST)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(queue.state().entries, entries);
        assert_eq!(fs::read_to_string(&path).unwrap(), saved);

        assert!(!queue.apply(play_next(&entries[0])).unwrap());
        assert_eq!(queue.state().entries.len(), MAX_ENTRIES);
        assert_eq!(
            queue.state().entries[..3],
            ["video000001", "video000000", "video000002"]
        );
        assert!(Library::load(path).unwrap().state() == queue.state());
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            loop {
                let path = std::env::temp_dir().join(format!(
                    "pear-queue-test-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("Could not create test directory: {error}"),
                }
            }
        }

        fn queue_path(&self) -> PathBuf {
            self.0.join("queue.json")
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn add(source: &str) -> Command {
        Command::Add {
            source: source.into(),
        }
    }

    fn select(id: &str) -> Command {
        Command::Select { id: id.into() }
    }

    fn play_next(id: &str) -> Command {
        serde_json::from_value(serde_json::json!({"type": "play_next", "id": id})).unwrap()
    }

    fn select_search_result(id: &str) -> Command {
        serde_json::from_value(serde_json::json!({"type": "select_search_result", "id": id}))
            .unwrap()
    }

    fn remove(id: &str) -> Command {
        Command::Remove { id: id.into() }
    }

    #[test]
    fn accepts_ids_and_supported_video_links() {
        for source in [
            FIRST.to_string(),
            format!(" \n{FIRST}\t"),
            format!("https://www.youtube.com/watch?v={FIRST}&list=PL123#t=20"),
            format!("https://youtube.com:443/watch?v={FIRST}"),
            format!("https://music.youtube.com/watch?list=PL123&v={FIRST}"),
            format!("https://youtu.be/{FIRST}?si=share"),
            format!("https://www.youtube.com/shorts/{FIRST}?feature=share"),
            format!("https://www.youtube.com/embed/{FIRST}"),
        ] {
            assert_eq!(video_id(&source).as_deref(), Some(FIRST), "{source}");
        }
    }

    #[test]
    fn rejects_ambiguous_and_noncanonical_links() {
        for source in [
            "dQw4w9WgXc".to_string(),
            "dQw4w9WgXc!".to_string(),
            format!("http://youtube.com/watch?v={FIRST}"),
            format!("https://youtube.com.example/watch?v={FIRST}"),
            format!("https://%79outube.com/watch?v={FIRST}"),
            format!("https://youtube.com@evil.example/watch?v={FIRST}"),
            format!("https://@youtube.com/watch?v={FIRST}"),
            format!("https://user:password@youtube.com/watch?v={FIRST}"),
            format!("https://youtube.com:8443/watch?v={FIRST}"),
            format!("https:///youtube.com/watch?v={FIRST}"),
            format!("https://youtube.com/redirect/../watch?v={FIRST}"),
            format!("https://youtube.com/watch?v={FIRST}&%76={SECOND}"),
            format!("https://youtube.com/watch?v={FIRST}&v={FIRST}"),
            format!("https://youtube.com/watch?v={FIRST}&v="),
            format!("https://youtu.be/{FIRST}?v={SECOND}"),
            format!("https://youtu.be/{FIRST}/extra"),
            "https://youtube.com/watch?list=PL123".to_string(),
            "https://youtube.com/playlist?list=PL123".to_string(),
        ] {
            assert!(video_id(&source).is_none(), "{source}");
        }
    }

    #[test]
    fn adds_each_video_once_and_reloads_only_for_new_current_entry() {
        let directory = TestDirectory::new();
        let mut library = Library::load(directory.queue_path()).unwrap();
        assert!(library.apply(add(FIRST)).unwrap());
        assert!(!library.apply(add(SECOND)).unwrap());
        assert!(library.apply(select(SECOND)).unwrap());
        assert!(!library.apply(add(FIRST)).unwrap());
        assert!(!library.apply(select(SECOND)).unwrap());
        assert_eq!(library.state().entries, [FIRST, SECOND]);
        assert_eq!(library.state().current.as_deref(), Some(SECOND));
    }

    #[test]
    fn selecting_catalog_videos_persists_the_existing_queue_order() {
        let directory = TestDirectory::new();
        let path = directory.queue_path();
        let mut library = Library::load(path.clone()).unwrap();
        library.apply(add(FIRST)).unwrap();
        library.apply(add(SECOND)).unwrap();

        let select_playlist_video = |id: &str| Command::SelectPublicPlaylistVideo {
            revision: 1,
            id: id.into(),
        };
        assert!(library.apply(select_playlist_video(THIRD)).unwrap());
        assert_eq!(library.state().entries, [FIRST, SECOND, THIRD]);
        assert_eq!(library.state().current.as_deref(), Some(THIRD));
        assert!(library.apply(select_playlist_video(SECOND)).unwrap());
        assert!(!library.apply(select_search_result(SECOND)).unwrap());
        assert_eq!(library.state().entries, [FIRST, SECOND, THIRD]);
        assert_eq!(library.state().current.as_deref(), Some(SECOND));
        assert!(Library::load(path).unwrap().state() == library.state());
    }

    #[test]
    fn rejecting_search_result_selection_keeps_the_persisted_queue() {
        let directory = TestDirectory::new();
        let path = directory.queue_path();
        let entries: Vec<String> = (0..MAX_ENTRIES).map(|i| format!("v{i:010}")).collect();
        let state = QueueState {
            current: entries.first().cloned(),
            entries,
            titles: BTreeMap::new(),
        };
        save_state(&path, &state).unwrap();
        let mut library = Library::load(path.clone()).unwrap();
        let saved = fs::read(&path).unwrap();

        for rejected in ["invalid", SECOND] {
            let error = library.apply(select_search_result(rejected)).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
            assert!(library.state() == &state);
            assert_eq!(fs::read(&path).unwrap(), saved);
        }

        assert!(
            library
                .apply(select_search_result(&state.entries[1]))
                .unwrap()
        );
        assert_eq!(library.state().entries, state.entries);
        assert_eq!(
            library.state().current.as_ref(),
            library.state().entries.get(1)
        );
    }

    #[test]
    fn adds_batches_in_order_without_interrupting_the_current_video() {
        let directory = TestDirectory::new();
        let path = directory.queue_path();
        let mut library = Library::load(path.clone()).unwrap();
        let first_batch = format!("\r\n https://youtu.be/{SECOND} \r\n{FIRST}\r\n\r\n{SECOND}\r\n");
        assert!(library.apply(add(&first_batch)).unwrap());
        assert_eq!(library.state().entries, [SECOND, FIRST]);
        assert_eq!(library.state().current.as_deref(), Some(SECOND));

        assert!(library.apply(select(FIRST)).unwrap());
        assert!(library.remember_title(FIRST, "Current video").unwrap());
        let second_batch = format!("{FIRST}\nhttps://www.youtube.com/watch?v={THIRD}\n{THIRD}");
        assert!(!library.apply(add(&second_batch)).unwrap());
        let restored = Library::load(path).unwrap();
        assert_eq!(restored.state().entries, [SECOND, FIRST, THIRD]);
        assert_eq!(restored.state().current.as_deref(), Some(FIRST));
        assert_eq!(restored.state().titles[FIRST], "Current video");
    }

    #[test]
    fn queues_public_playlist_ids_in_order_without_reselecting_playback() {
        let directory = TestDirectory::new();
        let path = directory.queue_path();
        let mut library = Library::load(path.clone()).unwrap();
        assert!(
            library
                .enqueue_public_playlist([SECOND, FIRST, SECOND])
                .unwrap()
        );
        assert_eq!(library.state().current.as_deref(), Some(SECOND));
        assert!(library.apply(select(FIRST)).unwrap());
        assert!(
            !library
                .enqueue_public_playlist([FIRST, THIRD, THIRD, SECOND])
                .unwrap()
        );

        let restored = Library::load(path).unwrap();
        assert_eq!(restored.state().entries, [SECOND, FIRST, THIRD]);
        assert_eq!(restored.state().current.as_deref(), Some(FIRST));
    }

    #[test]
    fn public_playlist_batch_cannot_partially_exceed_the_queue_limit() {
        let directory = TestDirectory::new();
        let path = directory.queue_path();
        let entries: Vec<String> = (0..MAX_ENTRIES - 1)
            .map(|index| format!("video{index:06}"))
            .collect();
        let saved = serde_json::json!({"entries": entries, "current": entries[0]}).to_string();
        fs::write(&path, &saved).unwrap();
        let mut library = Library::load(path.clone()).unwrap();

        let error = library
            .enqueue_public_playlist([&entries[0][..], FIRST, SECOND])
            .unwrap_err();
        assert_eq!(error.to_string(), "The queue can hold up to 500 videos.");
        assert_eq!(library.state().entries, entries);
        assert_eq!(fs::read_to_string(path).unwrap(), saved);
    }

    #[test]
    fn rejects_an_invalid_batch_at_its_original_line_without_adding_valid_entries() {
        let directory = TestDirectory::new();
        let path = directory.queue_path();
        let mut library = Library::load(path.clone()).unwrap();
        library.apply(add(FIRST)).unwrap();
        let saved = fs::read(&path).unwrap();

        let source = format!("{SECOND}\n\nhttps://youtu.be/{THIRD}?bad=\tvalue\n{THIRD}");
        let error = library.apply(add(&source)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(
            error.to_string(),
            "Enter a YouTube video link or ID on line 3."
        );
        assert_eq!(library.state().entries, [FIRST]);
        assert_eq!(library.state().current.as_deref(), Some(FIRST));
        assert_eq!(fs::read(path).unwrap(), saved);
    }

    #[test]
    fn applies_the_byte_limit_to_the_whole_batch_before_skipping_blank_lines() {
        let directory = TestDirectory::new();
        let path = directory.queue_path();
        let mut library = Library::load(path.clone()).unwrap();
        let padding = " ".repeat(4096 - FIRST.len() - SECOND.len() - 2);
        let source = format!("{FIRST}\n{padding}\n{SECOND}");

        let error = library.apply(add(&format!("{source}\n"))).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(library.state().entries.is_empty());
        assert!(!path.exists());

        assert!(library.apply(add(&source)).unwrap());
        assert_eq!(library.state().entries, [FIRST, SECOND]);
    }

    #[test]
    fn navigation_is_bounded_and_removal_prefers_the_next_video() {
        let directory = TestDirectory::new();
        let mut library = Library::load(directory.queue_path()).unwrap();
        for id in [FIRST, SECOND, THIRD] {
            library.apply(add(id)).unwrap();
        }
        assert!(!library.apply(Command::Previous {}).unwrap());
        assert!(library.apply(Command::Next {}).unwrap());
        assert_eq!(library.state().current.as_deref(), Some(SECOND));
        assert!(library.apply(remove(SECOND)).unwrap());
        assert_eq!(library.state().current.as_deref(), Some(THIRD));
        assert!(!library.apply(Command::Next {}).unwrap());
        assert!(library.apply(remove(THIRD)).unwrap());
        assert_eq!(library.state().current.as_deref(), Some(FIRST));
        assert!(library.apply(remove(FIRST)).unwrap());
        assert!(library.state().entries.is_empty());
        assert_eq!(library.state().current, None);
        assert!(!library.apply(Command::Previous {}).unwrap());
        assert!(!library.apply(Command::Next {}).unwrap());
    }

    #[test]
    fn removing_a_different_video_keeps_the_current_video() {
        let directory = TestDirectory::new();
        let mut library = Library::load(directory.queue_path()).unwrap();
        library.apply(add(FIRST)).unwrap();
        library.apply(add(SECOND)).unwrap();
        assert!(!library.apply(remove(SECOND)).unwrap());
        assert_eq!(library.state().entries, [FIRST]);
        assert_eq!(library.state().current.as_deref(), Some(FIRST));
    }

    #[test]
    fn restores_queue_including_selection_from_disk() {
        let directory = TestDirectory::new();
        let path = directory.0.join("data").join("queue.json");
        let mut library = Library::load(path.clone()).unwrap();
        library.apply(add(FIRST)).unwrap();
        library.apply(add(SECOND)).unwrap();
        library.apply(select(SECOND)).unwrap();

        let restored = Library::load(path).unwrap();
        assert_eq!(restored.state().entries, [FIRST, SECOND]);
        assert_eq!(restored.state().current.as_deref(), Some(SECOND));
    }

    #[test]
    fn restores_titles_without_losing_legacy_queue_order_or_selection() {
        let directory = TestDirectory::new();
        let path = directory.queue_path();
        let legacy = format!(r#"{{"entries":["{SECOND}","{FIRST}"],"current":"{FIRST}"}}"#);
        fs::write(&path, legacy).unwrap();
        let mut library = Library::load(path.clone()).unwrap();
        assert_eq!(library.state().entries, [SECOND, FIRST]);
        assert_eq!(library.state().current.as_deref(), Some(FIRST));
        assert!(library.state().titles.is_empty());
        assert!(library.remember_title(FIRST, "\u{2003}A < B & C ").unwrap());
        assert!(!library.remember_title(FIRST, "A < B & C").unwrap());

        let mut restored = Library::load(path.clone()).unwrap();
        assert_eq!(restored.state().entries, [SECOND, FIRST]);
        assert_eq!(restored.state().current.as_deref(), Some(FIRST));
        assert_eq!(restored.state().titles[FIRST], "A < B & C");
        assert!(!restored.apply(remove(SECOND)).unwrap());
        assert_eq!(restored.state().titles[FIRST], "A < B & C");
        assert!(restored.apply(remove(FIRST)).unwrap());
        assert!(Library::load(path).unwrap().state().titles.is_empty());
    }

    #[test]
    fn remembers_only_usable_titles_for_existing_entries() {
        let directory = TestDirectory::new();
        let mut library = Library::load(directory.queue_path()).unwrap();
        library.apply(add(FIRST)).unwrap();
        assert!(!library.remember_title(SECOND, "Out of queue").unwrap());
        for title in [" \u{2003} ", "Song\nName", "\0", &"x".repeat(8192)] {
            assert!(!library.remember_title(FIRST, title).unwrap());
        }
        assert!(library.state().titles.is_empty());

        let title = "🎶".repeat(200);
        assert!(library.remember_title(FIRST, &title).unwrap());
        assert_eq!(library.state().titles[FIRST], "🎶".repeat(180));
        assert!(!library.remember_title(FIRST, &title).unwrap());
    }

    #[test]
    fn reorders_the_selected_video_without_reloading_and_updates_navigation() {
        let directory = TestDirectory::new();
        let path = directory.queue_path();
        let mut library = Library::load(path.clone()).unwrap();
        for id in [FIRST, SECOND, THIRD] {
            library.apply(add(id)).unwrap();
        }
        library.apply(select(SECOND)).unwrap();
        let move_up = format!(r#"{{"type":"move_up","id":"{SECOND}"}}"#);
        let move_down = format!(r#"{{"type":"move_down","id":"{SECOND}"}}"#);
        let decode = |command: &str| serde_json::from_str::<Command>(command).unwrap();

        assert!(!library.apply(decode(&move_up)).unwrap());
        assert_eq!(library.state().entries, [SECOND, FIRST, THIRD]);
        assert_eq!(library.state().current.as_deref(), Some(SECOND));
        assert!(!library.apply(decode(&move_up)).unwrap());
        assert!(!library.apply(Command::Previous {}).unwrap());
        assert!(library.apply(Command::Next {}).unwrap());
        assert_eq!(library.state().current.as_deref(), Some(FIRST));

        assert!(!library.apply(decode(&move_down)).unwrap());
        assert!(!library.apply(decode(&move_down)).unwrap());
        assert!(!library.apply(decode(&move_down)).unwrap());
        let restored = Library::load(path).unwrap();
        assert_eq!(restored.state().entries, [FIRST, THIRD, SECOND]);
        assert_eq!(restored.state().current.as_deref(), Some(FIRST));
    }

    #[test]
    fn restores_worst_case_utf8_titles_for_a_full_queue() {
        let directory = TestDirectory::new();
        let path = directory.queue_path();
        let entries: Vec<String> = (0..MAX_ENTRIES)
            .map(|index| format!("video{index:06}"))
            .collect();
        let title = "🎶".repeat(180);
        let titles: serde_json::Map<String, serde_json::Value> = entries
            .iter()
            .map(|id| (id.clone(), serde_json::Value::String(title.clone())))
            .collect();
        let saved =
            serde_json::json!({"entries": entries, "current": entries[0], "titles": titles});
        fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();

        let mut library = Library::load(path.clone()).unwrap();
        library.apply(select(&entries[1])).unwrap();
        let updated: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(updated["titles"], saved["titles"]);
    }

    #[test]
    fn rejects_invalid_commands_without_changing_state_or_disk() {
        let directory = TestDirectory::new();
        let path = directory.queue_path();
        let mut library = Library::load(path.clone()).unwrap();
        library.apply(add(FIRST)).unwrap();
        let saved = fs::read(&path).unwrap();

        for source in [
            "invalid",
            "\nhttps://youtu.be/dQw4w9WgXcQ?bad=\tvalue\n",
            "\r\n \n",
        ] {
            let error = library.apply(add(source)).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
            assert_eq!(error.to_string(), "Enter a YouTube video link or ID.");
        }
        assert!(library.apply(select(SECOND)).is_err());
        assert!(library.apply(remove(SECOND)).is_err());
        assert!(
            library
                .apply(Command::MoveDown { id: SECOND.into() })
                .is_err()
        );
        assert_eq!(library.state().entries, [FIRST]);
        assert_eq!(library.state().current.as_deref(), Some(FIRST));
        assert_eq!(fs::read(path).unwrap(), saved);
    }

    #[test]
    fn save_failure_keeps_the_current_state_and_cleans_up_temp_files() {
        let directory = TestDirectory::new();
        let path = directory.queue_path();
        let mut library = Library::load(path.clone()).unwrap();
        library.apply(add(FIRST)).unwrap();
        library.apply(add(SECOND)).unwrap();
        assert!(library.remember_title(FIRST, "Original title").unwrap());
        let backup = directory.0.join("backup.json");
        fs::rename(&path, &backup).unwrap();
        fs::create_dir(&path).unwrap();

        assert!(library.apply(add(THIRD)).is_err());
        assert!(
            library
                .apply(Command::MoveUp { id: SECOND.into() })
                .is_err()
        );
        assert!(library.apply(play_next(THIRD)).is_err());
        assert!(library.enqueue_public_playlist([FIRST, THIRD]).is_err());
        assert!(!library.enqueue_public_playlist([FIRST, SECOND]).unwrap());
        assert!(library.apply(select_search_result(THIRD)).is_err());
        assert!(library.apply(select_search_result(SECOND)).is_err());
        assert!(!library.apply(play_next(FIRST)).unwrap());
        assert!(!library.apply(play_next(SECOND)).unwrap());
        assert!(!library.apply(Command::MoveUp { id: FIRST.into() }).unwrap());
        assert!(library.remember_title(FIRST, "Changed title").is_err());
        assert_eq!(library.state().entries, [FIRST, SECOND]);
        assert_eq!(library.state().current.as_deref(), Some(FIRST));
        assert_eq!(library.state().titles[FIRST], "Original title");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
        assert!(Library::load(backup).unwrap().state() == library.state());
    }

    #[test]
    fn rejects_invalid_saved_queue_without_overwriting_it() {
        let directory = TestDirectory::new();
        let path = directory.queue_path();
        for saved in [
            "{".to_string(),
            format!(r#"{{"entries":["{FIRST}"],"current":"{SECOND}"}}"#),
            format!(r#"{{"entries":["{FIRST}","{FIRST}"],"current":"{FIRST}"}}"#),
            format!(r#"{{"entries":["{FIRST}"],"current":null}}"#),
            r#"{"entries":["invalid"],"current":"invalid"}"#.to_string(),
            format!(
                r#"{{"entries":["{FIRST}"],"current":"{FIRST}","titles":{{"{SECOND}":"Orphan"}}}}"#
            ),
            format!(r#"{{"entries":["{FIRST}"],"current":"{FIRST}","titles":{{"{FIRST}":"  "}}}}"#),
            format!(
                r#"{{"entries":["{FIRST}"],"current":"{FIRST}","titles":{{"{FIRST}":"Track\nTitle"}}}}"#
            ),
            format!(
                r#"{{"entries":["{FIRST}"],"current":"{FIRST}","titles":{{"{FIRST}":"{}"}}}}"#,
                "🎶".repeat(181)
            ),
        ] {
            fs::write(&path, &saved).unwrap();
            assert!(Library::load(path.clone()).is_err(), "{saved}");
            assert_eq!(fs::read_to_string(&path).unwrap(), saved);
        }
    }

    #[test]
    fn rejects_an_oversized_file() {
        let directory = TestDirectory::new();
        let path = directory.queue_path();
        let mut saved = br#"{"entries":[],"current":null}"#.to_vec();
        saved.resize(MAX_FILE_BYTES as usize + 1, b' ');
        fs::write(&path, saved).unwrap();
        assert!(Library::load(path).is_err());
    }

    #[test]
    fn caps_queue_entries_but_keeps_existing_entries_selectable() {
        let directory = TestDirectory::new();
        let path = directory.queue_path();
        let id = |index| format!("video{index:06}");
        let entries: Vec<String> = (0..MAX_ENTRIES)
            .map(|index| format!("\"{}\"", id(index)))
            .collect();
        fs::write(
            &path,
            format!(
                r#"{{"entries":[{}],"current":"{}"}}"#,
                entries.join(","),
                id(0)
            ),
        )
        .unwrap();

        let mut library = Library::load(path).unwrap();
        assert!(library.apply(add(&id(MAX_ENTRIES))).is_err());
        assert_eq!(library.state().entries.len(), MAX_ENTRIES);
        assert!(!library.apply(add(&id(0))).unwrap());
        assert!(library.apply(select(&id(1))).unwrap());
        assert_eq!(library.state().current.as_deref(), Some(id(1).as_str()));
    }

    #[test]
    fn counts_unique_entries_before_enforcing_batch_capacity() {
        let directory = TestDirectory::new();
        let path = directory.queue_path();
        let entries: Vec<String> = (0..499).map(|index| format!("video{index:06}")).collect();
        let saved = serde_json::json!({"entries": entries, "current": entries[0]}).to_string();
        fs::write(&path, &saved).unwrap();
        let mut library = Library::load(path.clone()).unwrap();

        let error = library
            .apply(add(&format!("{FIRST}\n{SECOND}")))
            .unwrap_err();
        assert_eq!(error.to_string(), "The queue can hold up to 500 videos.");
        assert_eq!(library.state().entries, entries);
        assert_eq!(fs::read_to_string(&path).unwrap(), saved);

        let source = format!("{}\n{FIRST}\nhttps://youtu.be/{FIRST}", entries[0]);
        assert!(!library.apply(add(&source)).unwrap());
        assert_eq!(library.state().entries.len(), 500);
        assert_eq!(library.state().entries[499], FIRST);
        let saved = fs::read(&path).unwrap();
        assert!(!library.apply(add(&source)).unwrap());
        assert_eq!(fs::read(path).unwrap(), saved);
    }
}
