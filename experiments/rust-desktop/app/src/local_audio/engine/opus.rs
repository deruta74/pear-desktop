mod ogg;

use std::{fs::File, io};

use symphonia::core::{
    codecs::audio::{AudioCodecParameters, AudioDecoder, well_known::CODEC_ID_OPUS},
    packet::PacketRef,
    units::{Duration, Timestamp},
};
use symphonia_opus::OpusDecoder;

use super::{EngineOpenError, source::AudioInfo};
use ogg::OggOpus;

const SAMPLE_RATE: u32 = 48_000;
const MAX_PACKET_FRAMES: usize = 5_760;
const PREROLL_FRAMES: u32 = SAMPLE_RATE / 2;

pub(super) struct OpusSource {
    reader: OggOpus,
    decoder: OpusDecoder,
    info: AudioInfo,
    channels: usize,
    raw_start: u64,
    playable_start: u64,
    samples: Vec<f32>,
    sample_offset: usize,
    next_frame: u32,
}

impl OpusSource {
    pub(super) fn open(file: File, file_length: u64) -> Result<Self, EngineOpenError> {
        let unsupported = EngineOpenError::UnsupportedAudio;
        let (reader, head) = OggOpus::open(file, file_length).map_err(|_| unsupported)?;
        let mut params = AudioCodecParameters::new();
        params
            .for_codec(CODEC_ID_OPUS)
            .with_sample_rate(SAMPLE_RATE)
            .with_extra_data(head.into_boxed_slice());
        let decoder =
            OpusDecoder::try_new(&params, &Default::default()).map_err(|_| unsupported)?;
        let channels = decoder
            .codec_params()
            .channels
            .as_ref()
            .map(|channels| channels.count())
            .filter(|count| matches!(count, 1 | 2))
            .ok_or(unsupported)?;
        let raw_start = reader.start();
        let playable_start = raw_start + u64::from(decoder.pre_skip());
        let frames = reader
            .end()
            .checked_sub(playable_start)
            .and_then(|frames| u32::try_from(frames).ok())
            .filter(|frames| *frames > 0)
            .ok_or(unsupported)?;
        let mut source = Self {
            reader,
            decoder,
            info: AudioInfo {
                frames,
                sample_rate: SAMPLE_RATE,
            },
            channels,
            raw_start,
            playable_start,
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
            self.playable_start + u64::from(frame - PREROLL_FRAMES)
        };
        self.reader.seek(preroll)?;
        self.decoder.reset();
        self.read_packet(preroll)
    }

    pub(super) fn read_frame(&mut self) -> io::Result<[f32; 2]> {
        if self.next_frame >= self.info.frames {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        if self.sample_offset == self.samples.len() {
            self.read_packet(0)?;
        }
        let left = self.samples[self.sample_offset];
        let right = self.samples[self.sample_offset + self.channels - 1];
        self.sample_offset += self.channels;
        self.next_frame += 1;
        Ok([left, right].map(|sample| if sample.is_finite() { sample } else { 0.0 }))
    }

    fn read_packet(&mut self, preroll: u64) -> io::Result<()> {
        self.reader.reset_budget();
        let target = self.playable_start + u64::from(self.next_frame);
        let raw_end = self.reader.end();
        loop {
            let packet = self.reader.next_packet()?;
            let packet_end = packet.start + packet.frames as u64;
            if packet_end <= preroll {
                continue;
            }
            let encoded = PacketRef::new(
                0,
                Timestamp::ZERO,
                Duration::new(packet.frames as u64),
                &packet.data,
            );
            let audio = self
                .decoder
                .decode_ref(&encoded)
                .map_err(io::Error::other)?;
            if audio.spec().rate() != SAMPLE_RATE
                || audio.spec().channels().count() != self.channels
                || audio.frames() != packet.frames
                || packet.start > target
            {
                return Err(io::ErrorKind::InvalidData.into());
            }
            if packet_end <= target {
                continue;
            }
            self.samples.resize(audio.samples_interleaved(), 0.0);
            audio.copy_to_slice_interleaved(&mut self.samples);
            self.sample_offset = (target - packet.start) as usize * self.channels;
            self.samples
                .truncate((packet_end.min(raw_end) - packet.start) as usize * self.channels);
            return Ok(());
        }
    }
}
