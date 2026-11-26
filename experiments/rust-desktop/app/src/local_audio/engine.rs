mod eq;
mod flac;
mod mp3;
mod opus;
mod render;
mod source;
mod wav;

#[cfg(test)]
mod tests;

use std::{
    fmt,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use cpal::{
    FromSample, SampleFormat, SizedSample, Stream, StreamConfig,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use pear_preview_dsp::ReverbSettings;
use pear_preview_dsp::equalizer::{EqualizerError, EqualizerSettings, StereoEqualizer};
use rtrb::{Producer, RingBuffer};
use serde::Serialize;

use self::{
    render::{Render, ReverbControls},
    source::{AudioInfo, AudioSource},
};

const QUEUE_FRAMES: usize = 16_384;
const DECODE_BATCH: usize = 256;
const DECODE_ERROR: u8 = 1;
const OUTPUT_ERROR: u8 = 2;

#[derive(Clone, Copy, Debug)]
pub(super) enum EngineOpenError {
    UnavailableAudio,
    UnsupportedAudio,
    AudioOutputUnavailable,
}

impl fmt::Display for EngineOpenError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::UnavailableAudio => "Could not open the selected audio file.",
            Self::UnsupportedAudio => {
                "Choose a non-empty mono or stereo WAV, FLAC, MP3, or Ogg Opus file."
            }
            Self::AudioOutputUnavailable => "Could not start the default audio output.",
        })
    }
}

impl std::error::Error for EngineOpenError {}

pub(super) struct PreparedAudio(AudioSource);

impl PreparedAudio {
    pub(super) fn read(path: &Path) -> Result<Self, EngineOpenError> {
        AudioSource::open(path).map(Self)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot {
    pub(super) position_ms: u64,
    #[serde(skip)]
    pub(super) position_revision: u32,
    pub(super) duration_ms: u64,
    pub(super) playing: bool,
    pub(super) error: Option<String>,
    #[serde(skip)]
    pub(super) finished: bool,
}

pub(super) struct Engine {
    stream: Stream,
    shared: Arc<Shared>,
    worker: JoinHandle<()>,
    input: AudioInfo,
    output_rate: u32,
    equalizer: Box<eq::Updates>,
}

impl Engine {
    #[cfg(test)]
    pub(super) fn open(path: &Path) -> Result<Self, EngineOpenError> {
        Self::open_prepared(PreparedAudio::read(path)?)
    }

    pub(super) fn open_prepared(
        PreparedAudio(audio): PreparedAudio,
    ) -> Result<Self, EngineOpenError> {
        let input = audio.info();
        let unavailable = |_| EngineOpenError::AudioOutputUnavailable;
        let device = cpal::default_host()
            .default_output_device()
            .ok_or(EngineOpenError::AudioOutputUnavailable)?;
        let supported = device.default_output_config().map_err(unavailable)?;
        let config = supported.config();
        if config.channels == 0 || !(8_000..=384_000).contains(&config.sample_rate) {
            return Err(EngineOpenError::AudioOutputUnavailable);
        }

        let shared = Arc::new(Shared::new());
        let (producer, consumer) = RingBuffer::new(QUEUE_FRAMES);
        let (equalizer, tone) = eq::Updates::new(config.sample_rate);
        let render = Render::new(
            consumer,
            Arc::clone(&shared),
            input,
            config.sample_rate,
            tone,
        );
        let stream = match supported.sample_format() {
            SampleFormat::F32 => output_stream::<f32>(&device, &config, render, &shared),
            SampleFormat::F64 => output_stream::<f64>(&device, &config, render, &shared),
            SampleFormat::I8 => output_stream::<i8>(&device, &config, render, &shared),
            SampleFormat::I16 => output_stream::<i16>(&device, &config, render, &shared),
            SampleFormat::I24 => output_stream::<cpal::I24>(&device, &config, render, &shared),
            SampleFormat::I32 => output_stream::<i32>(&device, &config, render, &shared),
            SampleFormat::I64 => output_stream::<i64>(&device, &config, render, &shared),
            SampleFormat::U8 => output_stream::<u8>(&device, &config, render, &shared),
            SampleFormat::U16 => output_stream::<u16>(&device, &config, render, &shared),
            SampleFormat::U24 => output_stream::<cpal::U24>(&device, &config, render, &shared),
            SampleFormat::U32 => output_stream::<u32>(&device, &config, render, &shared),
            SampleFormat::U64 => output_stream::<u64>(&device, &config, render, &shared),
            _ => return Err(EngineOpenError::AudioOutputUnavailable),
        }
        .map_err(|_| EngineOpenError::AudioOutputUnavailable)?;

        let state = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("pear-audio-decoder".into())
            .spawn(move || decode_stream(audio, producer, &state))
            .map_err(|_| EngineOpenError::AudioOutputUnavailable)?;
        let engine = Self {
            stream,
            shared,
            worker,
            input,
            output_rate: config.sample_rate,
            equalizer: Box::new(equalizer),
        };
        engine
            .stream
            .play()
            .map_err(|_| EngineOpenError::AudioOutputUnavailable)?;
        Ok(engine)
    }

    pub(super) fn snapshot(&mut self, opening: bool) -> Snapshot {
        self.equalizer.flush();
        let (frame, active) = self.shared.status(self.input.frames);
        let duration_ms = self.duration_ms();
        let failure = self.shared.error.load(Ordering::Acquire);
        let error = match failure {
            DECODE_ERROR => Some("Could not read the audio samples."),
            OUTPUT_ERROR => Some("The audio output stopped."),
            _ => None,
        };
        Snapshot {
            position_ms: if frame >= self.input.frames {
                duration_ms
            } else {
                u64::from(frame) * 1000 / u64::from(self.input.sample_rate)
            },
            position_revision: unpack(self.shared.request.load(Ordering::Relaxed)).0,
            duration_ms,
            playing: error.is_none() && active,
            finished: self
                .shared
                .take_end(failure, !active && frame >= self.input.frames, opening),
            error: error.map(String::from),
        }
    }

    pub(super) fn is_playing(&self) -> bool {
        self.shared.error.load(Ordering::Acquire) == 0 && self.shared.status(self.input.frames).1
    }

    pub(super) fn set_playing(&mut self, playing: bool) {
        if playing && self.shared.frame() >= self.input.frames && !self.is_playing() {
            self.seek_to(0);
        }
        self.shared.playing.store(playing, Ordering::Release);
        self.worker.thread().unpark();
    }

    pub(super) fn seek_ms(&mut self, position_ms: u64) {
        let frame = if position_ms >= self.duration_ms() {
            self.input.frames
        } else {
            (position_ms * u64::from(self.input.sample_rate) / 1000) as u32
        };
        if frame >= self.input.frames
            || (self.shared.frame() >= self.input.frames && !self.is_playing())
        {
            self.shared.playing.store(false, Ordering::Release);
        }
        self.seek_to(frame);
    }

    pub(super) fn set_volume(&mut self, volume: f64) {
        if volume.is_finite() {
            let volume = volume.clamp(0.0, 1.0) as f32;
            self.shared
                .volume
                .store(volume.to_bits(), Ordering::Relaxed);
        }
    }

    pub(super) fn set_speed(&mut self, speed: f64) {
        if speed.is_finite() {
            let speed = speed.clamp(0.25, 4.0) as f32;
            self.shared.speed.store(speed.to_bits(), Ordering::Relaxed);
        }
    }

    pub(super) fn set_reverb(&mut self, settings: ReverbSettings) {
        self.shared.reverb.set(settings);
    }

    pub(super) fn set_equalizer(
        &mut self,
        settings: EqualizerSettings<'_>,
    ) -> Result<(), EqualizerError> {
        let prepared = if settings.bypass {
            None
        } else {
            let volume = f32::from_bits(self.shared.volume.load(Ordering::Relaxed));
            Some(StereoEqualizer::new(
                self.output_rate,
                settings,
                f64::from(volume),
            )?)
        };
        self.equalizer.replace(prepared);
        Ok(())
    }

    fn duration_ms(&self) -> u64 {
        (u64::from(self.input.frames) * 1000).div_ceil(u64::from(self.input.sample_rate))
    }

    fn seek_to(&self, frame: u32) {
        self.shared.seek_to(frame);
        self.worker.thread().unpark();
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.shared.stopping.store(true, Ordering::Release);
        self.worker.thread().unpark();
    }
}

fn output_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    mut render: Render,
    shared: &Arc<Shared>,
) -> Result<Stream, cpal::BuildStreamError>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = usize::from(config.channels);
    let state = Arc::clone(shared);
    device.build_output_stream(
        config,
        move |data: &mut [T], _| render.fill(data, channels),
        move |error| state.report_stream_error(error),
        Some(Duration::from_secs(2)),
    )
}

struct Shared {
    request: AtomicU64,
    clock: AtomicU64,
    tail: AtomicU64,
    playing: AtomicBool,
    stopping: AtomicBool,
    error: AtomicU8,
    volume: AtomicU32,
    speed: AtomicU32,
    reverb: ReverbControls,
}

impl Shared {
    fn new() -> Self {
        Self {
            request: AtomicU64::new(0),
            clock: AtomicU64::new(0),
            tail: AtomicU64::new(0),
            playing: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            error: AtomicU8::new(0),
            volume: AtomicU32::new(1.0f32.to_bits()),
            speed: AtomicU32::new(1.0f32.to_bits()),
            reverb: ReverbControls::new(),
        }
    }

    fn seek_to(&self, frame: u32) -> u32 {
        let generation = unpack(self.request.load(Ordering::Relaxed))
            .0
            .wrapping_add(1);
        let request = stamp(generation, frame);

        // Give the clock the new generation before exposing the seek to the renderer.
        // An in-flight output buffer can no longer overwrite the requested position.
        self.clock.store(request, Ordering::Release);
        self.request.store(request, Ordering::Release);
        generation
    }

    fn report_stream_error(&self, error: cpal::StreamError) {
        // CPAL can recover an underrun and resume callbacks on the same stream.
        if !matches!(error, cpal::StreamError::BufferUnderrun) {
            self.error.store(OUTPUT_ERROR, Ordering::Release);
        }
    }

    fn frame(&self) -> u32 {
        unpack(self.clock.load(Ordering::Acquire)).1
    }

    fn status(&self, total: u32) -> (u32, bool) {
        let (generation, frame) = unpack(self.clock.load(Ordering::Acquire));
        let active = self.playing.load(Ordering::Acquire)
            && (frame < total || self.tail.load(Ordering::Acquire) == stamp(generation, 1));
        (frame, active)
    }

    fn take_end(&self, failure: u8, natural_end: bool, opening: bool) -> bool {
        // Retain the playing flag if a pending change could still fail.
        !opening
            && (failure == DECODE_ERROR || (failure == 0 && natural_end))
            && self.playing.swap(false, Ordering::AcqRel)
    }

    fn publish_frame(&self, generation: u32, frame: u32, tail: bool) {
        let clock = self.clock.load(Ordering::Acquire);
        if unpack(clock).0 == generation {
            self.tail
                .store(stamp(generation, u32::from(tail)), Ordering::Release);
            let _ = self.clock.compare_exchange(
                clock,
                stamp(generation, frame),
                Ordering::Release,
                Ordering::Relaxed,
            );
        }
    }
}

fn stamp(generation: u32, frame: u32) -> u64 {
    (u64::from(generation) << 32) | u64::from(frame)
}

fn unpack(value: u64) -> (u32, u32) {
    ((value >> 32) as u32, value as u32)
}

struct QueuedFrame {
    generation: u32,
    pcm: [f32; 2],
}

fn decode_stream(mut audio: AudioSource, mut queue: Producer<QueuedFrame>, shared: &Shared) {
    let total = audio.info().frames;
    let mut generation = 0;
    let mut index = 0;
    while !shared.stopping.load(Ordering::Acquire) && shared.error.load(Ordering::Acquire) == 0 {
        let (requested_generation, requested_frame) =
            unpack(shared.request.load(Ordering::Acquire));
        if requested_generation != generation {
            if audio.seek_to(requested_frame).is_err() {
                shared.error.store(DECODE_ERROR, Ordering::Release);
                return;
            }
            generation = requested_generation;
            index = requested_frame;
        }

        if index == total {
            thread::park();
            continue;
        }
        let count = queue
            .slots()
            .min((total - index) as usize)
            .min(DECODE_BATCH);
        if count == 0 {
            // Playback needs new frames when the callback makes space. While
            // paused, Play or a seek wakes the decoder explicitly.
            if shared.playing.load(Ordering::Acquire) {
                thread::park_timeout(Duration::from_millis(2));
            } else {
                thread::park();
            }
            continue;
        }

        for _ in 0..count {
            let Ok(pcm) = audio.read_frame() else {
                shared.error.store(DECODE_ERROR, Ordering::Release);
                return;
            };
            if queue.push(QueuedFrame { generation, pcm }).is_err() {
                // Only this producer can fill the reserved slots.
                shared.error.store(DECODE_ERROR, Ordering::Release);
                return;
            }
            index += 1;
        }
    }
}
