//! Pear Desktop's native Dattorro tank and stereo reverb mixer.
#![forbid(unsafe_code)]

pub mod equalizer;

mod stereo_reverb;
pub use stereo_reverb::{ReverbSettings, StereoReverb};

// Port of Pear's DATTORRO_WORKLET_SOURCE, adapted from pear-devs/pear-desktop
// PR #4700, commit 52763433a853f67766c7a6e8947f074e1f2d0288, by nathwn12
// <137482711+nathwn12@users.noreply.github.com>, under that repository's MIT license.
// DSP reference: https://github.com/nathwn12/slowed-reverb-audio/blob/main/dattorro-worklet.js

#[derive(Clone, Copy, Debug)]
struct Diffusion {
    pre_filter: f64,
    input_diffusion: [f64; 2],
    decay_diffusion: f64,
}

/// Parameter update produced by Pear Desktop's intensity curve.
#[derive(Clone, Copy, Debug)]
pub struct DattorroParams {
    /// Tank output multiplier. The renderer supplies unity for an engaged
    /// tank and applies continuous level changes after wet tone filtering.
    pub wet_gain: f64,
    predelay: f64,
    decay: f64,
    damping: f64,
    diffusion: Option<Diffusion>,
}

impl DattorroParams {
    /// Map a numeric intensity to the parameters sent by the renderer.
    pub fn from_intensity(intensity: f64) -> Self {
        let intensity = if intensity.is_finite() {
            intensity.clamp(0.0, 1.0)
        } else {
            0.0
        };
        if intensity == 0.0 {
            return Self {
                wet_gain: 0.0,
                predelay: 0.0,
                decay: 0.0,
                damping: 1.0,
                diffusion: None,
            };
        }
        let gentle = intensity.powf(0.75);
        let upper = intensity.powf(3.0);
        Self {
            predelay: 0.44 + intensity * 0.1,
            diffusion: Some(Diffusion {
                pre_filter: 0.7 + intensity * 0.1,
                input_diffusion: [0.75, 0.625],
                decay_diffusion: 0.65 + intensity * 0.05,
            }),
            decay: gentle * 0.58 + upper * 0.2,
            damping: (0.5 + intensity.powf(0.6) * 0.4).min(0.78),
            wet_gain: gentle * 0.42 + upper * 0.78,
        }
    }
}

struct DelayLine {
    samples: Vec<f32>,
    delay: usize,
    mask: usize,
}

impl DelayLine {
    fn new(delay: usize) -> Self {
        let size = delay.next_power_of_two();
        Self {
            samples: vec![0.0; size],
            delay,
            mask: size - 1,
        }
    }

    fn write(&mut self, frame: usize, sample: f64) {
        self.samples[frame & self.mask] = sample as f32;
    }

    fn read(&self, frame: usize) -> f64 {
        self.tap(frame, self.delay)
    }

    fn tap(&self, frame: usize, frames_ago: usize) -> f64 {
        f64::from(self.samples[frame.wrapping_sub(frames_ago) & self.mask])
    }

    fn allpass(&mut self, frame: usize, read_frame: usize, gain: f64, input: f64) -> f64 {
        let delayed = self.read(read_frame);
        let stored = input - gain * delayed;
        self.write(frame, stored);
        // The worklet rounds the delay write, while the current sum uses f64.
        delayed + gain * stored
    }
}

struct TankLeg {
    modulated: DelayLine,
    pre_damp: DelayLine,
    diffuser: DelayLine,
    post_damp: DelayLine,
    damping_state: f64,
}

impl TankLeg {
    fn new(delays: [usize; 4]) -> Self {
        let [modulated, pre_damp, diffuser, post_damp] = delays.map(DelayLine::new);
        Self {
            modulated,
            pre_damp,
            diffuser,
            post_damp,
            damping_state: 0.0,
        }
    }

    fn reset(&mut self) {
        self.modulated.samples.fill(0.0);
        self.pre_damp.samples.fill(0.0);
        self.diffuser.samples.fill(0.0);
        self.post_damp.samples.fill(0.0);
        self.damping_state = 0.0;
    }
}

/// Stateful Dattorro tank. Construction allocates the buffers. Processing and
/// reset reuse the same storage.
pub struct Dattorro {
    sample_rate: f64,
    frame: usize,
    pre_delay: Vec<f32>,
    pre_index: usize,
    pre_filter_state: f64,
    input_diffusers: [DelayLine; 4],
    legs: [TankLeg; 2],
    mod_phase: isize,
    mod_direction: isize,
    predelay: f64,
    wet_gain: f64,
    decay: f64,
    damping: f64,
    decay_diffusion_2: f64,
    diffusion: Diffusion,
}

impl Dattorro {
    /// Create a silent tank at a nonzero sample rate in Hz.
    pub fn new(sample_rate: u32) -> Self {
        assert!(sample_rate > 0, "sample rate must be positive");
        let sample_rate = f64::from(sample_rate);
        Self {
            sample_rate,
            frame: 0,
            pre_delay: vec![0.0; (sample_rate * 0.1).ceil() as usize],
            pre_index: 0,
            pre_filter_state: 0.0,
            input_diffusers: [142, 107, 379, 277].map(DelayLine::new),
            legs: [
                TankLeg::new([672, 4453, 1800, 3720]),
                TankLeg::new([908, 4217, 2656, 3163]),
            ],
            mod_phase: 0,
            mod_direction: 1,
            predelay: 0.1,
            wet_gain: 0.0,
            decay: 0.75,
            damping: 0.95,
            decay_diffusion_2: 0.50,
            diffusion: Diffusion {
                pre_filter: 0.85,
                input_diffusion: [0.75, 0.625],
                decay_diffusion: 0.70,
            },
        }
    }

    /// Clear the tank and restore its initial parameters.
    pub fn reset(&mut self) {
        self.frame = 0;
        self.pre_delay.fill(0.0);
        self.pre_index = 0;
        self.pre_filter_state = 0.0;
        for diffuser in &mut self.input_diffusers {
            diffuser.samples.fill(0.0);
        }
        for leg in &mut self.legs {
            leg.reset();
        }
        self.mod_phase = 0;
        self.mod_direction = 1;
        self.predelay = 0.1;
        self.wet_gain = 0.0;
        self.decay = 0.75;
        self.damping = 0.95;
        self.decay_diffusion_2 = 0.50;
        self.diffusion = Diffusion {
            pre_filter: 0.85,
            input_diffusion: [0.75, 0.625],
            decay_diffusion: 0.70,
        };
    }

    /// Apply parameters without clearing the tank or advancing its clock.
    pub fn set_params(&mut self, params: DattorroParams) {
        self.predelay = params.predelay;
        self.wet_gain = params.wet_gain;
        self.decay = params.decay;
        self.damping = params.damping;
        self.decay_diffusion_2 = (params.decay + 0.15).clamp(0.25, 0.50);
        // The zero-intensity message omits the diffusion parameters.
        if let Some(diffusion) = params.diffusion {
            self.diffusion = diffusion;
        }
    }

    /// Process a variable-length block of PCM into two wet output channels.
    /// Supply no right input for mono. An empty left input leaves the buffer
    /// and tank alone, as when the worklet receives no connected input.
    ///
    /// # Panics
    ///
    /// Panics on unequal channel lengths for a nonempty input block.
    pub fn process(
        &mut self,
        left: &[f32],
        right: Option<&[f32]>,
        out_left: &mut [f32],
        out_right: &mut [f32],
    ) {
        if left.is_empty() {
            return;
        }
        let right = right.unwrap_or(left);
        assert_eq!(right.len(), left.len());
        assert_eq!(out_left.len(), left.len());
        assert_eq!(out_right.len(), left.len());
        if self.wet_gain == 0.0 {
            out_left.fill(0.0);
            out_right.fill(0.0);
            return;
        }
        let predelay_frames = (self.predelay * self.sample_rate * 0.1).floor() as usize;
        for i in 0..left.len() {
            let input = (sanitize(left[i]) + sanitize(right[i])) * 0.5;
            [out_left[i], out_right[i]] = self.process_frame(input, predelay_frames, 0.0);
        }
    }

    fn process_frame(
        &mut self,
        input: f64,
        predelay_frames: usize,
        predelay_fraction: f64,
    ) -> [f32; 2] {
        let frame = self.frame;
        let predelay_length = self.pre_delay.len();
        self.pre_delay[self.pre_index] = input as f32;
        self.pre_index = (self.pre_index + 1) % predelay_length;
        let delayed_index = (self.pre_index + predelay_length - predelay_frames) % predelay_length;
        let mut delayed = f64::from(self.pre_delay[delayed_index]);
        if predelay_fraction > 0.0 {
            let previous_index = (delayed_index + predelay_length - 1) % predelay_length;
            let previous = f64::from(self.pre_delay[previous_index]);
            delayed += predelay_fraction * (previous - delayed);
        }
        self.pre_filter_state += (delayed - self.pre_filter_state) * self.diffusion.pre_filter;
        let mut input = self.pre_filter_state;
        for (i, diffuser) in self.input_diffusers.iter_mut().enumerate() {
            input = diffuser.allpass(frame, frame, self.diffusion.input_diffusion[i / 2], input);
        }
        // The signal sees decay both at the cross-feed and before the diffuser.
        input *= 1.0 - self.decay * self.decay;

        if frame & 0x7ff == 0 {
            if self.mod_phase == 8 {
                self.mod_direction = -1;
            } else if self.mod_phase == -8 {
                self.mod_direction = 1;
            }
            self.mod_phase += self.mod_direction;
        }
        let modulated_frame = frame.wrapping_add_signed(self.mod_phase);
        for i in 0..self.legs.len() {
            // Read the opposite leg in the same sequential order as the worklet.
            let feedback = self.legs[1 - i].post_damp.read(frame) * self.decay;
            let leg = &mut self.legs[i];
            let filtered = leg.modulated.allpass(
                frame,
                modulated_frame,
                -self.diffusion.decay_diffusion,
                input + feedback,
            );
            leg.pre_damp.write(frame, filtered);
            let filtered = leg.pre_damp.read(frame);
            leg.damping_state += (filtered - leg.damping_state) * self.damping;
            let signal = leg.diffuser.allpass(
                frame,
                frame,
                self.decay_diffusion_2,
                leg.damping_state * self.decay,
            );
            leg.post_damp.write(frame, signal);
        }

        let [first, second] = &self.legs;
        let wet_left = second.pre_damp.tap(frame, 266) + second.pre_damp.tap(frame, 2974)
            - second.diffuser.tap(frame, 1913)
            + second.post_damp.tap(frame, 1996)
            - first.pre_damp.tap(frame, 1990)
            - first.diffuser.tap(frame, 187)
            + first.post_damp.tap(frame, 1066);
        let wet_right = first.pre_damp.tap(frame, 353) + first.pre_damp.tap(frame, 3627)
            - first.diffuser.tap(frame, 1228)
            + first.post_damp.tap(frame, 2673)
            - second.pre_damp.tap(frame, 2111)
            - second.diffuser.tap(frame, 335)
            + second.post_damp.tap(frame, 121);

        self.frame = frame.wrapping_add(1);
        let normalization = 7.0_f64.sqrt();
        [
            (self.wet_gain * wet_left / normalization) as f32,
            (self.wet_gain * wet_right / normalization) as f32,
        ]
    }
}

fn sanitize(sample: f32) -> f64 {
    if sample.is_finite() {
        f64::from(sample.clamp(-1.0, 1.0))
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests;
