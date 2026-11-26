use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};
use url::form_urlencoded;

const MAX_ENTRIES: usize = 500;
const MAX_FILE_BYTES: u64 = 64 * 1024;
const MAX_SOURCE_BYTES: usize = 4096;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Add { source: String },
    Select { id: String },
    Remove { id: String },
    Previous {},
    Next {},
    Ready {},
    OpenBrowser {},
}

#[derive(Clone, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct QueueState {
    pub entries: Vec<String>,
    pub current: Option<String>,
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

    pub fn apply(&mut self, command: Command) -> io::Result<bool> {
        let mut state = self.state.clone();
        match command {
            Command::Add { source } => {
                let id = video_id(&source).ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "Enter a YouTube video link or ID.",
                    )
                })?;
                if state.entries.contains(&id) {
                    return Ok(false);
                }
                if state.entries.len() >= MAX_ENTRIES {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("The queue can hold up to {MAX_ENTRIES} videos."),
                    ));
                }
                if state.current.is_none() {
                    state.current = Some(id.clone());
                }
                state.entries.push(id);
            }
            Command::Select { id } => {
                entry_index(&state.entries, &id)?;
                state.current = Some(id);
            }
            Command::Remove { id } => {
                let index = entry_index(&state.entries, &id)?;
                state.entries.remove(index);
                if state.current.as_ref() == Some(&id) {
                    state.current = state
                        .entries
                        .get(index)
                        .or_else(|| state.entries.last())
                        .cloned();
                }
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
            Command::Ready {} | Command::OpenBrowser {} => return Ok(false),
        }

        if state == self.state {
            return Ok(false);
        }
        save_state(&self.path, &state).map_err(|error| {
            io::Error::new(error.kind(), format!("Could not save the queue: {error}"))
        })?;
        let reload = state.current != self.state.current;
        self.state = state;
        Ok(reload)
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

fn valid_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
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
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "The queue file contains invalid data.",
        )
    };
    let state: QueueState = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let mut unique_ids = HashSet::with_capacity(state.entries.len().min(MAX_ENTRIES));
    if state.entries.len() > MAX_ENTRIES
        || state
            .entries
            .iter()
            .any(|id| !valid_id(id) || !unique_ids.insert(id))
        || match &state.current {
            Some(id) => !unique_ids.contains(id),
            None => !unique_ids.is_empty(),
        }
    {
        return Err(invalid());
    }
    Ok(state)
}

fn save_state(path: &Path, state: &QueueState) -> io::Result<()> {
    let bytes = serde_json::to_vec(state).map_err(io::Error::other)?;
    let directory = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(directory)?;
    let (temp_path, mut temp_file) = create_temp_file(directory)?;
    let written = temp_file
        .write_all(&bytes)
        .and_then(|()| temp_file.sync_all());
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
    fn rejects_invalid_commands_without_changing_state_or_disk() {
        let directory = TestDirectory::new();
        let path = directory.queue_path();
        let mut library = Library::load(path.clone()).unwrap();
        library.apply(add(FIRST)).unwrap();
        let saved = fs::read(&path).unwrap();

        assert!(library.apply(add("invalid")).is_err());
        assert!(library.apply(select(SECOND)).is_err());
        assert!(library.apply(remove(SECOND)).is_err());
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
        let backup = directory.0.join("backup.json");
        fs::rename(&path, &backup).unwrap();
        fs::create_dir(&path).unwrap();

        assert!(library.apply(add(SECOND)).is_err());
        assert_eq!(library.state().entries, [FIRST]);
        assert_eq!(library.state().current.as_deref(), Some(FIRST));
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
        assert_eq!(Library::load(backup).unwrap().state().entries, [FIRST]);
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
}
