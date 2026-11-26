use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::library::write_atomic;

const MAX_FILE_BYTES: u64 = 4096;
const UNREADABLE: &str = "Could not read the saved playback preferences.";
const MALFORMED: &str = "The saved playback preferences contain invalid data.";

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SavedPreferences {
    #[serde(default)]
    iframe_player: bool,
}

pub(crate) struct Preferences {
    path: PathBuf,
    saved: SavedPreferences,
    problem: Option<&'static str>,
}

impl Preferences {
    pub(crate) fn load(path: PathBuf) -> Self {
        let (saved, problem) = match read_saved(&path) {
            Ok(saved) => (saved, None),
            Err(problem) => (SavedPreferences::default(), Some(problem)),
        };
        Self {
            path,
            saved,
            problem,
        }
    }

    pub(crate) fn iframe_player(&self) -> bool {
        self.saved.iframe_player
    }

    pub(crate) fn problem(&self) -> Option<&'static str> {
        self.problem
    }

    pub(crate) fn set_iframe_player(&mut self, enabled: bool) -> io::Result<()> {
        if let Some(problem) = self.problem {
            return Err(io::Error::new(io::ErrorKind::InvalidData, problem));
        }
        if enabled == self.saved.iframe_player {
            return Ok(());
        }
        let saved = SavedPreferences {
            iframe_player: enabled,
        };
        let bytes = serde_json::to_vec(&saved).map_err(io::Error::other)?;
        write_atomic(&self.path, &bytes)?;
        self.saved = saved;
        Ok(())
    }
}

fn read_saved(path: &Path) -> Result<SavedPreferences, &'static str> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(SavedPreferences::default());
        }
        Err(_) => return Err(UNREADABLE),
    };
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| UNREADABLE)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("The saved playback preferences file is too large.");
    }
    // Serde also accepts positional arrays for structs. Require a JSON object.
    if bytes.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
        return Err(MALFORMED);
    }
    serde_json::from_slice(&bytes).map_err(|_| MALFORMED)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            loop {
                let path = std::env::temp_dir().join(format!(
                    "pear-preferences-test-{}-{}",
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
            self.0.join("preferences.json")
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn defaults_for_a_missing_file_and_persists_both_choices_across_restarts() {
        let directory = TestDirectory::new();
        let path = directory.path();
        let mut preferences = Preferences::load(path.clone());
        assert!(!preferences.iframe_player());
        assert_eq!(preferences.problem(), None);
        assert!(!path.exists());

        preferences.set_iframe_player(true).unwrap();
        assert!(preferences.iframe_player());
        let mut restored = Preferences::load(path.clone());
        assert!(restored.iframe_player());
        assert_eq!(restored.problem(), None);
        restored.set_iframe_player(false).unwrap();
        assert!(!Preferences::load(path).iframe_player());
    }

    #[test]
    fn old_empty_object_uses_the_default_and_can_be_updated() {
        let directory = TestDirectory::new();
        let path = directory.path();
        fs::write(&path, b"{}").unwrap();
        let mut preferences = Preferences::load(path.clone());
        assert!(!preferences.iframe_player());
        assert_eq!(preferences.problem(), None);
        preferences.set_iframe_player(true).unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(saved, serde_json::json!({ "iframe_player": true }));
    }

    #[test]
    fn malformed_or_oversized_files_are_preserved_and_disable_writes() {
        let directory = TestDirectory::new();
        let path = directory.path();
        let mut oversized = b"{}".to_vec();
        oversized.resize(MAX_FILE_BYTES as usize + 1, b' ');
        for original in [
            b"{ plaintext with a private value".to_vec(),
            br#"{"iframe_player":"true"}"#.to_vec(),
            br#"{"iframe_player":true,"iframe_player":false}"#.to_vec(),
            b"[true]".to_vec(),
            oversized,
        ] {
            fs::write(&path, &original).unwrap();
            let mut preferences = Preferences::load(path.clone());
            assert!(!preferences.iframe_player());
            let problem = preferences.problem().unwrap();
            assert!(!problem.contains("private value"));
            assert!(!problem.contains(path.to_str().unwrap()));
            assert!(preferences.set_iframe_player(false).is_err());
            assert!(preferences.set_iframe_player(true).is_err());
            assert_eq!(fs::read(&path).unwrap(), original);
        }
    }

    #[test]
    fn unreadable_path_is_reported_as_a_problem() {
        let directory = TestDirectory::new();
        let path = directory.path();
        fs::create_dir(&path).unwrap();
        let mut preferences = Preferences::load(path.clone());
        assert!(!preferences.iframe_player());
        assert!(preferences.problem().is_some());
        assert!(preferences.set_iframe_player(true).is_err());
        assert!(path.is_dir());
    }

    #[test]
    fn failed_write_keeps_the_last_saved_choice_and_can_be_retried() {
        let directory = TestDirectory::new();
        let path = directory.path();
        let backup = directory.0.join("saved.json");
        let mut preferences = Preferences::load(path.clone());
        preferences.set_iframe_player(true).unwrap();
        fs::rename(&path, &backup).unwrap();
        fs::create_dir(&path).unwrap();

        assert!(preferences.set_iframe_player(false).is_err());
        assert!(preferences.iframe_player());
        assert_eq!(preferences.problem(), None);
        assert!(Preferences::load(backup.clone()).iframe_player());

        fs::remove_dir(&path).unwrap();
        fs::rename(backup, &path).unwrap();
        preferences.set_iframe_player(false).unwrap();
        assert!(!Preferences::load(path).iframe_player());
    }
}
