use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
};

use symphonia::{
    core::{
        codecs::audio::{AudioDecoder, well_known::CODEC_ID_MP3},
        formats::{FormatReader, SeekMode, SeekTo, TrackType},
        io::{MediaSource, MediaSourceStream},
        units::Timestamp,
    },
    default::formats::MpaReader,
};

use super::{EngineOpenError, source::AudioInfo};
use crate::local_audio::metadata::{Metadata, synchsafe};

const MAX_ID3_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PACKET_FRAMES: usize = 1_152;
// Allow enough packets to refill the bit reservoir and warm the synthesis filter.
const MPEG1_PREROLL: u32 = 16 * MAX_PACKET_FRAMES as u32;
// At 8 kbps, a 24 kHz stereo MPEG-2 packet with CRC can carry one main-data
// byte. Its reservoir can reference 255 bytes.
const MPEG2_PREROLL: u32 = (255 + 8) * 576;

pub(super) struct Mp3Source {
    reader: MpaReader<'static>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    encoder_delay: u32,
    info: AudioInfo,
    channels: usize,
    samples: Vec<f32>,
    sample_offset: usize,
    next_frame: u32,
}

impl Mp3Source {
    pub(super) fn recognizes(header: &[u8; 4]) -> bool {
        &header[..3] == b"ID3" || is_mp3_frame([header[0], header[1]])
    }

    pub(super) fn open(
        mut file: File,
        file_length: u64,
    ) -> Result<(Self, Metadata), EngineOpenError> {
        let unsupported = EngineOpenError::UnsupportedAudio;
        let (origin, mut metadata) =
            read_header(&mut file, file_length).map_err(|_| unsupported)?;
        let _ = metadata.fill_id3v1(&mut file, origin, file_length);
        let mut input = MediaSourceStream::new(Box::new(UnknownLength(file)), Default::default());
        input
            .seek(SeekFrom::Start(origin))
            .map_err(|_| unsupported)?;
        let mut reader = MpaReader::try_new(input, Default::default()).map_err(|_| unsupported)?;
        let track = reader.default_track(TrackType::Audio).ok_or(unsupported)?;
        let params = track
            .codec_params
            .as_ref()
            .and_then(|params| params.audio())
            .filter(|params| params.codec == CODEC_ID_MP3)
            .ok_or(unsupported)?;
        let channels = params
            .channels
            .as_ref()
            .map(|channels| channels.count())
            .filter(|count| matches!(count, 1 | 2))
            .ok_or(unsupported)?;
        let sample_rate = params.sample_rate.ok_or(unsupported)?;
        let track_id = track.id;
        let encoder_delay = track.delay.unwrap_or(0);
        let encoder_padding = track.padding.unwrap_or(0);
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(params, &Default::default())
            .map_err(|_| unsupported)?;
        let frames = match track.num_frames {
            Some(count) => u32::try_from(count).map_err(|_| unsupported)?,
            None => {
                let count = count_frames(&mut reader).map_err(|_| unsupported)?;
                seek_reader(&mut reader, track_id, -i64::from(encoder_delay))
                    .map_err(|_| unsupported)?;
                count.saturating_sub(encoder_padding)
            }
        };
        if frames == 0 {
            return Err(unsupported);
        }

        let mut source = Self {
            reader,
            decoder,
            track_id,
            encoder_delay,
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
        if frame < self.info.frames {
            let warmup = if self.info.sample_rate <= 24_000 {
                MPEG2_PREROLL
            } else {
                MPEG1_PREROLL
            };
            let preroll = frame
                .checked_sub(warmup)
                .map_or(-i64::from(self.encoder_delay), i64::from);
            seek_reader(&mut self.reader, self.track_id, preroll)?;
        }
        self.decoder.reset();
        self.samples.clear();
        self.sample_offset = 0;
        self.next_frame = frame;
        Ok(())
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
        Ok([left, right].map(|sample| if sample.is_finite() { sample } else { 0.0 }))
    }

    fn read_packet(&mut self) -> io::Result<()> {
        loop {
            let packet = self
                .reader
                .next_packet()
                .map_err(io::Error::other)?
                .ok_or(io::ErrorKind::UnexpectedEof)?;
            let audio = self.decoder.decode(&packet).map_err(io::Error::other)?;
            if packet.track_id != self.track_id
                || audio.spec().rate() != self.info.sample_rate
                || audio.spec().channels().count() != self.channels
                || audio.frames() > MAX_PACKET_FRAMES
            {
                return Err(io::ErrorKind::InvalidData.into());
            }
            let start = packet.pts.saturating_add(packet.trim_start).get();
            let offset = i64::from(self.next_frame)
                .checked_sub(start)
                .and_then(|offset| usize::try_from(offset).ok())
                .ok_or(io::ErrorKind::InvalidData)?;
            if offset >= audio.frames() {
                continue;
            }
            self.samples.resize(audio.samples_interleaved(), 0.0);
            audio.copy_to_slice_interleaved(&mut self.samples);
            self.sample_offset = offset * self.channels;
            return Ok(());
        }
    }
}

fn seek_reader(reader: &mut MpaReader<'_>, track_id: u32, frame: i64) -> io::Result<()> {
    reader
        .seek(
            SeekMode::Accurate,
            SeekTo::Timestamp {
                ts: Timestamp::new(frame),
                track_id,
            },
        )
        .map_err(io::Error::other)?;
    Ok(())
}

fn count_frames(reader: &mut MpaReader<'_>) -> io::Result<u32> {
    let mut frames = 0;
    while let Some(packet) = reader.next_packet().map_err(io::Error::other)? {
        // No duration tag means no end trim. PTS already accounts for any leading delay.
        let end = packet.pts.saturating_add(packet.dur).get().max(0);
        frames = u32::try_from(end).map_err(|_| io::ErrorKind::InvalidData)?;
    }
    Ok(frames)
}

fn is_mp3_frame([first, second]: [u8; 2]) -> bool {
    first == 0xff && second & 0xe6 == 0xe2 && second & 0x18 != 0x08
}

fn read_header(file: &mut File, file_length: u64) -> io::Result<(u64, Metadata)> {
    let mut signature = [0; 3];
    file.read_exact(&mut signature)?;
    if &signature != b"ID3" {
        return Ok((0, Metadata::default()));
    }
    let mut header = [0; 7];
    file.read_exact(&mut header)?;
    let [version, _, flags, a, b, c, d] = header;
    if !matches!(version, 2..=4) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let size = synchsafe([a, b, c, d])?;
    let footer = u64::from(version == 4 && flags & 0x10 != 0) * 10;
    let offset = 10 + size + footer;
    if offset > MAX_ID3_BYTES || offset >= file_length {
        return Err(io::ErrorKind::InvalidData.into());
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut header = [0; 2];
    file.read_exact(&mut header)?;
    if !is_mp3_frame(header) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    file.seek(SeekFrom::Start(10))?;
    let metadata = Metadata::read_id3(file, version, flags, size).unwrap_or_default();
    Ok((offset, metadata))
}

// Disable the demuxer's bitrate-based duration estimate while retaining exact seeks.
struct UnknownLength(File);

impl Read for UnknownLength {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        self.0.read(output)
    }
}

impl Seek for UnknownLength {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.0.seek(position)
    }
}

impl MediaSource for UnknownLength {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        None
    }
}
