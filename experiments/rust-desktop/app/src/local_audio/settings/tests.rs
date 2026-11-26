use std::fs;

use super::*;

struct Profile(PathBuf);

impl Profile {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "pear-local-settings-{}-{}",
            std::process::id(),
            fastrand::u64(..)
        )))
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn startup_and_unchanged_controls_do_not_create_the_profile() {
    let profile = Profile::new();
    let mut preferences = Preferences::load(profile.0.clone());
    let now = Instant::now();
    assert_eq!(preferences.current(), Settings::default());
    assert!(!preferences.update(Settings::default(), now));
    assert!(preferences.deadline().is_none());
    preferences.save_if_due(now + Duration::from_secs(5));
    preferences.flush_on_exit().unwrap();
    assert!(!profile.0.exists());
}

#[test]
fn coalesces_changes_and_restores_exact_values_on_restart() {
    let profile = Profile::new();
    let mut preferences = Preferences::load(profile.0.clone());
    let now = Instant::now();
    let first = Settings {
        volume: 0.31,
        ..Settings::default()
    };
    assert!(preferences.update(first, now));
    let first_deadline = preferences.deadline().unwrap();
    let final_values = Settings {
        volume: 0.72,
        speed: 1.17,
        intensity: 0.43,
        high_pass_hz: 216.375,
        low_pass_hz: 7127.625,
    };
    assert!(preferences.update(final_values, now + Duration::from_millis(100)));
    let final_deadline = preferences.deadline().unwrap();
    assert!(final_deadline > first_deadline);
    preferences.save_if_due(first_deadline);
    assert!(!profile.0.exists());
    preferences.save_if_due(final_deadline);
    assert!(preferences.deadline().is_none());
    assert_eq!(Preferences::load(profile.0.clone()).current(), final_values);
}

#[test]
fn clean_quit_merges_only_controls_changed_in_each_session() {
    let profile = Profile::new();
    let mut first = Preferences::load(profile.0.clone());
    let mut second = Preferences::load(profile.0.clone());
    let now = Instant::now();
    assert!(first.update(
        Settings {
            volume: 0.55,
            high_pass_hz: 235.125,
            ..first.current()
        },
        now,
    ));
    assert!(second.update(
        Settings {
            speed: 0.83,
            intensity: 0.32,
            low_pass_hz: 5700.875,
            ..second.current()
        },
        now,
    ));
    first.flush_on_exit().unwrap();
    second.flush_on_exit().unwrap();
    assert_eq!(
        Preferences::load(profile.0.clone()).current(),
        Settings {
            volume: 0.55,
            speed: 0.83,
            intensity: 0.32,
            high_pass_hz: 235.125,
            low_pass_hz: 5700.875,
        }
    );
}

#[test]
fn corrupt_and_unknown_settings_are_left_intact() {
    let profile = Profile::new();
    fs::create_dir(&profile.0).unwrap();
    let path = profile.0.join("settings.json");
    let cases = [
        b"broken".to_vec(),
        b"[0.5, 1.0, 0.0, 180, 6500]".to_vec(),
        br#"{"volume":0.5,"futureField":true}"#.to_vec(),
        br#"{"highPassHz":4}"#.to_vec(),
        vec![b' '; 8192],
    ];
    for bytes in cases {
        fs::write(&path, &bytes).unwrap();
        let mut preferences = Preferences::load(profile.0.clone());
        assert_eq!(preferences.current(), Settings::default());
        assert!(preferences.problem().is_some());
        preferences.update(
            Settings {
                volume: 0.4,
                ..preferences.current()
            },
            Instant::now(),
        );
        assert_eq!(preferences.current().volume, 0.4);
        assert!(preferences.flush_on_exit().is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn flush_preserves_a_file_replaced_after_startup() {
    let profile = Profile::new();
    let mut preferences = Preferences::load(profile.0.clone());
    fs::create_dir(&profile.0).unwrap();
    let path = profile.0.join("settings.json");
    let unknown = br#"{"schemaVersion":2}"#;
    fs::write(&path, unknown).unwrap();
    preferences.update(
        Settings {
            speed: 0.84,
            ..preferences.current()
        },
        Instant::now(),
    );
    assert!(preferences.flush_on_exit().is_err());
    assert_eq!(fs::read(path).unwrap(), unknown);
}

#[test]
fn busy_lock_reschedules_pending_write() {
    let profile = Profile::new();
    fs::create_dir(&profile.0).unwrap();
    let lock = File::create(profile.0.join("settings.lock")).unwrap();
    lock.try_lock().unwrap();
    let mut preferences = Preferences::load(profile.0.clone());
    preferences.update(
        Settings {
            volume: 0.61,
            ..preferences.current()
        },
        Instant::now(),
    );
    let due = preferences.deadline().unwrap();
    preferences.save_if_due(due);
    let retry = preferences.deadline().unwrap();
    assert!(due < retry);
    assert!(!profile.0.join("settings.json").exists());
    drop(lock);
    preferences.save_if_due(retry);
    assert_eq!(Preferences::load(profile.0.clone()).current().volume, 0.61);
}

#[test]
fn invalid_ipc_values_do_not_schedule_a_write() {
    let profile = Profile::new();
    let mut preferences = Preferences::load(profile.0.clone());
    assert!(!preferences.update(
        Settings {
            speed: 1.4,
            intensity: 0.7,
            ..preferences.current()
        },
        Instant::now(),
    ));
    assert_eq!(preferences.current(), Settings::default());
    assert!(preferences.deadline().is_none());
}
