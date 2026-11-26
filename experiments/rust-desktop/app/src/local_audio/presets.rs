use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::equalizer::Profile;

const MAX_PRESETS: usize = 24;
const MAX_NAME_CHARS: usize = 48;
const MAX_FILE_SIZE: u64 = 192 * 1024;
const SAVE_ERROR: &str = "Could not save the local equalizer presets.";
const LOAD_ERROR: &str = "Could not read the local equalizer presets.";

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Preset {
    pub(super) name: String,
    pub(super) profile: Profile,
}

pub(super) struct Store {
    directory: PathBuf,
}

impl Store {
    pub(super) fn from_environment() -> crate::Result<Self> {
        let directory = match std::env::var_os("PEAR_LOCAL_AUDIO_DIR") {
            Some(path) if Path::new(&path).is_absolute() => PathBuf::from(path),
            Some(_) => return Err("PEAR_LOCAL_AUDIO_DIR must be an absolute path.".into()),
            None => crate::player::data_root()?.join("com.pear-desktop.rust-preview-local-audio"),
        };
        Ok(Self { directory })
    }

    pub(super) fn read(&self) -> Result<Vec<Preset>, &'static str> {
        let path = self.directory.join("equalizer-presets.json");
        match path.metadata() {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_FILE_SIZE => {}
            _ => return Err(LOAD_ERROR),
        }
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(|_| LOAD_ERROR)?
            .take(MAX_FILE_SIZE + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| LOAD_ERROR)?;
        if bytes.len() as u64 > MAX_FILE_SIZE {
            return Err(LOAD_ERROR);
        }
        let mut presets: Vec<Preset> = serde_json::from_slice(&bytes).map_err(|_| LOAD_ERROR)?;
        if presets.len() > MAX_PRESETS {
            return Err(LOAD_ERROR);
        }
        let mut names = std::collections::HashSet::with_capacity(presets.len());
        for preset in &mut presets {
            if normalize_name(&preset.name) != Some(preset.name.as_str())
                || !names.insert(preset.name.clone())
            {
                return Err(LOAD_ERROR);
            }
            preset.profile = preset.profile.clone().normalize().ok_or(LOAD_ERROR)?;
        }
        Ok(presets)
    }

    pub(super) fn save(&self, name: &str, profile: &Profile) -> Result<Vec<Preset>, &'static str> {
        let name = normalize_name(name).ok_or("Enter a preset name of up to 48 characters.")?;
        self.change(|presets| {
            if presets.iter().any(|preset| preset.name == name) {
                return Err("A preset with that name already exists.");
            }
            if presets.len() == MAX_PRESETS {
                return Err("Remove an existing preset before saving another.");
            }
            presets.push(Preset {
                name: name.into(),
                profile: profile.clone(),
            });
            Ok(())
        })
    }

    pub(super) fn remove(&self, name: &str) -> Result<Vec<Preset>, &'static str> {
        self.change(|presets| {
            let index = presets
                .iter()
                .position(|preset| preset.name == name)
                .ok_or("That equalizer preset no longer exists.")?;
            presets.remove(index);
            Ok(())
        })
    }

    fn change(
        &self,
        update: impl FnOnce(&mut Vec<Preset>) -> Result<(), &'static str>,
    ) -> Result<Vec<Preset>, &'static str> {
        fs::create_dir_all(&self.directory).map_err(|_| SAVE_ERROR)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.directory.join("equalizer-presets.lock"))
            .map_err(|_| SAVE_ERROR)?;
        lock.try_lock()
            .map_err(|_| "The preset file is busy. Try again.")?;
        let mut presets = self.read()?;
        update(&mut presets)?;
        let data = serde_json::to_vec(&presets).map_err(|_| SAVE_ERROR)?;
        if data.len() as u64 > MAX_FILE_SIZE {
            return Err(SAVE_ERROR);
        }
        crate::library::write_atomic(&self.directory.join("equalizer-presets.json"), &data)
            .map_err(|_| SAVE_ERROR)?;
        Ok(presets)
    }
}

fn normalize_name(name: &str) -> Option<&str> {
    let name = name.trim();
    (!name.is_empty()
        && name.chars().count() <= MAX_NAME_CHARS
        && !name.chars().any(char::is_control))
    .then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reopens_presets_preserves_other_writers_and_rejects_corrupt_files() {
        let directory = std::env::temp_dir().join(format!(
            "pear-presets-{}-{}",
            std::process::id(),
            fastrand::u64(..)
        ));
        let first = Store {
            directory: directory.clone(),
        };
        let second = Store {
            directory: directory.clone(),
        };
        assert!(first.read().unwrap().is_empty());
        assert!(!directory.exists());
        first.save(" Studio ", &Profile::default()).unwrap();
        second.save("Headphones", &Profile::default()).unwrap();
        let reopened = first.read().unwrap();
        assert_eq!(
            reopened
                .iter()
                .map(|preset| preset.name.as_str())
                .collect::<Vec<_>>(),
            ["Studio", "Headphones"]
        );
        assert!(first.save("Studio", &Profile::default()).is_err());
        assert_eq!(second.remove("Studio").unwrap()[0].name, "Headphones");
        let path = directory.join("equalizer-presets.json");
        fs::write(&path, b"broken").unwrap();
        assert!(first.save("New", &Profile::default()).is_err());
        assert_eq!(fs::read(path).unwrap(), b"broken");
        fs::remove_dir_all(directory).unwrap();
    }
}
