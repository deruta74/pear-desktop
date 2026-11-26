use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::{account_oauth::ClientConfig, iframe::AudioOutput, metadata::read_google_key_file};
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
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    repeat_queue: bool,
    #[serde(default, skip_serializing_if = "output_unset")]
    output: AudioOutput,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    youtube_key_file: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    youtube_oauth_client_file: Option<PathBuf>,
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

    pub(crate) fn repeat_queue(&self) -> bool {
        self.saved.repeat_queue
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
            .is_some_and(|path| !path.is_absolute() || read_google_key_file(path).is_none())
        {
            return Err("Choose a readable plain-text file containing one YouTube Data API key.");
        }
        self.save(SavedPreferences {
            youtube_key_file: path,
            ..self.saved.clone()
        })
        .map_err(|_| "Could not save the YouTube Data API key file setting.")
    }

    pub(super) fn youtube_oauth_client_file(&self) -> Option<&Path> {
        self.saved.youtube_oauth_client_file.as_deref()
    }

    pub(super) fn set_youtube_oauth_client_file(
        &mut self,
        path: Option<PathBuf>,
    ) -> Result<(), &'static str> {
        if let Some(problem) = self.problem {
            return Err(problem);
        }
        if path
            .as_deref()
            .is_some_and(|path| ClientConfig::read_file(path).is_err())
        {
            return Err("Choose a readable OAuth client JSON file for a Google Desktop app.");
        }
        self.save(SavedPreferences {
            youtube_oauth_client_file: path,
            ..self.saved.clone()
        })
        .map_err(|_| "Could not save the Google Desktop OAuth client file setting.")
    }

    pub(crate) fn set_playback(
        &mut self,
        iframe_player: bool,
        auto_advance: bool,
        repeat_queue: bool,
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
            repeat_queue,
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
            return Ok(SavedPreferences {
                iframe_player: cfg!(any(target_os = "macos", target_os = "linux")),
                ..SavedPreferences::default()
            });
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
    fn repeat_queue_defaults_off_in_old_files_and_persists_with_playback_choices() {
        let directory = TestDirectory::new();
        let path = directory.path();
        fs::write(&path, br#"{"iframe_player":true,"auto_advance":true}"#).unwrap();
        let mut preferences = Preferences::load(path.clone());
        assert_eq!(preferences.problem(), None);
        assert!(!preferences.repeat_queue());

        let output = AudioOutput {
            volume: Some(15),
            muted: Some(true),
        };
        preferences.set_playback(true, true, true, output).unwrap();
        let mut restored = Preferences::load(path.clone());
        assert!(restored.iframe_player() && restored.auto_advance());
        assert!(restored.repeat_queue());
        assert!(restored.audio_output() == output);

        restored.set_playback(true, true, false, output).unwrap();
        let restored = Preferences::load(path);
        assert!(!restored.repeat_queue());
        assert!(restored.audio_output() == output);
    }

    #[test]
    fn restores_the_requested_audio_output_and_preserves_the_other_choices() {
        let directory = TestDirectory::new();
        let mut preferences = Preferences::load(directory.path());
        let output = AudioOutput {
            volume: Some(37),
            muted: Some(false),
        };
        preferences.set_playback(true, true, false, output).unwrap();
        let restored = Preferences::load(directory.path());
        assert!(restored.iframe_player() && restored.auto_advance());
        assert!(restored.audio_output() == output);
        assert!(
            preferences
                .set_playback(
                    false,
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

    const SYNTHETIC_GOOGLE_KEY: &str = "AIza01234567890123456789012345678901234";
    const SYNTHETIC_OAUTH_CLIENT: &[u8] = br#"{"installed":{"client_id":"test.apps.googleusercontent.com","client_secret":"synthetic-client-secret"}}"#;

    #[test]
    fn loads_playback_settings_alongside_the_saved_oauth_client_path() {
        let directory = TestDirectory::new();
        let path = directory.path();
        fs::write(
            &path,
            br#"{"iframe_player":true,"auto_advance":true,"youtube_oauth_client_file":"client.json"}"#,
        )
        .unwrap();

        let preferences = Preferences::load(path);
        assert_eq!(preferences.problem(), None);
        assert!(preferences.iframe_player() && preferences.auto_advance());
    }

    #[test]
    fn saves_only_the_oauth_path_and_preserves_existing_settings_when_it_is_forgotten() {
        let directory = TestDirectory::new();
        let client_file = directory.0.join("client.json");
        let key_file = directory.0.join("key.txt");
        fs::write(&client_file, SYNTHETIC_OAUTH_CLIENT).unwrap();
        fs::write(&key_file, SYNTHETIC_GOOGLE_KEY).unwrap();
        let path = directory.path();
        let mut preferences = Preferences::load(path.clone());
        preferences
            .set_youtube_key_file(Some(key_file.clone()))
            .unwrap();
        preferences
            .set_playback(true, true, false, AudioOutput::default())
            .unwrap();
        assert_eq!(preferences.youtube_oauth_client_file(), None);
        preferences
            .set_youtube_oauth_client_file(Some(client_file.clone()))
            .unwrap();

        let saved = fs::read_to_string(&path).unwrap();
        assert!(!saved.contains("synthetic-client-secret"));
        assert!(!saved.contains("test.apps.googleusercontent.com"));
        let mut restored = Preferences::load(path.clone());
        assert_eq!(
            restored.youtube_oauth_client_file(),
            Some(client_file.as_path())
        );
        assert_eq!(restored.youtube_key_file(), Some(key_file.as_path()));
        assert!(restored.iframe_player() && restored.auto_advance());

        restored.set_youtube_oauth_client_file(None).unwrap();
        let restored = Preferences::load(path);
        assert_eq!(restored.youtube_oauth_client_file(), None);
        assert_eq!(restored.youtube_key_file(), Some(key_file.as_path()));
        assert!(restored.iframe_player() && restored.auto_advance());
        assert!(fs::read(client_file).unwrap() == SYNTHETIC_OAUTH_CLIENT);
    }

    #[test]
    fn rejects_invalid_oauth_file_choices_without_replacing_the_saved_path() {
        let directory = TestDirectory::new();
        let client_file = directory.0.join("client.json");
        fs::write(&client_file, SYNTHETIC_OAUTH_CLIENT).unwrap();
        let path = directory.path();
        let mut preferences = Preferences::load(path.clone());
        preferences
            .set_youtube_oauth_client_file(Some(client_file.clone()))
            .unwrap();
        let original = fs::read(&path).unwrap();
        let invalid = directory.0.join("private-invalid.json");
        let mut oversized = SYNTHETIC_OAUTH_CLIENT.to_vec();
        oversized.resize(16 * 1024 + 1, b' ');
        for bytes in [
            b"{ private-value".as_slice(),
            br#"{"web":{"client_id":"test.apps.googleusercontent.com"}}"#,
            oversized.as_slice(),
        ] {
            fs::write(&invalid, bytes).unwrap();
            let problem = preferences
                .set_youtube_oauth_client_file(Some(invalid.clone()))
                .unwrap_err();
            assert!(!problem.contains("private-invalid.json"));
            assert!(!problem.contains("private-value"));
        }
        for path in [
            directory.0.clone(),
            directory.0.join("missing.json"),
            PathBuf::from("relative.json"),
        ] {
            assert!(
                preferences
                    .set_youtube_oauth_client_file(Some(path))
                    .is_err()
            );
        }
        assert_eq!(
            preferences.youtube_oauth_client_file(),
            Some(client_file.as_path())
        );
        assert_eq!(fs::read(path).unwrap(), original);
    }

    #[test]
    fn prefers_the_oauth_launch_override_and_rereads_the_saved_file_on_launch() {
        let directory = TestDirectory::new();
        let file = directory.0.join("client.json");
        let missing = directory.0.join("missing.json");
        fs::write(&file, SYNTHETIC_OAUTH_CLIENT).unwrap();
        let mut preferences = Preferences::load(directory.path());
        preferences
            .set_youtube_oauth_client_file(Some(file.clone()))
            .unwrap();
        let saved = preferences.youtube_oauth_client_file();
        assert!(matches!(ClientConfig::configured(None, None), Ok(None)));
        assert!(matches!(ClientConfig::configured(None, saved), Ok(Some(_))));
        assert!(ClientConfig::configured(Some(&missing), saved).is_err());

        fs::write(&file, b"invalid after selection").unwrap();
        assert!(ClientConfig::configured(None, saved).is_err());
        let override_file = directory.0.join("override.json");
        fs::write(&override_file, SYNTHETIC_OAUTH_CLIENT).unwrap();
        assert!(matches!(
            ClientConfig::configured(Some(&override_file), saved),
            Ok(Some(_))
        ));
    }

    #[test]
    fn remembers_only_the_key_file_location_and_keeps_playback_preferences() {
        let directory = TestDirectory::new();
        let key_file = directory.0.join("key.txt");
        let secret = SYNTHETIC_GOOGLE_KEY;
        fs::write(&key_file, secret).unwrap();
        let path = directory.path();
        let mut preferences = Preferences::load(path.clone());
        preferences
            .set_youtube_key_file(Some(key_file.clone()))
            .unwrap();
        preferences
            .set_playback(true, true, false, AudioOutput::default())
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
        fs::write(&key_file, SYNTHETIC_GOOGLE_KEY).unwrap();
        let path = directory.path();
        let mut preferences = Preferences::load(path.clone());
        preferences
            .set_youtube_key_file(Some(key_file.clone()))
            .unwrap();
        let original = fs::read(&path).unwrap();
        let invalid = directory.0.join("invalid-file.txt");
        for bytes in [
            b" \n".as_slice(),
            b"{ synthetic-secret }",
            b"unrelated-credential",
            b"AIza_too-short",
            &[b'x'; 513],
        ] {
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
        let override_file = directory.0.join("override.txt");
        let missing = directory.0.join("missing.txt");
        fs::write(&valid, SYNTHETIC_GOOGLE_KEY).unwrap();
        fs::write(&override_file, b"synthetic-override").unwrap();

        assert!(matches!(Client::configured(None, None), Ok(None)));
        assert!(matches!(
            Client::configured(None, Some(&valid)),
            Ok(Some(_))
        ));
        assert!(Client::configured(None, Some(&missing)).is_err());
        assert!(Client::configured(None, Some(&override_file)).is_err());
        assert!(Client::configured(Some(&missing), Some(&valid)).is_err());
        assert!(matches!(
            Client::configured(Some(&override_file), Some(&missing)),
            Ok(Some(_))
        ));
    }

    #[test]
    fn defaults_for_a_missing_file_and_persists_both_choices_across_restarts() {
        let directory = TestDirectory::new();
        let path = directory.path();
        let mut preferences = Preferences::load(path.clone());
        let enabled_by_default = cfg!(any(target_os = "macos", target_os = "linux"));
        assert_eq!(preferences.iframe_player(), enabled_by_default);
        assert!(!preferences.auto_advance());
        assert!(!preferences.repeat_queue());
        assert_eq!(preferences.problem(), None);
        assert!(!path.exists());

        preferences
            .set_playback(!enabled_by_default, false, false, AudioOutput::default())
            .unwrap();
        assert_eq!(preferences.iframe_player(), !enabled_by_default);
        let mut restored = Preferences::load(path.clone());
        assert_eq!(restored.iframe_player(), !enabled_by_default);
        assert_eq!(restored.problem(), None);
        restored
            .set_playback(enabled_by_default, false, false, AudioOutput::default())
            .unwrap();
        assert_eq!(Preferences::load(path).iframe_player(), enabled_by_default);
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
            .set_playback(true, false, false, AudioOutput::default())
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
                    .set_playback(false, false, false, AudioOutput::default())
                    .is_err()
            );
            assert!(
                preferences
                    .set_playback(true, false, false, AudioOutput::default())
                    .is_err()
            );
            assert!(preferences.set_youtube_key_file(None).is_err());
            assert!(preferences.set_youtube_oauth_client_file(None).is_err());
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
                .set_playback(true, false, false, AudioOutput::default())
                .is_err()
        );
        assert!(path.is_dir());
    }

    #[test]
    fn failed_write_keeps_the_last_saved_choice_and_can_be_retried() {
        let directory = TestDirectory::new();
        let path = directory.path();
        fs::write(&path, br#"{"iframe_player":false}"#).unwrap();
        let backup = directory.0.join("saved.json");
        let mut preferences = Preferences::load(path.clone());
        preferences
            .set_playback(true, false, false, AudioOutput::default())
            .unwrap();
        fs::rename(&path, &backup).unwrap();
        fs::create_dir(&path).unwrap();

        assert!(
            preferences
                .set_playback(false, false, false, AudioOutput::default())
                .is_err()
        );
        assert!(preferences.iframe_player());
        assert_eq!(preferences.problem(), None);
        assert!(Preferences::load(backup.clone()).iframe_player());

        fs::remove_dir(&path).unwrap();
        fs::rename(backup, &path).unwrap();
        preferences
            .set_playback(false, false, false, AudioOutput::default())
            .unwrap();
        assert!(!Preferences::load(path).iframe_player());
    }
}
