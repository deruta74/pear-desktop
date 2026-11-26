use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Seek},
    path::Path,
};

use super::{EngineOpenError, flac::FlacSource, wav::WavSource};

pub(super) const MAX_INPUT_RATE: u32 = 384_000;

#[derive(Clone, Copy)]
pub(super) struct AudioInfo {
    pub(super) frames: u32,
    pub(super) sample_rate: u32,
}

pub(super) enum AudioSource {
    Wav(WavSource),
    Flac(FlacSource),
}

impl AudioSource {
    pub(super) fn open(path: &Path) -> Result<Self, EngineOpenError> {
        let unavailable = |_| EngineOpenError::UnavailableAudio;
        let unsupported = |_| EngineOpenError::UnsupportedAudio;
        if !fs::metadata(path).map_err(unavailable)?.is_file() {
            return Err(EngineOpenError::UnavailableAudio);
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // A path replaced with a FIFO cannot block open.
            options.custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY);
        }
        let mut file = options.open(path).map_err(unavailable)?;
        let metadata = file.metadata().map_err(unavailable)?;
        if !metadata.is_file() {
            return Err(EngineOpenError::UnavailableAudio);
        }
        let mut signature = [0; 4];
        file.read_exact(&mut signature).map_err(unsupported)?;
        file.rewind().map_err(unsupported)?;
        match &signature {
            b"RIFF" => WavSource::open(file, metadata.len()).map(Self::Wav),
            b"fLaC" => FlacSource::open(file, metadata.len()).map(Self::Flac),
            _ => Err(EngineOpenError::UnsupportedAudio),
        }
    }

    pub(super) fn info(&self) -> AudioInfo {
        match self {
            Self::Wav(source) => source.info(),
            Self::Flac(source) => source.info(),
        }
    }

    pub(super) fn seek_to(&mut self, frame: u32) -> io::Result<()> {
        match self {
            Self::Wav(source) => source.seek_to(frame),
            Self::Flac(source) => source.seek_to(frame),
        }
    }

    pub(super) fn read_frame(&mut self) -> io::Result<[f32; 2]> {
        match self {
            Self::Wav(source) => source.read_frame().map_err(io::Error::other),
            Self::Flac(source) => source.read_frame(),
        }
    }
}
