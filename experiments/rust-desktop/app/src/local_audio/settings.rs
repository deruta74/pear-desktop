use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::{self, Read},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use pear_preview_dsp::ReverbSettings;
use serde::{Deserialize, Serialize};

const MAX_FILE_BYTES: u64 = 4096;
const SAVE_DELAY: Duration = Duration::from_millis(500);
const LOCK_RETRY: Duration = Duration::from_millis(250);
const QUIT_LOCK_RETRY: Duration = Duration::from_millis(25);
const QUIT_LOCK_WAIT: Duration = Duration::from_millis(250);
const READ_ERROR: &str = "Could not read the saved Local Audio settings.";
const INVALID: &str = "The saved Local Audio settings contain invalid data.";
const SAVE_ERROR: &str = "Could not save the Local Audio settings.";
const BUSY: &str = "The Local Audio settings file is busy. Try closing again shortly.";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Settings {
    pub(super) volume: f64,
    pub(super) speed: f64,
    pub(super) intensity: f32,
    pub(super) high_pass_hz: f32,
    pub(super) low_pass_hz: f32,
}

impl Default for Settings {
    fn default() -> Self {
        let reverb = ReverbSettings::default();
        Self {
            volume: 1.0,
            speed: 1.0,
            intensity: reverb.intensity,
            high_pass_hz: reverb.high_pass_hz,
            low_pass_hz: reverb.low_pass_hz,
        }
    }
}

impl Settings {
    pub(super) fn reverb(self) -> ReverbSettings {
        ReverbSettings {
            intensity: self.intensity,
            high_pass_hz: self.high_pass_hz,
            low_pass_hz: self.low_pass_hz,
        }
    }

    fn valid(self) -> bool {
        (0.0..=1.0).contains(&self.volume)
            && (0.7..=1.3).contains(&self.speed)
            && (0.0..=1.0).contains(&self.intensity)
            && (20.0..=20_000.0).contains(&self.high_pass_hz)
            && (20.0..=20_000.0).contains(&self.low_pass_hz)
    }
}

#[derive(Clone, Copy, Default, PartialEq)]
struct Patch {
    volume: Option<f64>,
    speed: Option<f64>,
    intensity: Option<f32>,
    high_pass_hz: Option<f32>,
    low_pass_hz: Option<f32>,
}

impl Patch {
    fn record(&mut self, before: Settings, after: Settings) {
        // A reverb command includes all three values. Claim only controls
        // that changed locally so another process's other edits survive.
        if before.volume != after.volume {
            self.volume = Some(after.volume);
        }
        if before.speed != after.speed {
            self.speed = Some(after.speed);
        }
        if before.intensity != after.intensity {
            self.intensity = Some(after.intensity);
        }
        if before.high_pass_hz != after.high_pass_hz {
            self.high_pass_hz = Some(after.high_pass_hz);
        }
        if before.low_pass_hz != after.low_pass_hz {
            self.low_pass_hz = Some(after.low_pass_hz);
        }
    }

    fn merge(self, disk: Settings) -> Settings {
        Settings {
            volume: self.volume.unwrap_or(disk.volume),
            speed: self.speed.unwrap_or(disk.speed),
            intensity: self.intensity.unwrap_or(disk.intensity),
            high_pass_hz: self.high_pass_hz.unwrap_or(disk.high_pass_hz),
            low_pass_hz: self.low_pass_hz.unwrap_or(disk.low_pass_hz),
        }
    }
}

pub(super) struct Preferences {
    directory: PathBuf,
    current: Settings,
    pending: Patch,
    deadline: Option<Instant>,
    quit_deadline: Option<Instant>,
    problem: Option<&'static str>,
}

impl Preferences {
    pub(super) fn load(directory: PathBuf) -> Self {
        let values = read(&directory.join("settings.json"));
        Self {
            directory,
            current: values.unwrap_or_default(),
            pending: Patch::default(),
            deadline: None,
            quit_deadline: None,
            problem: values.err(),
        }
    }

    pub(super) fn current(&self) -> Settings {
        self.current
    }

    pub(super) fn problem(&self) -> Option<&'static str> {
        self.problem
    }

    pub(super) fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    pub(super) fn update(&mut self, next: Settings, now: Instant) -> bool {
        if !next.valid() || self.current == next {
            return false;
        }
        self.pending.record(self.current, next);
        self.current = next;
        self.schedule_save(now);
        true
    }

    pub(super) fn reset_effects(&mut self, now: Instant) {
        let defaults = Settings::default();
        self.current = Settings {
            volume: self.current.volume,
            ..defaults
        };
        // A reset explicitly claims each effect, even when this window
        // already displays defaults.
        self.pending.speed = Some(defaults.speed);
        self.pending.intensity = Some(defaults.intensity);
        self.pending.high_pass_hz = Some(defaults.high_pass_hz);
        self.pending.low_pass_hz = Some(defaults.low_pass_hz);
        self.schedule_save(now);
    }

    fn schedule_save(&mut self, now: Instant) {
        if self.quit_deadline.is_none() {
            self.deadline = Some(now + SAVE_DELAY);
        }
    }

    pub(super) fn save_if_due(&mut self, now: Instant) -> Quit {
        if self.deadline.is_some_and(|deadline| now >= deadline) {
            self.save_pending(now)
        } else {
            Quit::StayOpen
        }
    }

    pub(super) fn request_quit(&mut self, now: Instant) -> Quit {
        self.quit_deadline.get_or_insert(now + QUIT_LOCK_WAIT);
        self.save_pending(now)
    }

    pub(super) fn flush_on_termination(&mut self) -> Result<(), &'static str> {
        self.save().map_err(SaveFailure::message)
    }

    fn save_pending(&mut self, now: Instant) -> Quit {
        self.deadline = None;
        match self.save() {
            Err(SaveFailure::Busy) => {
                self.deadline = Some(match self.quit_deadline {
                    Some(deadline) if now < deadline => (now + QUIT_LOCK_RETRY).min(deadline),
                    Some(_) => {
                        self.quit_deadline = None;
                        self.problem = Some(BUSY);
                        now + LOCK_RETRY
                    }
                    None => now + LOCK_RETRY,
                });
                Quit::StayOpen
            }
            result => {
                let problem = result.err().map(SaveFailure::message);
                if problem.is_some() {
                    self.problem = problem;
                }
                if self.quit_deadline.take().is_some() {
                    Quit::Exit(problem)
                } else {
                    Quit::StayOpen
                }
            }
        }
    }

    fn save(&mut self) -> Result<(), SaveFailure> {
        if self.pending == Patch::default() {
            return Ok(());
        }
        fs::create_dir_all(&self.directory).map_err(|_| SaveFailure::Other(SAVE_ERROR))?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.directory.join("settings.lock"))
            .map_err(|_| SaveFailure::Other(SAVE_ERROR))?;
        lock.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => SaveFailure::Busy,
            TryLockError::Error(_) => SaveFailure::Other(SAVE_ERROR),
        })?;
        let path = self.directory.join("settings.json");
        let saved = read(&path).map_err(SaveFailure::Other)?;
        let merged = self.pending.merge(saved);
        if merged != saved {
            let bytes = serde_json::to_vec(&merged).map_err(|_| SaveFailure::Other(SAVE_ERROR))?;
            crate::library::write_atomic(&path, &bytes)
                .map_err(|_| SaveFailure::Other(SAVE_ERROR))?;
        }
        self.pending = Patch::default();
        self.problem = None;
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Quit {
    StayOpen,
    Exit(Option<&'static str>),
}

enum SaveFailure {
    Busy,
    Other(&'static str),
}

impl SaveFailure {
    fn message(self) -> &'static str {
        match self {
            Self::Busy => BUSY,
            Self::Other(problem) => problem,
        }
    }
}

fn read(path: &Path) -> Result<Settings, &'static str> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Settings::default()),
        Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_FILE_BYTES => {}
        Ok(_) => return Err(INVALID),
        Err(_) => return Err(READ_ERROR),
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| READ_ERROR)?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| READ_ERROR)?;
    if bytes.len() as u64 > MAX_FILE_BYTES
        || bytes.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{')
    {
        return Err(INVALID);
    }
    let settings: Settings = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
    settings.valid().then_some(settings).ok_or(INVALID)
}

#[cfg(test)]
mod tests;
