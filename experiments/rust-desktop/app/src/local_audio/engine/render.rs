use std::sync::{
    Arc,
    atomic::{AtomicU32, Ordering},
};

use cpal::{FromSample, SizedSample};
use pear_preview_dsp::{ReverbSettings, StereoReverb};
use rtrb::Consumer;

use super::eq::Tone;
use super::{QUEUE_FRAMES, QueuedFrame, Shared, WavInfo, unpack};

const REVERB_TAIL_SECONDS: u32 = 3;

pub(super) struct Render {
    shared: Arc<Shared>,
    frames: SourceFrames,
    cursor: Cursor,
    input: WavInfo,
    rate_ratio: f64,
    effects: StereoReverb,
    tone: Tone,
    effects_version: u32,
    wet_enabled: bool,
    tail_limit: u32,
    tail_remaining: u32,
}

impl Render {
    pub(super) fn new(
        queue: Consumer<QueuedFrame>,
        shared: Arc<Shared>,
        input: WavInfo,
        output_rate: u32,
        tone: Tone,
    ) -> Self {
        Self {
            shared,
            frames: SourceFrames {
                queue,
                head: None,
                generation: 0,
                stale_budget: QUEUE_FRAMES,
            },
            cursor: Cursor::new(0),
            input,
            rate_ratio: f64::from(input.sample_rate) / f64::from(output_rate),
            effects: StereoReverb::new(output_rate),
            tone,
            effects_version: 0,
            wet_enabled: false,
            tail_limit: output_rate * REVERB_TAIL_SECONDS,
            tail_remaining: 0,
        }
    }

    pub(super) fn fill<T: SizedSample + FromSample<f32>>(
        &mut self,
        output: &mut [T],
        channels: usize,
    ) {
        output.fill(T::EQUILIBRIUM);
        if self.shared.stopping.load(Ordering::Acquire)
            || self.shared.error.load(Ordering::Acquire) != 0
        {
            return;
        }

        let (generation, seek_frame) = unpack(self.shared.request.load(Ordering::Acquire));
        if generation != self.frames.generation {
            self.cursor = Cursor::new(seek_frame);
            self.effects.reset();
            self.tone.reset();
            self.tail_remaining = 0;
        }
        self.frames.begin_callback(generation);
        let playing = self.shared.playing.load(Ordering::Acquire);
        let volume = f32::from_bits(self.shared.volume.load(Ordering::Relaxed));
        let active = playing && (!self.cursor.at_end(self.input.frames) || self.tail_remaining > 0);
        self.tone.update(volume, active);
        if !playing {
            if self.cursor.at_end(self.input.frames) {
                self.tail_remaining = 0;
            }
            return;
        }
        if self.cursor.at_end(self.input.frames) && self.tail_remaining == 0 {
            return;
        }

        if let Some((version, settings)) = self.shared.reverb.updated_since(self.effects_version) {
            self.effects.set_settings(settings);
            self.effects_version = version;
            self.wet_enabled = settings.intensity.is_finite() && settings.intensity > 0.0;
        }
        let speed = f32::from_bits(self.shared.speed.load(Ordering::Relaxed));
        let step = self.rate_ratio * f64::from(speed);
        let effects_have_tail = self.wet_enabled || self.tone.has_tail();

        for target in output.chunks_exact_mut(channels) {
            let dry = match self.cursor.sample(&mut self.frames, self.input.frames) {
                Some(dry) => {
                    self.cursor.advance(step, self.input.frames);
                    self.tail_remaining = if effects_have_tail {
                        self.tail_limit
                    } else {
                        self.tail_remaining.saturating_sub(1)
                    };
                    dry
                }
                None if self.cursor.at_end(self.input.frames) && self.tail_remaining > 0 => {
                    // Drain effects only at natural media end. An underrun holds the cursor and DSP.
                    self.tail_remaining -= 1;
                    [0.0; 2]
                }
                None => break,
            };
            let mixed = self.effects.process_frame(dry);
            let [left, right] = self
                .tone
                .process(mixed)
                .map(|sample| (sample * volume).clamp(-1.0, 1.0));
            if channels == 1 {
                target[0] = T::from_sample((left + right) * 0.5);
            } else {
                target[0] = T::from_sample(left);
                target[1] = T::from_sample(right);
            }
        }
        self.shared.publish_frame(
            generation,
            self.cursor.position as u32,
            self.cursor.at_end(self.input.frames) && self.tail_remaining > 0,
        );
    }
}

struct SourceFrames {
    queue: Consumer<QueuedFrame>,
    head: Option<QueuedFrame>,
    generation: u32,
    stale_budget: usize,
}

impl SourceFrames {
    fn begin_callback(&mut self, generation: u32) {
        self.generation = generation;
        self.stale_budget = QUEUE_FRAMES;
        // While paused, removing old frames lets the worker refill after a seek.
        self.front();
    }

    fn front(&mut self) -> Option<&QueuedFrame> {
        while self.stale_budget > 0 {
            if self.head.is_none() {
                self.head = self.queue.pop().ok();
            }
            let generation = self.head.as_ref()?.generation;
            if generation.wrapping_sub(self.generation) <= i32::MAX as u32 {
                return self.head.as_ref();
            }
            self.head = None;
            self.stale_budget -= 1;
        }
        None
    }

    fn next(&mut self) -> Option<[f32; 2]> {
        // The worker can seek during this buffer. Leave future frames for the next callback.
        if self.front()?.generation != self.generation {
            return None;
        }
        self.head.take().map(|frame| frame.pcm)
    }
}

struct Cursor {
    index: u32,
    position: f64,
    current: Option<[f32; 2]>,
    next: Option<[f32; 2]>,
}

impl Cursor {
    fn new(frame: u32) -> Self {
        Self {
            index: frame,
            position: f64::from(frame),
            current: None,
            next: None,
        }
    }

    fn sample(&mut self, frames: &mut SourceFrames, total: u32) -> Option<[f32; 2]> {
        let target = self.position as u32;
        if target >= total {
            return None;
        }

        if self.current.is_none() {
            self.current = Some(frames.next()?);
        }
        while self.index < target {
            self.current = Some(match self.next.take() {
                Some(sample) => sample,
                None => frames.next()?,
            });
            self.index += 1;
        }
        let current = self.current?;
        let fraction = (self.position - f64::from(target)) as f32;
        if fraction == 0.0 || target + 1 == total {
            return Some(current);
        }
        let next = match self.next {
            Some(sample) => sample,
            None => {
                let sample = frames.next()?;
                self.next = Some(sample);
                sample
            }
        };
        Some([
            current[0] + (next[0] - current[0]) * fraction,
            current[1] + (next[1] - current[1]) * fraction,
        ])
    }

    fn at_end(&self, total: u32) -> bool {
        self.position >= f64::from(total)
    }

    fn advance(&mut self, step: f64, total: u32) {
        self.position = (self.position + step).min(f64::from(total));
    }
}

pub(super) struct ReverbControls {
    version: AtomicU32,
    intensity: AtomicU32,
    high_pass: AtomicU32,
    low_pass: AtomicU32,
}

impl ReverbControls {
    pub(super) fn new() -> Self {
        let defaults = ReverbSettings::default();
        Self {
            version: AtomicU32::new(0),
            intensity: AtomicU32::new(defaults.intensity.to_bits()),
            high_pass: AtomicU32::new(defaults.high_pass_hz.to_bits()),
            low_pass: AtomicU32::new(defaults.low_pass_hz.to_bits()),
        }
    }

    pub(super) fn set(&self, settings: ReverbSettings) {
        // A single control-thread writer brackets the complete settings.
        self.version.fetch_add(1, Ordering::SeqCst);
        self.intensity
            .store(settings.intensity.to_bits(), Ordering::SeqCst);
        self.high_pass
            .store(settings.high_pass_hz.to_bits(), Ordering::SeqCst);
        self.low_pass
            .store(settings.low_pass_hz.to_bits(), Ordering::SeqCst);
        self.version.fetch_add(1, Ordering::SeqCst);
    }

    fn updated_since(&self, previous: u32) -> Option<(u32, ReverbSettings)> {
        let version = self.version.load(Ordering::SeqCst);
        if version == previous || !version.is_multiple_of(2) {
            return None;
        }
        let settings = ReverbSettings {
            intensity: f32::from_bits(self.intensity.load(Ordering::SeqCst)),
            high_pass_hz: f32::from_bits(self.high_pass.load(Ordering::SeqCst)),
            low_pass_hz: f32::from_bits(self.low_pass.load(Ordering::SeqCst)),
        };
        (self.version.load(Ordering::SeqCst) == version).then_some((version, settings))
    }
}
