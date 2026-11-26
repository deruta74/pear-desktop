mod container;

use std::{
    fs::File,
    io::{self, Seek},
};

use symphonia::core::{
    codecs::audio::{
        AudioDecoder,
        well_known::{CODEC_ID_AAC, profiles::CODEC_PROFILE_AAC_LC},
    },
    formats::{FormatReader, SeekMode, SeekTo, probe::Hint},
    io::MediaSourceStream,
    meta::{RawValue, Tag},
    units::{Duration, TimeBase, Timestamp},
};

use super::{EngineOpenError, source::AudioInfo};

const AAC_FRAMES: u32 = 1_024;
// Decode the preceding window and allow one more packet for its window transition.
const SEEK_PREROLL: u32 = 2 * AAC_FRAMES;

pub(super) struct M4aSource {
    reader: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    info: AudioInfo,
    track_id: u32,
    channels: usize,
    media_start: u32,
    next_frame: u32,
    samples: Vec<f32>,
    sample_offset: usize,
}

impl M4aSource {
    pub(super) fn open(mut file: File, length: u64) -> Result<Self, EngineOpenError> {
        let unsupported = EngineOpenError::UnsupportedAudio;
        let timing = container::inspect(&mut file, length).map_err(|_| unsupported)?;
        file.rewind().map_err(|_| unsupported)?;
        let input = MediaSourceStream::new(Box::new(file), Default::default());
        let mut reader = symphonia::default::get_probe()
            .probe(
                Hint::new().with_extension("m4a"),
                input,
                Default::default(),
                Default::default(),
            )
            .map_err(|_| unsupported)?;
        let [track] = reader.tracks() else {
            return Err(unsupported);
        };
        let params = track
            .codec_params
            .as_ref()
            .and_then(|params| params.audio())
            .filter(|params| {
                params.codec == CODEC_ID_AAC
                    && params.profile == Some(CODEC_PROFILE_AAC_LC)
                    && params.extra_data.is_some()
            })
            .ok_or(unsupported)?;
        let channels = params
            .channels
            .as_ref()
            .map(|channels| channels.count())
            .filter(|channels| matches!(channels, 1 | 2))
            .ok_or(unsupported)?;
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(params, &Default::default())
            .map_err(|_| unsupported)?;
        // The AAC configuration carries the output rate. The legacy 16.16
        // sample entry can hold half the actual rate for 88.2/96 kHz tracks.
        let sample_rate = decoder
            .codec_params()
            .sample_rate
            .filter(|&rate| rate > 0 && rate <= super::source::MAX_INPUT_RATE)
            .ok_or(unsupported)?;
        if track.time_base != TimeBase::try_from_recip(sample_rate)
            || track.duration != Some(Duration::new(u64::from(timing.media_frames)))
            || track.start_ts != Timestamp::ZERO
        {
            return Err(unsupported);
        }
        let track_id = track.id;
        let (media_start, frames) = if let Some(edit) = timing.edit {
            let movie_clock = reader.media_info().time_base.ok_or(unsupported)?;
            edit.bounds(movie_clock, sample_rate, timing.media_frames)
                .ok_or(unsupported)?
        } else {
            reader
                .metadata()
                .skip_to_latest()
                .and_then(|revision| itunes_bounds(&revision.media.tags, timing.media_frames))
                .unwrap_or((0, timing.media_frames))
        };

        let mut source = Self {
            reader,
            decoder,
            track_id,
            info: AudioInfo {
                frames,
                sample_rate,
            },
            channels,
            media_start,
            next_frame: 0,
            samples: Vec::new(),
            sample_offset: 0,
        };
        source.seek_to(0).map_err(|_| unsupported)?;
        source.read_packet().map_err(|_| unsupported)?;
        Ok(source)
    }

    pub(super) fn info(&self) -> AudioInfo {
        self.info
    }

    pub(super) fn seek_to(&mut self, frame: u32) -> io::Result<()> {
        if frame < self.info.frames {
            let preroll = (self.media_start + frame).saturating_sub(SEEK_PREROLL);
            self.reader
                .seek(
                    SeekMode::Accurate,
                    SeekTo::Timestamp {
                        ts: Timestamp::new(i64::from(preroll)),
                        track_id: self.track_id,
                    },
                )
                .map_err(io::Error::other)?;
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
        let target = u64::from(self.media_start + self.next_frame);
        loop {
            let packet = self
                .reader
                .next_packet()
                .map_err(io::Error::other)?
                .ok_or(io::ErrorKind::UnexpectedEof)?;
            let start = u64::try_from(packet.pts.get()).map_err(io::Error::other)?;
            let duration = packet.dur.get();
            let offset = target
                .checked_sub(start)
                .ok_or(io::ErrorKind::InvalidData)?;
            if packet.track_id != self.track_id
                || !(1..=u64::from(AAC_FRAMES)).contains(&duration)
                || packet.trim_start != Duration::ZERO
                || packet.trim_end != Duration::ZERO
            {
                return Err(io::ErrorKind::InvalidData.into());
            }
            let audio = self.decoder.decode(&packet).map_err(io::Error::other)?;
            if audio.spec().rate() != self.info.sample_rate
                || audio.spec().channels().count() != self.channels
                || audio.frames() != AAC_FRAMES as usize
            {
                return Err(io::ErrorKind::InvalidData.into());
            }
            if offset >= duration {
                continue;
            }
            self.samples.resize(audio.samples_interleaved(), 0.0);
            audio.copy_to_slice_interleaved(&mut self.samples);
            self.sample_offset = offset as usize * self.channels;
            return Ok(());
        }
    }
}

fn itunes_bounds(tags: &[Tag], media_frames: u32) -> Option<(u32, u32)> {
    let mut tags = tags
        .iter()
        .filter(|tag| tag.raw.key == "com.apple.iTunes:iTunSMPB");
    let RawValue::String(value) = &tags.next()?.raw.value else {
        return None;
    };
    if tags.next().is_some() || value.len() > 256 {
        return None;
    }
    let mut fields = value.split_ascii_whitespace();
    let flags = u32::from_str_radix(fields.next()?, 16).ok()?;
    let delay = u32::from_str_radix(fields.next()?, 16).ok()?;
    let padding = u32::from_str_radix(fields.next()?, 16).ok()?;
    let frames = u32::from_str_radix(fields.next()?, 16).ok()?;
    (flags == 0 && frames > 0 && delay.checked_add(frames)?.checked_add(padding)? == media_frames)
        .then_some((delay, frames))
}
