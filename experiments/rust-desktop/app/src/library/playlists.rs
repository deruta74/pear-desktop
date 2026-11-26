use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    io::{self, BufWriter, Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::{QueueState, validate_tracks, write_atomic_with};

const MAX_PLAYLISTS: usize = 32;
const MAX_TRACKS: usize = 8_000;
const MAX_NAME_CHARS: usize = 80;
const MAX_NAME_INPUT_BYTES: usize = 4096;
// Accommodate 8,000 maximum-length titles plus IDs and JSON structure.
const MAX_FILE_BYTES: u64 = 6 * 1024 * 1024;
const WRITE_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Command {
    SavePlaylist { name: String },
    OpenPlaylist { id: u32 },
    ClosePlaylist {},
    RenamePlaylist { id: u32, name: String },
    RemovePlaylist { id: u32 },
    AppendPlaylist { id: u32 },
    SelectPlaylistTrack { id: u32, video: String },
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Playlist {
    pub(crate) id: u32,
    pub(crate) name: String,
    pub(crate) entries: Vec<String>,
    #[serde(default)]
    pub(crate) titles: BTreeMap<String, String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct StoredPlaylists {
    // Keep the highest allocated ID even when its playlist has been removed.
    #[serde(default)]
    last_id: Option<u32>,
    playlists: Vec<Playlist>,
}

pub(crate) struct Playlists {
    path: PathBuf,
    state: StoredPlaylists,
}

impl Playlists {
    pub(crate) fn load(path: PathBuf) -> io::Result<Self> {
        let state = read_state(&path).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("Could not load the playlists. {error}"),
            )
        })?;
        Ok(Self { path, state })
    }

    pub(crate) fn entries(&self) -> &[Playlist] {
        &self.state.playlists
    }

    pub(crate) fn save_queue(&mut self, name: &str, queue: &QueueState) -> io::Result<()> {
        if queue.entries.is_empty() {
            return Err(invalid_input(
                "Add a video to the queue before saving a playlist.",
            ));
        }
        validate_tracks(&queue.entries, &queue.titles)
            .map_err(|_| invalid_input("The queue contains invalid playlist entries."))?;
        if self.entries().len() >= MAX_PLAYLISTS {
            return Err(invalid_input(format!(
                "You can save up to {MAX_PLAYLISTS} playlists."
            )));
        }
        if self.state.track_count() + queue.entries.len() > MAX_TRACKS {
            return Err(invalid_input(format!(
                "Saved playlists can hold up to {MAX_TRACKS} videos in total."
            )));
        }

        let name = self.available_name(name, None)?;
        let id = self
            .state
            .last_id
            .unwrap_or_default()
            .checked_add(1)
            .ok_or_else(|| invalid_input("All playlist IDs have been used."))?;
        let mut state = self.state.clone();
        state.last_id = Some(id);
        state.playlists.push(Playlist {
            id,
            name,
            entries: queue.entries.clone(),
            titles: queue.titles.clone(),
        });
        self.store(state)
    }

    pub(crate) fn rename(&mut self, id: u32, name: &str) -> io::Result<()> {
        let index = self.index(id)?;
        let name = self.available_name(name, Some(id))?;
        if self.entries()[index].name == name {
            return Ok(());
        }
        let mut state = self.state.clone();
        state.playlists[index].name = name;
        self.store(state)
    }

    pub(crate) fn remove(&mut self, id: u32) -> io::Result<()> {
        let index = self.index(id)?;
        let mut state = self.state.clone();
        state.playlists.remove(index);
        self.store(state)
    }

    pub(crate) fn get(&self, id: u32) -> io::Result<&Playlist> {
        Ok(&self.entries()[self.index(id)?])
    }

    fn index(&self, id: u32) -> io::Result<usize> {
        self.entries()
            .iter()
            .position(|playlist| playlist.id == id)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "That playlist is no longer saved.")
            })
    }

    fn available_name(&self, name: &str, editing: Option<u32>) -> io::Result<String> {
        let name = normalized_name(name).ok_or_else(|| {
            invalid_input(format!(
                "Enter a playlist name of 1 to {MAX_NAME_CHARS} characters and keep it on one line."
            ))
        })?;
        let key = name.to_lowercase();
        if self
            .entries()
            .iter()
            .any(|playlist| Some(playlist.id) != editing && playlist.name.to_lowercase() == key)
        {
            return Err(invalid_input("A playlist with that name is already saved."));
        }
        Ok(name.to_owned())
    }

    fn store(&mut self, state: StoredPlaylists) -> io::Result<()> {
        write_atomic_with(&self.path, |file| {
            let mut writer = PlaylistWriter {
                inner: BufWriter::with_capacity(WRITE_BUFFER_BYTES, file),
                remaining: MAX_FILE_BYTES,
            };
            serde_json::to_writer(&mut writer, &state)?;
            writer.flush()
        })
        .map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("Could not save the playlists. {error}"),
            )
        })?;
        self.state = state;
        Ok(())
    }
}

struct PlaylistWriter<W> {
    inner: W,
    remaining: u64,
}

impl<W: Write> Write for PlaylistWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > self.remaining {
            return Err(invalid_input("The saved playlists file is too large."));
        }
        let written = self.inner.write(bytes)?;
        self.remaining -= written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl StoredPlaylists {
    fn track_count(&self) -> usize {
        self.playlists
            .iter()
            .map(|playlist| playlist.entries.len())
            .sum()
    }

    fn validate(&self) -> io::Result<()> {
        if self.playlists.len() > MAX_PLAYLISTS
            || self.track_count() > MAX_TRACKS
            || self.last_id == Some(0)
        {
            return Err(invalid_file());
        }
        let mut ids = HashSet::with_capacity(self.playlists.len());
        let mut names = HashSet::with_capacity(self.playlists.len());
        for playlist in &self.playlists {
            if playlist.id == 0
                || !ids.insert(playlist.id)
                || self.last_id.is_some_and(|last| playlist.id > last)
                || normalized_name(&playlist.name) != Some(playlist.name.as_str())
                || !names.insert(playlist.name.to_lowercase())
                || playlist.entries.is_empty()
                || validate_tracks(&playlist.entries, &playlist.titles).is_err()
            {
                return Err(invalid_file());
            }
        }
        Ok(())
    }
}

fn read_state(path: &Path) -> io::Result<StoredPlaylists> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(StoredPlaylists::default());
        }
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "The saved playlists file is too large.",
        ));
    }
    let mut state: StoredPlaylists = serde_json::from_slice(&bytes).map_err(|_| invalid_file())?;
    state.validate()?;
    if state.last_id.is_none() {
        state.last_id = state.playlists.iter().map(|playlist| playlist.id).max();
    }
    Ok(state)
}

fn normalized_name(input: &str) -> Option<&str> {
    if input.len() > MAX_NAME_INPUT_BYTES {
        return None;
    }
    let name = input.trim();
    if name.is_empty()
        || name
            .chars()
            .any(|character| character.is_control() || matches!(character, '\u{2028}' | '\u{2029}'))
        || name.chars().count() > MAX_NAME_CHARS
    {
        return None;
    }
    Some(name)
}

fn invalid_input(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn invalid_file() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "The saved playlists file contains invalid data.",
    )
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use serde_json::{Value, json};

    use super::*;

    const FIRST: &str = "dQw4w9WgXcQ";
    const SECOND: &str = "M7lc1UVf-VE";

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            loop {
                let path = std::env::temp_dir().join(format!(
                    "pear-playlists-test-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("Could not create test directory: {error}"),
                }
            }
        }

        fn path(&self) -> PathBuf {
            self.0.join("playlists.json")
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn queue() -> QueueState {
        QueueState {
            entries: vec![SECOND.into(), FIRST.into()],
            current: Some(FIRST.into()),
            titles: BTreeMap::from([(SECOND.into(), "Known title".into())]),
        }
    }

    fn playlist(id: u32, name: &str, entries: &[String]) -> Value {
        json!({ "id": id, "name": name, "entries": entries })
    }

    #[test]
    fn round_trips_a_snapshot_in_queue_order_with_known_titles() {
        let directory = TestDirectory::new();
        let mut playlists = Playlists::load(directory.path()).unwrap();
        assert!(playlists.entries().is_empty());
        let mut queue = queue();
        playlists.save_queue("Evening", &queue).unwrap();
        let captured = playlists.entries()[0].id;
        queue.entries.reverse();
        queue.titles.clear();

        let saved = Playlists::load(directory.path()).unwrap();
        let snapshot = saved.get(captured).unwrap();
        assert_eq!(snapshot.name, "Evening");
        assert_eq!(snapshot.entries, [SECOND, FIRST]);
        assert_eq!(
            snapshot.titles,
            BTreeMap::from([(SECOND.into(), "Known title".into())])
        );
        let visible = serde_json::to_value(snapshot).unwrap();
        assert_eq!(
            visible,
            json!({
                "id": captured, "name": "Evening", "entries": [SECOND, FIRST],
                "titles": { (SECOND): "Known title" },
            })
        );
    }

    #[test]
    fn trims_names_and_rejects_case_insensitive_collisions() {
        let directory = TestDirectory::new();
        let mut playlists = Playlists::load(directory.path()).unwrap();
        playlists.save_queue("  Écoute ", &queue()).unwrap();
        let first = playlists.entries()[0].id;
        assert_eq!(playlists.get(first).unwrap().name, "Écoute");
        assert!(playlists.save_queue("écoute", &queue()).is_err());
        playlists.save_queue("Road trip", &queue()).unwrap();
        let second = playlists.entries()[1].id;
        assert!(playlists.rename(second, " ÉCOUTE ").is_err());
        playlists.rename(first, "  ÉCOUTE ").unwrap();
        assert_eq!(playlists.get(first).unwrap().name, "ÉCOUTE");
        assert_eq!(playlists.get(second).unwrap().name, "Road trip");
    }

    #[test]
    fn rejects_invalid_names_and_empty_or_invalid_queues() {
        let directory = TestDirectory::new();
        let mut playlists = Playlists::load(directory.path()).unwrap();
        for name in ["  ".to_string(), "embedded\nline".into(), "ä".repeat(81)] {
            assert!(playlists.save_queue(&name, &queue()).is_err());
        }
        assert!(
            playlists
                .save_queue("Empty", &QueueState::default())
                .is_err()
        );
        let mut duplicate = queue();
        duplicate.entries.push(FIRST.into());
        assert!(playlists.save_queue("Duplicates", &duplicate).is_err());
        let mut invalid_title = queue();
        invalid_title
            .titles
            .insert("notinqueue1".into(), "Other".into());
        assert!(
            playlists
                .save_queue("Unrelated title", &invalid_title)
                .is_err()
        );
        assert!(playlists.entries().is_empty());
        assert!(!directory.path().exists());
    }

    #[test]
    fn never_reuses_ids_after_deletion_and_restart() {
        let directory = TestDirectory::new();
        let mut playlists = Playlists::load(directory.path()).unwrap();
        playlists.save_queue("Old", &queue()).unwrap();
        let old = playlists.entries()[0].id;
        playlists.remove(old).unwrap();
        assert!(playlists.get(old).is_err());
        assert!(playlists.remove(old).is_err());
        assert!(playlists.rename(old, "Missing").is_err());

        let mut restored = Playlists::load(directory.path()).unwrap();
        assert!(restored.entries().is_empty());
        restored.save_queue("New", &queue()).unwrap();
        assert!(restored.entries()[0].id > old);
    }

    #[test]
    fn old_files_without_titles_or_an_id_counter_are_restored() {
        let directory = TestDirectory::new();
        let old = u32::MAX - 1;
        let path = directory.path();
        let legacy = json!({ "playlists": [playlist(old, "Old", &[FIRST.into()])] });
        fs::write(&path, legacy.to_string()).unwrap();

        let mut playlists = Playlists::load(path.clone()).unwrap();
        assert!(playlists.get(old).unwrap().titles.is_empty());
        playlists.remove(old).unwrap();
        let mut playlists = Playlists::load(path.clone()).unwrap();
        playlists.save_queue("Last", &queue()).unwrap();
        assert_eq!(playlists.entries()[0].id, u32::MAX);
        let saved = fs::read(&path).unwrap();
        assert!(playlists.save_queue("Overflow", &queue()).is_err());
        assert_eq!(fs::read(path).unwrap(), saved);
    }

    #[test]
    fn rejects_corrupt_files_without_rewriting_them() {
        let directory = TestDirectory::new();
        let path = directory.path();
        let first = playlist(1, "First", &[FIRST.into()]);
        for saved in [
            "{".into(),
            json!({ "last_id": 0, "playlists": [first.clone()] }).to_string(),
            json!({ "last_id": 1, "playlists": [first.clone(), playlist(1, "Second", &[SECOND.into()])] }).to_string(),
            json!({ "playlists": [first.clone(), playlist(2, "FIRST", &[SECOND.into()])] }).to_string(),
            json!({ "playlists": [playlist(1, "Untrimmed ", &[FIRST.into()])] }).to_string(),
            json!({ "playlists": [playlist(1, "Empty", &[])] }).to_string(),
            json!({ "playlists": [playlist(1, "Bad video", &["malformed".into()])] }).to_string(),
        ] {
            fs::write(&path, &saved).unwrap();
            assert!(Playlists::load(path.clone()).is_err(), "{saved}");
            assert_eq!(fs::read_to_string(&path).unwrap(), saved);
        }
    }

    #[test]
    fn rejects_oversized_files() {
        let directory = TestDirectory::new();
        let path = directory.path();
        let mut saved = br#"{"playlists":[]}"#.to_vec();
        saved.resize(MAX_FILE_BYTES as usize + 1, b' ');
        fs::write(&path, saved).unwrap();
        assert!(Playlists::load(path).is_err());
    }

    #[test]
    fn enforces_the_exact_serialized_limit_without_replacing_the_previous_file() {
        let directory = TestDirectory::new();
        let path = directory.path();
        let mut playlists = Playlists::load(path.clone()).unwrap();
        let mut at_limit = StoredPlaylists {
            last_id: Some(1),
            playlists: vec![Playlist {
                id: 1,
                name: "Boundary".into(),
                entries: vec![FIRST.into()],
                titles: BTreeMap::from([(FIRST.into(), String::new())]),
            }],
        };
        // Use an artificial title to exercise the file-size limit independently of track limits.
        let overhead = serde_json::to_vec(&at_limit).unwrap().len();
        let payload = MAX_FILE_BYTES as usize - overhead;
        let mut title = "\"".repeat(payload / 2);
        if !payload.is_multiple_of(2) {
            title.push('x');
        }
        let title_len = title.len();
        at_limit.playlists[0].titles.insert(FIRST.into(), title);
        let mut over_limit = at_limit.clone();
        over_limit.playlists[0]
            .titles
            .get_mut(FIRST)
            .unwrap()
            .push('x');

        playlists.store(at_limit).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), MAX_FILE_BYTES);
        let error = playlists.store(over_limit).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(playlists.entries()[0].titles[FIRST].len(), title_len);
        assert_eq!(fs::metadata(path).unwrap().len(), MAX_FILE_BYTES);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn limits_playlist_count_and_total_tracks() {
        let directory = TestDirectory::new();
        let path = directory.path();
        let make_lists = |count, entries: &[String]| {
            (1..=count)
                .map(|id| playlist(id, &format!("Playlist {id}"), entries))
                .collect::<Vec<_>>()
        };
        let max_count = make_lists(MAX_PLAYLISTS as u32, &[FIRST.into()]);
        let tracks: Vec<String> = (0..500).map(|index| format!("video{index:06}")).collect();
        let max_tracks = make_lists((MAX_TRACKS / tracks.len()) as u32, &tracks);
        for stored in [max_count, max_tracks] {
            fs::write(&path, json!({ "playlists": stored }).to_string()).unwrap();
            let mut playlists = Playlists::load(path.clone()).unwrap();
            let before = playlists.entries().len();
            assert!(playlists.save_queue("Too many", &queue()).is_err());
            assert_eq!(playlists.entries().len(), before);
        }
    }

    #[test]
    fn failed_writes_preserve_the_roster_and_id_counter() {
        let directory = TestDirectory::new();
        let path = directory.path();
        let mut playlists = Playlists::load(path.clone()).unwrap();
        playlists.save_queue("Original", &queue()).unwrap();
        let id = playlists.entries()[0].id;
        let backup = directory.0.join("backup.json");
        fs::rename(&path, &backup).unwrap();
        fs::create_dir(&path).unwrap();

        assert!(playlists.rename(id, "Renamed").is_err());
        assert!(playlists.remove(id).is_err());
        assert!(playlists.save_queue("New", &queue()).is_err());
        assert_eq!(playlists.entries().len(), 1);
        assert_eq!(playlists.get(id).unwrap().name, "Original");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
        assert_eq!(
            Playlists::load(backup.clone())
                .unwrap()
                .get(id)
                .unwrap()
                .name,
            "Original"
        );

        fs::remove_dir(&path).unwrap();
        fs::rename(backup, path).unwrap();
        playlists.save_queue("New", &queue()).unwrap();
        assert_eq!(playlists.entries()[1].id, id + 1);
    }
}
