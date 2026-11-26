use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::library::write_atomic;

pub(super) const REVISION: u32 = 2;
const MAX_FILE_BYTES: u64 = 1024;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Marker {
    revision: u32,
}

pub(super) struct Consent {
    path: PathBuf,
    accepted: bool,
}

impl Consent {
    pub(super) fn load(path: PathBuf) -> Self {
        let accepted = stored_revision(&path) == Some(REVISION);
        Self { path, accepted }
    }

    pub(super) fn accepted(&self) -> bool {
        self.accepted
    }

    pub(super) fn accept(&mut self, revision: u32) -> io::Result<()> {
        if revision != REVISION {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Review the current playback agreement before accepting it.",
            ));
        }
        if self.accepted {
            return Ok(());
        }
        let bytes = serde_json::to_vec(&Marker { revision }).map_err(io::Error::other)?;
        write_atomic(&self.path, &bytes)?;
        self.accepted = true;
        Ok(())
    }
}

fn stored_revision(path: &Path) -> Option<u32> {
    if !path.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    // Require an object because Serde also accepts positional arrays for structs.
    if bytes.len() as u64 > MAX_FILE_BYTES
        || bytes.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{')
    {
        return None;
    }
    serde_json::from_slice::<Marker>(&bytes)
        .ok()
        .map(|marker| marker.revision)
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
                    "pear-consent-test-{}-{}",
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
            self.0.join("consent.json")
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn starts_unaccepted_and_persists_only_the_current_revision() {
        let directory = TestDirectory::new();
        let path = directory.path();
        let mut consent = Consent::load(path.clone());
        assert!(!consent.accepted());
        assert!(!path.exists());

        consent.accept(REVISION).unwrap();
        assert!(consent.accepted());
        assert!(Consent::load(path.clone()).accepted());
        let stored: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(stored, serde_json::json!({ "revision": REVISION }));
    }

    #[test]
    fn requires_the_playlist_disclosure_for_profiles_on_the_original_revision() {
        let directory = TestDirectory::new();
        let path = directory.path();
        let original_marker = r#"{"revision":1}"#;
        fs::write(&path, original_marker).unwrap();

        let consent = Consent::load(path.clone());
        assert!(!consent.accepted());
        assert_eq!(fs::read_to_string(path).unwrap(), original_marker);
    }

    #[test]
    fn rejects_stale_and_future_revisions_without_changing_either_state() {
        let directory = TestDirectory::new();
        let path = directory.path();
        for revision in [REVISION - 1, REVISION + 1] {
            let marker = serde_json::json!({ "revision": revision }).to_string();
            fs::write(&path, &marker).unwrap();
            let mut consent = Consent::load(path.clone());
            assert!(!consent.accepted());
            assert!(consent.accept(revision).is_err());
            assert!(!consent.accepted());
            assert_eq!(fs::read_to_string(&path).unwrap(), marker);
        }
    }

    #[test]
    fn requires_explicit_current_acceptance_to_replace_invalid_markers() {
        let directory = TestDirectory::new();
        let path = directory.path();
        let mut oversized = format!(r#"{{"revision":{REVISION}}}"#).into_bytes();
        oversized.resize(MAX_FILE_BYTES as usize + 1, b' ');
        for marker in [
            b"{".to_vec(),
            b"{}".to_vec(),
            format!("[{REVISION}]").into_bytes(),
            format!(r#"{{"revision":{REVISION},"user_id":"extra"}}"#).into_bytes(),
            oversized,
        ] {
            fs::write(&path, &marker).unwrap();
            let mut consent = Consent::load(path.clone());
            assert!(!consent.accepted());
            assert_eq!(fs::read(&path).unwrap(), marker);
            consent.accept(REVISION).unwrap();
            assert!(consent.accepted());
            assert!(Consent::load(path.clone()).accepted());
        }
    }

    #[test]
    fn a_failed_save_leaves_consent_unaccepted_and_can_be_retried() {
        let directory = TestDirectory::new();
        let path = directory.path();
        let mut consent = Consent::load(path.clone());
        fs::create_dir(&path).unwrap();
        assert!(consent.accept(REVISION).is_err());
        assert!(!consent.accepted());
        assert!(path.is_dir());

        fs::remove_dir(&path).unwrap();
        consent.accept(REVISION).unwrap();
        assert!(Consent::load(path).accepted());
    }
}
