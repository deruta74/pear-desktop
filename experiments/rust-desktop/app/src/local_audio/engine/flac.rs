use std::{
    fs::File,
    io::{self, BufReader, Read, Seek, SeekFrom},
    sync::Arc,
};

use symphonia::core::{
    codecs::audio::AudioDecoder,
    formats::{FormatReader, SeekMode, SeekTo, TrackType, probe::Hint},
    io::{MediaSource, MediaSourceStream},
    packet::Packet,
    units::Timestamp,
};

use super::{
    EngineOpenError,
    source::{AudioInfo, MAX_INPUT_RATE},
};

use crate::local_audio::metadata::Metadata;

const MAX_METADATA_BYTES: u64 = 16 * 1024 * 1024;
const MAX_METADATA_BLOCKS: usize = 128;
const MAX_PACKET_FRAMES: usize = u16::MAX as usize;

pub(super) struct FlacSource {
    input: FlacInput,
    reader: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    info: AudioInfo,
    channels: usize,
    samples: Vec<f32>,
    sample_offset: usize,
    next_frame: u32,
}

impl FlacSource {
    pub(super) fn open(
        mut file: File,
        file_length: u64,
    ) -> Result<(Self, Metadata), EngineOpenError> {
        let unsupported = EngineOpenError::UnsupportedAudio;
        let (padding, metadata) =
            validate_metadata(&mut file, file_length).map_err(|_| unsupported)?;
        let input = FlacInput {
            file,
            length: file_length,
            position: 0,
            padding: padding.into(),
        };
        let reader = open_reader(&input).map_err(|_| unsupported)?;
        let track = reader.default_track(TrackType::Audio).ok_or(unsupported)?;
        let params = track
            .codec_params
            .as_ref()
            .and_then(|params| params.audio())
            .ok_or(unsupported)?;
        let frames = track
            .num_frames
            .and_then(|count| u32::try_from(count).ok())
            .filter(|count| *count != 0)
            .ok_or(unsupported)?;
        let sample_rate = params
            .sample_rate
            .filter(|rate| (1..=MAX_INPUT_RATE).contains(rate))
            .ok_or(unsupported)?;
        let channels = params
            .channels
            .as_ref()
            .map(|channels| channels.count())
            .filter(|count| matches!(count, 1 | 2))
            .ok_or(unsupported)?;
        let track_id = track.id;
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(params, &Default::default())
            .map_err(|_| unsupported)?;
        let mut source = Self {
            input,
            reader,
            decoder,
            track_id,
            info: AudioInfo {
                frames,
                sample_rate,
            },
            channels,
            samples: Vec::new(),
            sample_offset: 0,
            next_frame: 0,
        };
        source.read_packet().map_err(|_| unsupported)?;
        Ok((source, metadata))
    }

    pub(super) fn info(&self) -> AudioInfo {
        self.info
    }

    pub(super) fn seek_to(&mut self, frame: u32) -> io::Result<()> {
        self.decoder.reset();
        self.samples.clear();
        self.sample_offset = 0;
        self.next_frame = frame;
        if frame == self.info.frames
            || self
                .reader
                .seek(
                    SeekMode::Accurate,
                    SeekTo::Timestamp {
                        ts: Timestamp::new(i64::from(frame)),
                        track_id: self.track_id,
                    },
                )
                .is_ok()
        {
            return Ok(());
        }

        // Binary seek can miss a large final packet when there is no index.
        // Scan packet timestamps on the decoder worker and decode only the target.
        self.reader = open_reader(&self.input)?;
        loop {
            let packet = self.next_packet()?;
            let target = Timestamp::new(i64::from(frame));
            if packet.pts > target {
                return Err(io::ErrorKind::InvalidData.into());
            }
            if packet.pts.saturating_add(packet.dur) > target {
                return self.decode_packet(&packet);
            }
        }
    }

    pub(super) fn read_frame(&mut self) -> io::Result<[f32; 2]> {
        if self.next_frame >= self.info.frames {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        if self.sample_offset == self.samples.len() {
            self.read_packet()?;
        }
        let left = self.samples[self.sample_offset];
        let right = self.samples[self.sample_offset + self.channels - 1];
        self.sample_offset += self.channels;
        self.next_frame += 1;
        Ok([left, right])
    }

    fn next_packet(&mut self) -> io::Result<Packet> {
        self.reader
            .next_packet()
            .map_err(io::Error::other)?
            .ok_or_else(|| io::ErrorKind::UnexpectedEof.into())
    }

    fn read_packet(&mut self) -> io::Result<()> {
        let packet = self.next_packet()?;
        self.decode_packet(&packet)
    }

    fn decode_packet(&mut self, packet: &Packet) -> io::Result<()> {
        let audio = self.decoder.decode(packet).map_err(io::Error::other)?;
        if packet.track_id != self.track_id
            || audio.spec().rate() != self.info.sample_rate
            || audio.spec().channels().count() != self.channels
            || audio.frames() > MAX_PACKET_FRAMES
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let offset = i64::from(self.next_frame)
            .checked_sub(packet.pts.get())
            .and_then(|offset| usize::try_from(offset).ok())
            .filter(|offset| *offset < audio.frames())
            .ok_or(io::ErrorKind::InvalidData)?;
        self.samples.resize(audio.samples_interleaved(), 0.0);
        audio.copy_to_slice_interleaved(&mut self.samples);
        self.sample_offset = offset * self.channels;
        Ok(())
    }
}

fn open_reader(source: &FlacInput) -> io::Result<Box<dyn FormatReader>> {
    let mut input = FlacInput {
        file: source.file.try_clone()?,
        position: 0,
        length: source.length,
        padding: Arc::clone(&source.padding),
    };
    input.rewind()?;
    let stream = MediaSourceStream::new(Box::new(input), Default::default());
    symphonia::default::get_probe()
        .probe(&Hint::new(), stream, Default::default(), Default::default())
        .map_err(io::Error::other)
}

fn validate_metadata(
    file: &mut File,
    file_length: u64,
) -> io::Result<(Vec<PaddingBlock>, Metadata)> {
    let mut offset = 4;
    let mut seek_table = None;
    let mut padding = Vec::new();
    let mut metadata = None;
    for _ in 0..MAX_METADATA_BLOCKS {
        file.seek(SeekFrom::Start(offset))?;
        let mut header = [0; 4];
        file.read_exact(&mut header)?;
        let size = u64::from(u32::from_be_bytes([0, header[1], header[2], header[3]]));
        let start = offset;
        let payload = start + 4;
        offset = payload + size;
        if offset >= file_length || offset > MAX_METADATA_BYTES {
            break;
        }
        match header[0] & 0x7f {
            3 if seek_table.replace((payload, size)).is_some() => break,
            kind @ (4 | 6) => {
                if kind == 4 && metadata.is_none() {
                    metadata = Metadata::read_vorbis(&mut *file, size).ok();
                }
                padding.push(PaddingBlock {
                    start,
                    end: offset,
                    header: [(header[0] & 0x80) | 1, header[1], header[2], header[3]],
                });
            }
            _ => (),
        }
        if header[0] & 0x80 != 0 {
            if let Some((start, size)) = seek_table {
                file.seek(SeekFrom::Start(start))?;
                validate_seek_table(BufReader::new(file.take(size)), size, file_length - offset)?;
            }
            return Ok((padding, metadata.unwrap_or_default()));
        }
    }
    Err(io::ErrorKind::InvalidData.into())
}

fn validate_seek_table(mut reader: impl Read, size: u64, audio_bytes: u64) -> io::Result<()> {
    const ENTRY: usize = 18;
    if !size.is_multiple_of(ENTRY as u64) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut previous = None;
    for _ in 0..size / ENTRY as u64 {
        let mut entry = [0; ENTRY];
        reader.read_exact(&mut entry)?;
        let sample = u64::from_be_bytes(entry[..8].try_into().expect("8 sample bytes"));
        if sample == u64::MAX {
            continue;
        }
        let offset = u64::from_be_bytes(entry[8..16].try_into().expect("8 offset bytes"));
        if offset >= audio_bytes
            || previous.is_some_and(|(last_sample, last_offset)| {
                sample <= last_sample || offset <= last_offset
            })
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        previous = Some((sample, offset));
    }
    Ok(())
}

struct PaddingBlock {
    start: u64,
    end: u64,
    header: [u8; 4],
}

// Symphonia parses pictures and Vorbis comments eagerly. Present those blocks
// as padding while keeping every physical audio and seek-table offset intact.
struct FlacInput {
    file: File,
    length: u64,
    position: u64,
    padding: Arc<[PaddingBlock]>,
}

impl Read for FlacInput {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let next = self
            .padding
            .partition_point(|block| block.end <= self.position);
        let count = if let Some(block) = self.padding.get(next) {
            if self.position >= block.start {
                let len = (block.end - self.position).min(buffer.len() as u64) as usize;
                let offset = self.position - block.start;
                let header_len = 4_u64.saturating_sub(offset).min(len as u64) as usize;
                if header_len > 0 {
                    let offset = offset as usize;
                    buffer[..header_len]
                        .copy_from_slice(&block.header[offset..offset + header_len]);
                }
                buffer[header_len..len].fill(0);
                if self.position + len as u64 == block.end {
                    self.file.seek(SeekFrom::Start(block.end))?;
                }
                len
            } else {
                let len = (block.start - self.position).min(buffer.len() as u64) as usize;
                self.file.read(&mut buffer[..len])?
            }
        } else {
            self.file.read(buffer)?
        };
        self.position += count as u64;
        Ok(count)
    }
}

impl Seek for FlacInput {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let position = match position {
            SeekFrom::Current(delta) => SeekFrom::Start(
                self.position
                    .checked_add_signed(delta)
                    .ok_or(io::ErrorKind::InvalidInput)?,
            ),
            other => other,
        };
        self.position = self.file.seek(position)?;
        Ok(self.position)
    }
}

impl MediaSource for FlacInput {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.length)
    }
}
