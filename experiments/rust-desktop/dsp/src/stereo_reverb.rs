use std::{f32::consts::FRAC_1_SQRT_2, f64::consts::PI};

use super::{Dattorro, DattorroParams, Diffusion, sanitize};

const RAMP_MS: u32 = 20;

/// Wet reverb controls in their native units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReverbSettings {
    /// Reverb intensity from 0 (dry) to 1.
    pub intensity: f32,
    /// Wet high-pass cutoff in Hz (20 to 1000).
    pub high_pass_hz: f32,
    /// Wet low-pass cutoff in Hz (1000 to 20000).
    pub low_pass_hz: f32,
}

impl Default for ReverbSettings {
    fn default() -> Self {
        Self {
            intensity: 0.0,
            high_pass_hz: 180.0,
            low_pass_hz: 6500.0,
        }
    }
}

impl ReverbSettings {
    fn normalized(self) -> Self {
        let default = Self::default();
        Self {
            intensity: finite_clamp(self.intensity, 0.0, 1.0, default.intensity),
            high_pass_hz: finite_clamp(self.high_pass_hz, 20.0, 1000.0, default.high_pass_hz),
            low_pass_hz: finite_clamp(self.low_pass_hz, 1000.0, 20_000.0, default.low_pass_hz),
        }
    }
}

fn finite_clamp(value: f32, min: f32, max: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

/// Dry stereo plus a tone-filtered, level-ramped Dattorro reverb send.
/// Only construction allocates. Process successive PCM frames with one
/// instance to preserve the tail across audio callbacks.
pub struct StereoReverb {
    sample_rate: f64,
    ramp_frames: u32,
    settings: ReverbSettings,
    intensity: Ramp<IntensityParameters>,
    tone: [Ramp<BiquadCoefficients>; 2],
    tank: Dattorro,
    filters: [StereoBiquad; 2],
}

impl StereoReverb {
    /// Construct a dry mixer at a positive output sample rate in Hz.
    pub fn new(sample_rate: u32) -> Self {
        let settings = ReverbSettings::default();
        let tank = Dattorro::new(sample_rate);
        let ramp_frames = (u64::from(sample_rate) * u64::from(RAMP_MS)).div_ceil(1000) as u32;
        let sample_rate = f64::from(sample_rate);
        let initial = IntensityParameters {
            tank: DattorroParams {
                wet_gain: 1.0,
                ..DattorroParams::from_intensity(1.0)
            },
            predelay_frames: 0.0,
            wet_level: 0.0,
        };
        Self {
            sample_rate,
            ramp_frames,
            settings,
            intensity: Ramp::new(initial),
            tone: [
                Ramp::new(BiquadCoefficients::for_cutoff(
                    f64::from(settings.high_pass_hz),
                    sample_rate,
                    true,
                )),
                Ramp::new(BiquadCoefficients::for_cutoff(
                    f64::from(settings.low_pass_hz),
                    sample_rate,
                    false,
                )),
            ],
            tank,
            filters: Default::default(),
        }
    }

    /// Begin a 20 ms transition from the current mix, preserving the tail.
    /// Reapplying an identical setting leaves an in-progress transition alone.
    pub fn set_settings(&mut self, settings: ReverbSettings) {
        let settings = settings.normalized();
        if self.settings == settings {
            return;
        }
        let was_dry = self.intensity.current.wet_level == 0.0;
        let cutoffs = [
            (settings.high_pass_hz, self.settings.high_pass_hz, true),
            (settings.low_pass_hz, self.settings.low_pass_hz, false),
        ];
        for (ramp, (hz, previous_hz, high_pass)) in self.tone.iter_mut().zip(cutoffs) {
            if hz != previous_hz {
                let target =
                    BiquadCoefficients::for_cutoff(f64::from(hz), self.sample_rate, high_pass);
                ramp.retarget(target, self.ramp_frames);
                if was_dry {
                    ramp.settle();
                }
            }
        }
        if settings.intensity != self.settings.intensity {
            self.set_intensity(settings.intensity, was_dry);
        }
        self.settings = settings;
    }

    fn set_intensity(&mut self, intensity: f32, was_dry: bool) {
        let target = if intensity > 0.0 {
            let tank = DattorroParams::from_intensity(f64::from(intensity));
            IntensityParameters {
                wet_level: tank.wet_gain,
                predelay_frames: (tank.predelay * self.sample_rate * 0.1).floor(),
                tank: DattorroParams {
                    wet_gain: 1.0,
                    ..tank
                },
            }
        } else {
            // Finish a fade-out with the existing tank and its tail.
            IntensityParameters {
                wet_level: 0.0,
                ..self.intensity.current
            }
        };

        if was_dry {
            self.intensity = Ramp::new(IntensityParameters {
                wet_level: 0.0,
                ..target
            });
            if intensity == 0.0 {
                return;
            }
            // A new send starts with the desired tone, an empty tank, and a
            // silent wet gain. A stopped send cannot revive a stale tail.
            self.clear_history();
            for tone in &mut self.tone {
                tone.settle();
            }
        }
        self.intensity.retarget(target, self.ramp_frames);
    }

    /// Discard tail and filter history after a track change or seek. Current
    /// controls persist and take effect immediately on the fresh audio.
    pub fn reset(&mut self) {
        self.clear_history();
        self.intensity.settle();
        self.tank.set_params(self.intensity.current.tank);
        for tone in &mut self.tone {
            tone.settle();
        }
    }

    /// Process one stereo frame. Full-scale finite dry input passes at unity
    /// while the effect is silent. Invalid PCM is silenced and over-range
    /// input is clamped to full scale.
    pub fn process_frame(&mut self, input: [f32; 2]) -> [f32; 2] {
        let dry = input.map(sanitize);
        if self
            .intensity
            .advance(self.ramp_frames, IntensityParameters::lerp)
        {
            self.tank.set_params(self.intensity.current.tank);
        }

        let intensity = self.intensity.current;
        if intensity.wet_level == 0.0 {
            return dry.map(|sample| sample as f32);
        }

        let delay_frames = intensity.predelay_frames;
        let tank_input = (dry[0] + dry[1]) * 0.5;
        let mut wet = self
            .tank
            .process_frame(tank_input, delay_frames as usize, delay_frames.fract())
            .map(f64::from);
        for (filter, tone) in self.filters.iter_mut().zip(&mut self.tone) {
            tone.advance(self.ramp_frames, BiquadCoefficients::lerp);
            wet = filter.process(wet, tone.current);
        }
        mix_with_headroom(dry, wet.map(|sample| sample * intensity.wet_level))
    }

    fn clear_history(&mut self) {
        self.tank.reset();
        self.filters = Default::default();
    }
}

struct Ramp<T> {
    start: T,
    current: T,
    target: T,
    remaining: u32,
}

impl<T: Copy> Ramp<T> {
    fn new(value: T) -> Self {
        Self {
            start: value,
            current: value,
            target: value,
            remaining: 0,
        }
    }

    fn retarget(&mut self, target: T, frames: u32) {
        self.start = self.current;
        self.target = target;
        self.remaining = frames;
    }

    fn settle(&mut self) {
        *self = Self::new(self.target);
    }

    fn advance(&mut self, frames: u32, interpolate: impl FnOnce(T, T, f64) -> T) -> bool {
        if self.remaining == 0 {
            return false;
        }
        self.remaining -= 1;
        self.current = if self.remaining == 0 {
            self.target
        } else {
            let progress = f64::from(frames - self.remaining) / f64::from(frames);
            interpolate(self.start, self.target, progress)
        };
        true
    }
}

#[derive(Clone, Copy)]
struct IntensityParameters {
    tank: DattorroParams,
    predelay_frames: f64,
    wet_level: f64,
}

impl IntensityParameters {
    fn lerp(self, to: Self, t: f64) -> Self {
        let from_tank = self.tank;
        let to_tank = to.tank;
        let diffusion = from_tank
            .diffusion
            .zip(to_tank.diffusion)
            .map(|(from, to)| Diffusion {
                pre_filter: lerp(from.pre_filter, to.pre_filter, t),
                input_diffusion: to.input_diffusion,
                decay_diffusion: lerp(from.decay_diffusion, to.decay_diffusion, t),
            });
        Self {
            tank: DattorroParams {
                decay: lerp(from_tank.decay, to_tank.decay, t),
                damping: lerp(from_tank.damping, to_tank.damping, t),
                diffusion,
                ..to_tank
            },
            predelay_frames: lerp(self.predelay_frames, to.predelay_frames, t),
            wet_level: lerp(self.wet_level, to.wet_level, t),
        }
    }
}

fn lerp(from: f64, to: f64, t: f64) -> f64 {
    from + (to - from) * t
}

#[derive(Clone, Copy)]
struct BiquadCoefficients {
    b: [f64; 3],
    a: [f64; 2],
}

impl BiquadCoefficients {
    fn for_cutoff(hz: f64, sample_rate: f64, high_pass: bool) -> Self {
        if hz >= sample_rate / 2.0 {
            // At Nyquist the low-pass is unity and the high-pass removes all signal.
            let gain = if high_pass { 0.0 } else { 1.0 };
            return Self {
                b: [gain, 0.0, 0.0],
                a: [0.0; 2],
            };
        }

        let (sin, cos) = (2.0 * PI * hz / sample_rate).sin_cos();
        // The renderer sets Q to sqrt(1/2). For Web Audio's low- and
        // high-pass filters Q is expressed in decibels.
        let q = 10.0_f64.powf(f64::from(FRAC_1_SQRT_2) / 20.0);
        let alpha = sin / (2.0 * q);
        let a0 = 1.0 + alpha;
        let sign = if high_pass { -1.0 } else { 1.0 };
        let beta = (1.0 - sign * cos) / (2.0 * a0);
        Self {
            b: [beta, sign * 2.0 * beta, beta],
            a: [-2.0 * cos / a0, (1.0 - alpha) / a0],
        }
    }

    fn lerp(self, to: Self, t: f64) -> Self {
        Self {
            b: std::array::from_fn(|i| lerp(self.b[i], to.b[i], t)),
            a: std::array::from_fn(|i| lerp(self.a[i], to.a[i], t)),
        }
    }
}

#[derive(Default)]
struct StereoBiquad {
    inputs: [[f64; 2]; 2],
    outputs: [[f64; 2]; 2],
}

impl StereoBiquad {
    fn process(&mut self, input: [f64; 2], coeff: BiquadCoefficients) -> [f64; 2] {
        let [b0, b1, b2] = coeff.b;
        let [a1, a2] = coeff.a;
        let output = std::array::from_fn(|ch| {
            b0 * input[ch] + b1 * self.inputs[0][ch] + b2 * self.inputs[1][ch]
                - a1 * self.outputs[0][ch]
                - a2 * self.outputs[1][ch]
        });
        self.inputs = [input, self.inputs[0]];
        self.outputs = [output, self.outputs[0]];
        output
    }
}

fn mix_with_headroom(dry: [f64; 2], wet: [f64; 2]) -> [f32; 2] {
    // Use the same reserve on both channels to preserve the stereo tail.
    // Only the wet send can be reduced, so transients in the dry stay intact.
    let mut scale = 1.0_f64;
    for (dry, wet) in dry.into_iter().zip(wet) {
        let room = 1.0 - dry * wet.signum();
        let amplitude = wet.abs();
        if amplitude > room {
            scale = scale.min(room / amplitude);
        }
    }
    std::array::from_fn(|ch| (dry[ch] + scale * wet[ch]) as f32)
}

#[cfg(test)]
mod tests {
    use super::mix_with_headroom;

    #[test]
    fn peak_reserve_reduces_only_the_linked_wet_signal() {
        assert_eq!(mix_with_headroom([0.0, -0.25], [0.4, 0.2]), [0.4, -0.05]);
        assert_eq!(mix_with_headroom([0.9, -0.25], [0.4, 0.2]), [1.0, -0.2]);
        assert_eq!(mix_with_headroom([1.0, -0.25], [0.4, 0.2]), [1.0, -0.25]);
        assert_eq!(mix_with_headroom([1.0, -0.25], [-0.4, 0.2]), [0.6, -0.05]);
    }
}
