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
    assert_eq!(preferences.request_quit(Instant::now()), Quit::Exit(None));
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
    assert_eq!(first.request_quit(now), Quit::Exit(None));
    assert_eq!(second.request_quit(now), Quit::Exit(None));
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
        assert_eq!(
            preferences.request_quit(Instant::now()),
            Quit::Exit(Some(INVALID))
        );
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
    assert_eq!(
        preferences.request_quit(Instant::now()),
        Quit::Exit(Some(INVALID))
    );
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

#[test]
fn commits_audio_control_commands_without_an_engine_during_handoff() {
    use super::super::{AudioCommand, apply_settings_command};

    let profile = Profile::new();
    let mut preferences = Preferences::load(profile.0.clone());
    let now = Instant::now();
    for command in [
        AudioCommand::SetVolume { volume: 0.38 },
        AudioCommand::SetSpeed { speed: 1.12 },
        AudioCommand::SetReverb {
            intensity: 0.24,
            high_pass_hz: 232.0,
            low_pass_hz: 6389.0,
        },
    ] {
        assert!(apply_settings_command(
            &command,
            &mut preferences,
            None,
            now
        ));
    }
    assert_eq!(
        preferences.current(),
        Settings {
            volume: 0.38,
            speed: 1.12,
            intensity: 0.24,
            high_pass_hz: 232.0,
            low_pass_hz: 6389.0,
        }
    );
    preferences.save_if_due(preferences.deadline().unwrap());
    assert_eq!(
        Preferences::load(profile.0.clone()).current(),
        preferences.current()
    );
}

#[test]
fn reset_from_a_session_with_defaults_claims_effects_and_preserves_concurrent_volume() {
    use super::super::{AudioCommand, apply_settings_command};

    let profile = Profile::new();
    let mut stale = Preferences::load(profile.0.clone());
    let mut writer = Preferences::load(profile.0.clone());
    let now = Instant::now();
    assert!(writer.update(
        Settings {
            volume: 0.47,
            speed: 1.13,
            intensity: 0.36,
            high_pass_hz: 222.0,
            low_pass_hz: 8201.0,
        },
        now,
    ));
    writer.save_if_due(writer.deadline().unwrap());
    assert_eq!(stale.current(), Settings::default());
    assert!(apply_settings_command(
        &AudioCommand::ResetEffects {},
        &mut stale,
        None,
        now,
    ));
    stale.save_if_due(stale.deadline().unwrap());
    assert_eq!(
        Preferences::load(profile.0.clone()).current(),
        Settings {
            volume: 0.47,
            ..Settings::default()
        }
    );
}

#[test]
fn quit_with_a_busy_lock_keeps_the_pending_edit_and_can_be_retried() {
    let profile = Profile::new();
    fs::create_dir(&profile.0).unwrap();
    let lock = File::create(profile.0.join("settings.lock")).unwrap();
    lock.try_lock().unwrap();

    let now = Instant::now();
    let mut preferences = Preferences::load(profile.0.clone());
    preferences.update(
        Settings {
            volume: 0.63,
            ..preferences.current()
        },
        now,
    );
    assert_eq!(preferences.request_quit(now), Quit::StayOpen);
    let retry = preferences.deadline().unwrap();
    assert!(retry < now + QUIT_LOCK_WAIT);
    assert!(preferences.problem().is_none());
    assert_eq!(
        preferences.save_if_due(now + QUIT_LOCK_WAIT),
        Quit::StayOpen
    );
    assert_eq!(preferences.problem(), Some(BUSY));
    assert!(!profile.0.join("settings.json").exists());

    drop(lock);
    assert_eq!(
        preferences.request_quit(now + QUIT_LOCK_WAIT + LOCK_RETRY),
        Quit::Exit(None)
    );
    assert_eq!(Preferences::load(profile.0.clone()).current().volume, 0.63);
}

#[test]
fn quit_finishes_automatically_if_the_lock_releases_during_retry() {
    let profile = Profile::new();
    fs::create_dir(&profile.0).unwrap();
    let lock = File::create(profile.0.join("settings.lock")).unwrap();
    lock.try_lock().unwrap();

    let now = Instant::now();
    let mut preferences = Preferences::load(profile.0.clone());
    preferences.update(
        Settings {
            volume: 0.73,
            ..preferences.current()
        },
        now,
    );
    assert_eq!(preferences.request_quit(now), Quit::StayOpen);
    drop(lock);
    assert_eq!(
        preferences.save_if_due(preferences.deadline().unwrap()),
        Quit::Exit(None)
    );
    assert_eq!(Preferences::load(profile.0.clone()).current().volume, 0.73);
}

#[test]
fn graceful_termination_flushes_the_edit_before_the_debounce_deadline() {
    let profile = Profile::new();
    let now = Instant::now();
    let mut preferences = Preferences::load(profile.0.clone());
    preferences.update(
        Settings {
            volume: 0.58,
            ..preferences.current()
        },
        now,
    );
    assert!(!profile.0.exists());
    assert_eq!(preferences.flush_on_termination(), Ok(()));
    assert_eq!(Preferences::load(profile.0.clone()).current().volume, 0.58);
    // A second pass has no write to make, even if the file is now unavailable.
    fs::remove_dir_all(&profile.0).unwrap();
    assert_eq!(preferences.flush_on_termination(), Ok(()));
    assert!(!profile.0.exists());
}
