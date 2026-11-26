use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Seek},
    path::Path,
};

use super::{
    EngineOpenError, flac::FlacSource, m4a::M4aSource, mp3::Mp3Source, opus::OpusSource,
    wav::WavSource,
};

use crate::local_audio::metadata::Metadata;

pub(super) const MAX_INPUT_RATE: u32 = 384_000;

#[derive(Clone, Copy)]
pub(super) struct AudioInfo {
    pub(super) frames: u32,
    pub(super) sample_rate: u32,
}

enum Format {
    Wav(WavSource),
    Flac(FlacSource),
    M4a(Box<M4aSource>),
    Mp3(Box<Mp3Source>),
    Opus(Box<OpusSource>),
}

pub(super) struct AudioSource {
    format: Format,
    pub(super) metadata: Metadata,
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
        let length = metadata.len();
        let (format, metadata) = match &signature {
            b"RIFF" => (
                Format::Wav(WavSource::open(file, length)?),
                Metadata::default(),
            ),
            b"fLaC" => {
                let (source, metadata) = FlacSource::open(file, length)?;
                (Format::Flac(source), metadata)
            }
            b"OggS" => {
                let (source, metadata) = OpusSource::open(file, length)?;
                (Format::Opus(Box::new(source)), metadata)
            }
            header if Mp3Source::recognizes(header) => {
                let (source, metadata) = Mp3Source::open(file, length)?;
                (Format::Mp3(Box::new(source)), metadata)
            }
            _ if path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("m4a")) =>
            {
                (
                    Format::M4a(Box::new(M4aSource::open(file, length)?)),
                    Metadata::default(),
                )
            }
            _ => return Err(EngineOpenError::UnsupportedAudio),
        };
        Ok(Self { format, metadata })
    }

    pub(super) fn info(&self) -> AudioInfo {
        match &self.format {
            Format::Wav(source) => source.info(),
            Format::Flac(source) => source.info(),
            Format::M4a(source) => source.info(),
            Format::Mp3(source) => source.info(),
            Format::Opus(source) => source.info(),
        }
    }

    pub(super) fn seek_to(&mut self, frame: u32) -> io::Result<()> {
        match &mut self.format {
            Format::Wav(source) => source.seek_to(frame),
            Format::Flac(source) => source.seek_to(frame),
            Format::M4a(source) => source.seek_to(frame),
            Format::Mp3(source) => source.seek_to(frame),
            Format::Opus(source) => source.seek_to(frame),
        }
    }

    pub(super) fn read_frame(&mut self) -> io::Result<[f32; 2]> {
        match &mut self.format {
            Format::Wav(source) => source.read_frame().map_err(io::Error::other),
            Format::Flac(source) => source.read_frame(),
            Format::M4a(source) => source.read_frame(),
            Format::Mp3(source) => source.read_frame(),
            Format::Opus(source) => source.read_frame(),
        }
    }
}
