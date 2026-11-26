use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::{iframe::AudioOutput, metadata::read_key_file};
use crate::library::write_atomic;

const MAX_FILE_BYTES: u64 = 4096;
const UNREADABLE: &str = "Could not read the saved playback preferences.";
const MALFORMED: &str = "The saved playback preferences contain invalid data.";

#[derive(Clone, Default, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct SavedPreferences {
    #[serde(default)]
    iframe_player: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    auto_advance: bool,
    #[serde(default, skip_serializing_if = "output_unset")]
    output: AudioOutput,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    youtube_key_file: Option<PathBuf>,
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

    pub(crate) fn auto_advance(&self) -> bool {
        self.saved.auto_advance
    }

    pub(super) fn audio_output(&self) -> AudioOutput {
        self.saved.output
    }

    pub(crate) fn problem(&self) -> Option<&'static str> {
        self.problem
    }

    pub(super) fn youtube_key_file(&self) -> Option<&Path> {
        self.saved.youtube_key_file.as_deref()
    }

    pub(super) fn set_youtube_key_file(
        &mut self,
        path: Option<PathBuf>,
    ) -> Result<(), &'static str> {
        if let Some(problem) = self.problem {
            return Err(problem);
        }
        if path
            .as_deref()
            .is_some_and(|path| !path.is_absolute() || read_key_file(path).is_none())
        {
            return Err("Choose a readable plain-text file containing one YouTube Data API key.");
        }
        self.save(SavedPreferences {
            youtube_key_file: path,
            ..self.saved.clone()
        })
        .map_err(|_| "Could not save the YouTube Data API key file setting.")
    }

    pub(crate) fn set_playback(
        &mut self,
        iframe_player: bool,
        auto_advance: bool,
        output: AudioOutput,
    ) -> io::Result<()> {
        if let Some(problem) = self.problem {
            return Err(io::Error::new(io::ErrorKind::InvalidData, problem));
        }
        if output.volume.is_some_and(|volume| volume > 100) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Volume must be between 0 and 100.",
            ));
        }
        self.save(SavedPreferences {
            iframe_player,
            auto_advance,
            output,
            ..self.saved.clone()
        })
    }

    fn save(&mut self, saved: SavedPreferences) -> io::Result<()> {
        if saved == self.saved {
            return Ok(());
        }
        let bytes = serde_json::to_vec(&saved).map_err(io::Error::other)?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "The playback preferences file would be too large.",
            ));
        }
        write_atomic(&self.path, &bytes)?;
        self.saved = saved;
        Ok(())
    }
}

fn output_unset(output: &AudioOutput) -> bool {
    *output == AudioOutput::default()
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

    #[test]
    fn restores_the_requested_audio_output_and_preserves_the_other_choices() {
        let directory = TestDirectory::new();
        let mut preferences = Preferences::load(directory.path());
        let output = AudioOutput {
            volume: Some(37),
            muted: Some(false),
        };
        preferences.set_playback(true, true, output).unwrap();
        let restored = Preferences::load(directory.path());
        assert!(restored.iframe_player() && restored.auto_advance());
        assert!(restored.audio_output() == output);
        assert!(
            preferences
                .set_playback(
                    false,
                    false,
                    AudioOutput {
                        volume: Some(101),
                        muted: None
                    }
                )
                .is_err()
        );
        assert!(Preferences::load(directory.path()).audio_output() == output);
    }

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
    fn remembers_only_the_key_file_location_and_keeps_playback_preferences() {
        let directory = TestDirectory::new();
        let key_file = directory.0.join("key.txt");
        let secret = "synthetic-pear-key";
        fs::write(&key_file, secret).unwrap();
        let path = directory.path();
        let mut preferences = Preferences::load(path.clone());
        preferences
            .set_youtube_key_file(Some(key_file.clone()))
            .unwrap();
        preferences
            .set_playback(true, true, AudioOutput::default())
            .unwrap();

        let saved = fs::read_to_string(&path).unwrap();
        assert!(!saved.contains(secret));
        let mut restored = Preferences::load(path.clone());
        assert_eq!(restored.youtube_key_file(), Some(key_file.as_path()));
        assert!(restored.iframe_player() && restored.auto_advance());

        restored.set_youtube_key_file(None).unwrap();
        let restored = Preferences::load(path);
        assert_eq!(restored.youtube_key_file(), None);
        assert!(restored.iframe_player() && restored.auto_advance());
        assert_eq!(fs::read_to_string(key_file).unwrap(), secret);
    }

    #[test]
    fn rejects_invalid_key_file_choices_without_replacing_the_saved_path() {
        let directory = TestDirectory::new();
        let key_file = directory.0.join("key.txt");
        fs::write(&key_file, b"synthetic-key").unwrap();
        let path = directory.path();
        let mut preferences = Preferences::load(path.clone());
        preferences
            .set_youtube_key_file(Some(key_file.clone()))
            .unwrap();
        let original = fs::read(&path).unwrap();
        let invalid = directory.0.join("invalid-file.txt");
        for bytes in [b" \n".as_slice(), b"{ synthetic-secret }", &[b'x'; 513]] {
            fs::write(&invalid, bytes).unwrap();
            let problem = preferences
                .set_youtube_key_file(Some(invalid.clone()))
                .unwrap_err();
            assert!(!problem.contains("invalid-file"));
            assert!(!problem.contains("synthetic-secret"));
        }
        for path in [
            directory.0.clone(),
            directory.0.join("missing.txt"),
            PathBuf::new(),
        ] {
            assert!(preferences.set_youtube_key_file(Some(path)).is_err());
        }
        assert_eq!(preferences.youtube_key_file(), Some(key_file.as_path()));
        assert_eq!(fs::read(path).unwrap(), original);
    }

    #[test]
    fn uses_the_explicit_key_file_override_before_the_saved_path() {
        use super::super::metadata::Client;

        let directory = TestDirectory::new();
        let valid = directory.0.join("key.txt");
        let missing = directory.0.join("missing.txt");
        fs::write(&valid, b"synthetic-key").unwrap();

        assert!(matches!(Client::configured(None, None), Ok(None)));
        assert!(matches!(
            Client::configured(None, Some(&valid)),
            Ok(Some(_))
        ));
        assert!(Client::configured(None, Some(&missing)).is_err());
        assert!(Client::configured(Some(&missing), Some(&valid)).is_err());
        assert!(matches!(
            Client::configured(Some(&valid), Some(&missing)),
            Ok(Some(_))
        ));
    }

    #[test]
    fn defaults_for_a_missing_file_and_persists_both_choices_across_restarts() {
        let directory = TestDirectory::new();
        let path = directory.path();
        let mut preferences = Preferences::load(path.clone());
        assert!(!preferences.iframe_player());
        assert_eq!(preferences.problem(), None);
        assert!(!path.exists());

        preferences
            .set_playback(true, false, AudioOutput::default())
            .unwrap();
        assert!(preferences.iframe_player());
        let mut restored = Preferences::load(path.clone());
        assert!(restored.iframe_player());
        assert_eq!(restored.problem(), None);
        restored
            .set_playback(false, false, AudioOutput::default())
            .unwrap();
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
        preferences
            .set_playback(true, false, AudioOutput::default())
            .unwrap();
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
            assert!(
                preferences
                    .set_playback(false, false, AudioOutput::default())
                    .is_err()
            );
            assert!(
                preferences
                    .set_playback(true, false, AudioOutput::default())
                    .is_err()
            );
            assert!(preferences.set_youtube_key_file(None).is_err());
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
        assert!(
            preferences
                .set_playback(true, false, AudioOutput::default())
                .is_err()
        );
        assert!(path.is_dir());
    }

    #[test]
    fn failed_write_keeps_the_last_saved_choice_and_can_be_retried() {
        let directory = TestDirectory::new();
        let path = directory.path();
        let backup = directory.0.join("saved.json");
        let mut preferences = Preferences::load(path.clone());
        preferences
            .set_playback(true, false, AudioOutput::default())
            .unwrap();
        fs::rename(&path, &backup).unwrap();
        fs::create_dir(&path).unwrap();

        assert!(
            preferences
                .set_playback(false, false, AudioOutput::default())
                .is_err()
        );
        assert!(preferences.iframe_player());
        assert_eq!(preferences.problem(), None);
        assert!(Preferences::load(backup.clone()).iframe_player());

        fs::remove_dir(&path).unwrap();
        fs::rename(backup, &path).unwrap();
        preferences
            .set_playback(false, false, AudioOutput::default())
            .unwrap();
        assert!(!Preferences::load(path).iframe_player());
    }
}
