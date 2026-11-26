use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use symphonia::{
    core::{
        codecs::audio::{AudioDecoder, well_known::CODEC_ID_OPUS},
        formats::{FormatReader, SeekMode, SeekTo},
        io::{MediaSource, MediaSourceStream},
        units::Timestamp,
    },
    default::formats::OggReader,
};
use symphonia_opus::OpusDecoder;

use super::{EngineOpenError, source::AudioInfo};

const SAMPLE_RATE: u32 = 48_000;
const MAX_PACKET_FRAMES: usize = 5_760;
const PREROLL_FRAMES: u32 = SAMPLE_RATE / 2;
const MAX_PAGE_FRAMES: i64 = 255 * MAX_PACKET_FRAMES as i64;
const MAX_READ_BYTES: usize = 16 * 1024 * 1024;

pub(super) struct OpusSource {
    reader: OggReader<'static>,
    decoder: OpusDecoder,
    budget: Arc<AtomicUsize>,
    info: AudioInfo,
    channels: usize,
    track_id: u32,
    raw_start: i64,
    playable_start: i64,
    raw_end: i64,
    samples: Vec<f32>,
    sample_offset: usize,
    next_frame: u32,
}

impl OpusSource {
    pub(super) fn open(file: File, file_length: u64) -> Result<Self, EngineOpenError> {
        let unsupported = EngineOpenError::UnsupportedAudio;
        let budget = Arc::new(AtomicUsize::new(MAX_READ_BYTES));
        let input = BoundedInput {
            file,
            file_length,
            offset: 0,
            budget: Arc::clone(&budget),
        };
        let stream = MediaSourceStream::new(Box::new(input), Default::default());
        let reader = OggReader::try_new(stream, Default::default()).map_err(|_| unsupported)?;
        let [track] = reader.tracks() else {
            return Err(unsupported);
        };
        let params = track
            .codec_params
            .as_ref()
            .and_then(|params| params.audio())
            .filter(|params| {
                params.codec == CODEC_ID_OPUS && params.sample_rate == Some(SAMPLE_RATE)
            })
            .ok_or(unsupported)?;
        let channels = params
            .channels
            .as_ref()
            .map(|channels| channels.count())
            .filter(|count| matches!(count, 1 | 2))
            .ok_or(unsupported)?;
        let decoder = OpusDecoder::try_new(params, &Default::default()).map_err(|_| unsupported)?;
        let raw_start = track.start_ts.get();
        // Symphonia 0.6.1 exposes the unshifted Ogg granule positions and leaves the OpusHead
        // pre-skip out of packet trim_start. The final granule already excludes encoder padding.
        let playable_start = raw_start
            .checked_add(i64::from(decoder.pre_skip()))
            .ok_or(unsupported)?;
        let raw_end = track
            .num_frames
            .and_then(|frames| i64::try_from(frames).ok())
            .ok_or(unsupported)?;
        let frames = raw_end
            .checked_sub(playable_start)
            .and_then(|frames| u32::try_from(frames).ok())
            .filter(|frames| *frames > 0)
            .ok_or(unsupported)?;
        let track_id = track.id;
        let mut source = Self {
            reader,
            decoder,
            budget,
            info: AudioInfo {
                frames,
                sample_rate: SAMPLE_RATE,
            },
            channels,
            track_id,
            raw_start,
            playable_start,
            raw_end,
            samples: Vec::with_capacity(MAX_PACKET_FRAMES * channels),
            sample_offset: 0,
            next_frame: 0,
        };
        source.read_packet(raw_start).map_err(|_| unsupported)?;
        Ok(source)
    }

    pub(super) fn info(&self) -> AudioInfo {
        self.info
    }

    pub(super) fn seek_to(&mut self, frame: u32) -> io::Result<()> {
        self.samples.clear();
        self.sample_offset = 0;
        self.next_frame = frame;
        if frame >= self.info.frames {
            return Ok(());
        }

        let preroll = if frame <= PREROLL_FRAMES {
            self.raw_start
        } else {
            self.playable_start + i64::from(frame - PREROLL_FRAMES)
        };
        // When a seek lands directly on the final Ogg page, Symphonia has no preceding granule
        // and can count tail padding as an offset to that page's timestamps. Start before the
        // longest possible final page, then skip packets until the decoder's preroll starts.
        let seek = preroll.min(
            self.raw_end
                .saturating_sub(MAX_PAGE_FRAMES + 1)
                .max(self.raw_start),
        );
        self.budget.store(MAX_READ_BYTES, Ordering::Relaxed);
        self.reader
            .seek(
                SeekMode::Accurate,
                SeekTo::Timestamp {
                    ts: Timestamp::new(seek),
                    track_id: self.track_id,
                },
            )
            .map_err(io::Error::other)?;
        self.decoder.reset();
        self.read_packet(preroll)
    }

    pub(super) fn read_frame(&mut self) -> io::Result<[f32; 2]> {
        if self.next_frame >= self.info.frames {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        if self.sample_offset == self.samples.len() {
            self.read_packet(i64::MIN)?;
        }
        let left = self.samples[self.sample_offset];
        let right = self.samples[self.sample_offset + self.channels - 1];
        self.sample_offset += self.channels;
        self.next_frame += 1;
        Ok([left, right].map(|sample| if sample.is_finite() { sample } else { 0.0 }))
    }

    fn read_packet(&mut self, preroll: i64) -> io::Result<()> {
        self.budget.store(MAX_READ_BYTES, Ordering::Relaxed);
        let target = self.playable_start + i64::from(self.next_frame);
        loop {
            let packet = self
                .reader
                .next_packet()
                .map_err(io::Error::other)?
                .ok_or(io::ErrorKind::UnexpectedEof)?;
            if packet.track_id != self.track_id {
                return Err(io::ErrorKind::InvalidData.into());
            }
            let packet_start = packet
                .pts
                .checked_add(packet.trim_start)
                .ok_or(io::ErrorKind::InvalidData)?;
            let packet_end = packet_start
                .checked_add(packet.dur)
                .ok_or(io::ErrorKind::InvalidData)?;
            if packet_end.get() <= preroll {
                continue;
            }
            let audio = self.decoder.decode(&packet).map_err(io::Error::other)?;
            let declared_frames =
                packet.dur.get() + packet.trim_start.get() + packet.trim_end.get();
            if audio.spec().rate() != SAMPLE_RATE
                || audio.spec().channels().count() != self.channels
                || audio.frames() > MAX_PACKET_FRAMES
                || audio.frames() as u64 != declared_frames
            {
                return Err(io::ErrorKind::InvalidData.into());
            }
            if packet_end.get() <= target {
                continue;
            }
            if packet_start.get() > target {
                return Err(io::ErrorKind::InvalidData.into());
            }
            self.samples.resize(audio.samples_interleaved(), 0.0);
            audio.copy_to_slice_interleaved(&mut self.samples);
            self.sample_offset = (target - packet.pts.get()) as usize * self.channels;
            let valid_end = (packet_end.get().min(self.raw_end) - packet.pts.get()) as usize;
            self.samples.truncate(valid_end * self.channels);
            return Ok(());
        }
    }
}

struct BoundedInput {
    file: File,
    file_length: u64,
    offset: u64,
    budget: Arc<AtomicUsize>,
}

impl Read for BoundedInput {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let remaining = self.file_length.saturating_sub(self.offset);
        let requested = output
            .len()
            .min(usize::try_from(remaining).unwrap_or(usize::MAX));
        if requested == 0 {
            return Ok(0);
        }
        // Bound header probing and resynchronization work on malformed files.
        let available = self.budget.load(Ordering::Relaxed);
        if available == 0 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let read = self.file.read(&mut output[..requested.min(available)])?;
        self.offset += read as u64;
        self.budget.fetch_sub(read, Ordering::Relaxed);
        Ok(read)
    }
}

impl Seek for BoundedInput {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let position = match position {
            SeekFrom::End(delta) => SeekFrom::Start(
                self.file_length
                    .checked_add_signed(delta)
                    .ok_or(io::ErrorKind::InvalidInput)?,
            ),
            position => position,
        };
        self.offset = self.file.seek(position)?;
        Ok(self.offset)
    }
}

impl MediaSource for BoundedInput {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.file_length)
    }
}
