//! Native stereo peaking equalizer and volume-aware preamp.

// Graphic spacing, input limits and peak selection follow Pear's MIT-licensed
// src/plugins/equalizer/{config,controller,response}.ts (9e8e4edf, 8bf7c1a4,
// c31b0e8c). Peaking sections implement the Web Audio Audio EQ Cookbook formula.

use std::{f64::consts::TAU, fmt};

/// Maximum number of bands in a custom profile.
pub const MAX_BANDS: usize = 64;
const DSP_LIMIT_DB: f64 = 240.0;

/// Parameters for one custom or graphic peaking filter.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EqualizerBand {
    pub frequency_hz: f64,
    pub gain_db: f64,
    pub q: f64,
}

impl EqualizerBand {
    fn is_valid(self) -> bool {
        (0.0..=20_000.0).contains(&self.frequency_hz)
            && (-48.0..=48.0).contains(&self.gain_db)
            && self.q > 0.0
            && self.q <= 1000.0
    }
}

/// Pear's graphic band layouts. Custom profiles supply their own bands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GraphicMode {
    Bands8,
    Bands14,
    Bands20,
}

impl GraphicMode {
    /// Return the released centers and Q with all gains set to 0 dB.
    pub fn flat_bands(self) -> Vec<EqualizerBand> {
        let count = match self {
            Self::Bands8 => 8,
            Self::Bands14 => 14,
            Self::Bands20 => 20,
        };
        let ratio = (16_000.0_f64 / 31.5).powf(1.0 / f64::from(count - 1));
        let root_ratio = ratio.sqrt();
        let q = 1.0 / (root_ratio - 1.0 / root_ratio);
        (0..count)
            .map(|index| EqualizerBand {
                frequency_hz: 31.5 * ratio.powi(index),
                gain_db: 0.0,
                q,
            })
            .collect()
    }
}

/// A preset or the current controls. Defaults give a flat signal at unity.
#[derive(Clone, Copy, Debug, Default)]
pub struct EqualizerSettings<'a> {
    pub bands: &'a [EqualizerBand],
    pub manual_preamp_db: f64,
    pub auto_preamp: bool,
    pub bypass: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EqualizerError {
    InvalidSampleRate,
    InvalidPreamp,
    TooManyBands,
    InvalidBand(usize),
    UnstableBand(usize),
    ExcessiveResponse,
}

impl fmt::Display for EqualizerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSampleRate => f.write_str("unsupported equalizer sample rate"),
            Self::InvalidPreamp => f.write_str("manual preamp must be between -24 and 12 dB"),
            Self::TooManyBands => write!(f, "equalizer supports up to {MAX_BANDS} bands"),
            Self::InvalidBand(index) => write!(f, "invalid peaking band at index {index}"),
            Self::UnstableBand(index) => {
                write!(f, "peaking band at index {index} is ill-conditioned")
            }
            Self::ExcessiveResponse => {
                f.write_str("overlapping gain exceeds the DSP response range")
            }
        }
    }
}

impl std::error::Error for EqualizerError {}

/// A serial peaking cascade with independent left and right state. Build a
/// replacement off the audio thread when the filter profile changes. The
/// prepared cascade stores its filters inline so replacing it does not free
/// heap memory on the audio thread.
pub struct StereoEqualizer {
    filters: [Peaking; MAX_BANDS],
    filter_count: usize,
    auto_peak_db: Option<f64>,
    preamp_db: f64,
    preamp: f64,
}

impl StereoEqualizer {
    /// Prepare a profile at an output sample rate from 8 to 384 kHz inclusive.
    /// Bands at or above Nyquist are ignored. When auto preamp is enabled,
    /// the estimate uses the signal gain the caller accounts for separately
    /// (0 when muted, or 1 if other independently leveled sources are mixed).
    ///
    /// This may allocate and scan the frequency response. Call it off the
    /// audio thread. Processing, reset and source volume updates reuse storage.
    pub fn new(
        sample_rate: u32,
        settings: EqualizerSettings<'_>,
        source_volume: f64,
    ) -> Result<Self, EqualizerError> {
        if !(8_000..=384_000).contains(&sample_rate) {
            return Err(EqualizerError::InvalidSampleRate);
        }
        if !(-24.0..=12.0).contains(&settings.manual_preamp_db) {
            return Err(EqualizerError::InvalidPreamp);
        }
        if settings.bands.len() > MAX_BANDS {
            return Err(EqualizerError::TooManyBands);
        }

        let sample_rate = f64::from(sample_rate);
        let mut filters = [Peaking::INACTIVE; MAX_BANDS];
        let mut filter_count = 0;
        for (index, &band) in settings.bands.iter().enumerate() {
            if !band.is_valid() {
                return Err(EqualizerError::InvalidBand(index));
            }
            if !settings.bypass
                && band.frequency_hz > 0.0
                && band.frequency_hz < sample_rate / 2.0
                && band.gain_db != 0.0
            {
                filters[filter_count] =
                    Peaking::new(band, sample_rate).ok_or(EqualizerError::UnstableBand(index))?;
                filter_count += 1;
            }
        }

        let manual_preamp_db = if settings.bypass {
            0.0
        } else {
            settings.manual_preamp_db
        };
        let auto_preamp = settings.auto_preamp && !settings.bypass;
        let active_filters = &filters[..filter_count];
        let response_bound_db = manual_preamp_db
            + active_filters
                .iter()
                .map(|filter| filter.band.gain_db.max(0.0))
                .sum::<f64>();
        let peak_db = if filter_count != 0 && (auto_preamp || response_bound_db > DSP_LIMIT_DB) {
            sample_peak(active_filters, sample_rate, manual_preamp_db)?
        } else {
            0.0
        };
        let auto_peak_db = auto_preamp.then_some(peak_db);
        let preamp_db = if auto_preamp {
            auto_preamp_db(peak_db, source_volume)
        } else {
            manual_preamp_db
        };

        Ok(Self {
            filters,
            filter_count,
            auto_peak_db,
            preamp_db,
            preamp: db_to_gain(preamp_db),
        })
    }

    /// Preamp applied before the first filter, independent of source volume.
    pub fn effective_preamp_db(&self) -> f64 {
        self.preamp_db
    }

    /// Recalculate automatic headroom using the prepared response. The volume
    /// is applied by the caller. Invalid volume falls back to full scale.
    pub fn set_source_volume(&mut self, source_volume: f64) {
        if let Some(peak_db) = self.auto_peak_db {
            self.preamp_db = auto_preamp_db(peak_db, source_volume);
            self.preamp = db_to_gain(self.preamp_db);
        }
    }

    /// Clear both channels' history after a seek or source change.
    pub fn reset(&mut self) {
        for filter in &mut self.filters[..self.filter_count] {
            filter.delay = [[0.0; 2]; 2];
        }
    }

    /// Process stereo PCM. Non-finite input is treated as silence.
    pub fn process_frame(&mut self, input: [f32; 2]) -> [f32; 2] {
        let mut frame = input.map(|sample| {
            if sample.is_finite() {
                f64::from(sample) * self.preamp
            } else {
                0.0
            }
        });
        for filter in &mut self.filters[..self.filter_count] {
            frame = filter.process(frame);
        }
        frame.map(|sample| sample as f32)
    }

    /// Process any number of stereo frames in place.
    pub fn process_in_place(&mut self, frames: &mut [[f32; 2]]) {
        for frame in frames {
            *frame = self.process_frame(*frame);
        }
    }
}

fn db_to_gain(db: f64) -> f64 {
    10.0_f64.powf(db / 20.0)
}

fn auto_preamp_db(peak_db: f64, mut volume: f64) -> f64 {
    if volume == 0.0 {
        return 0.0;
    }
    if !(0.0..=1.0).contains(&volume) {
        volume = 1.0;
    }
    let total_db = peak_db + 20.0 * volume.log10();
    if total_db > 0.0001 {
        -total_db - 0.1
    } else {
        0.0
    }
}

#[derive(Clone, Copy)]
struct Peaking {
    band: EqualizerBand,
    center: f64,
    numerator_damping: f64,
    denominator_damping: f64,
    a1: f64,
    a2: f64,
    correction: f64,
    delay: [[f64; 2]; 2],
}

impl Peaking {
    const INACTIVE: Self = Self {
        band: EqualizerBand {
            frequency_hz: 0.0,
            gain_db: 0.0,
            q: 1.0,
        },
        center: 0.0,
        numerator_damping: 0.0,
        denominator_damping: 0.0,
        a1: 0.0,
        a2: 0.0,
        correction: 0.0,
        delay: [[0.0; 2]; 2],
    };

    fn new(band: EqualizerBand, sample_rate: f64) -> Option<Self> {
        let center = TAU * band.frequency_hz / sample_rate;
        let amplitude = db_to_gain(band.gain_db * 0.5);
        let sin_center = center.sin();
        let numerator_damping = sin_center * amplitude;
        let denominator_damping = sin_center / amplitude;
        // Scale the cookbook coefficients by 2Q before normalizing. This
        // avoids overflow from calculating alpha = sin(center)/(2Q).
        let weight = 2.0 * band.q;
        let a0 = weight + denominator_damping;
        let a2 = (weight - denominator_damping) / a0;
        let a1 = -2.0 * center.cos() * (weight / a0);
        // Require the rounded denominator to retain both poles inside the
        // unit circle, even for frequencies arbitrarily close to DC/Nyquist.
        if !(a2.abs() < 1.0 && a1.abs() < 1.0 + a2) {
            return None;
        }
        let correction = (numerator_damping - denominator_damping) / a0;
        Some(Self {
            band,
            center,
            numerator_damping,
            denominator_damping,
            a1,
            a2,
            correction,
            delay: [[0.0; 2]; 2],
        })
    }

    fn process(&mut self, mut frame: [f64; 2]) -> [f64; 2] {
        for (sample, [z1, z2]) in frame.iter_mut().zip(&mut self.delay) {
            // The numerator has the same middle coefficient as the
            // denominator. Process the correction to unity in direct form II.
            let feed = self.correction * *sample;
            let correction = feed + *z1;
            *z1 = *z2 - self.a1 * correction;
            *z2 = -feed - self.a2 * correction;
            *sample += correction;
        }
        frame
    }

    fn gain_db_at(&self, omega: f64, sin_omega: f64) -> f64 {
        // Evaluate the shifted numerator and denominator without subtracting
        // nearly equal cosines around narrow or low-frequency filter centers.
        let cosine_difference =
            -2.0 * ((omega + self.center) * 0.5).sin() * ((omega - self.center) * 0.5).sin();
        let real = 2.0 * self.band.q * cosine_difference;
        let numerator = real.hypot(self.numerator_damping * sin_omega);
        let denominator = real.hypot(self.denominator_damping * sin_omega);
        20.0 * f64::from((numerator / denominator) as f32).log10()
    }
}

fn response_at(
    filters: &[Peaking],
    sample_rate: f64,
    frequency: f64,
    manual_preamp_db: f64,
) -> Result<f64, EqualizerError> {
    if frequency == 0.0 || frequency >= sample_rate / 2.0 {
        return Ok(0.0);
    }

    let omega = TAU * frequency / sample_rate;
    let sin_omega = omega.sin();
    let mut sum = 0.0;
    for filter in filters {
        sum += filter.gain_db_at(omega, sin_omega);
        // Validate every prefix so cancellation later in the cascade cannot
        // conceal an excessive intermediate gain, even in automatic mode.
        if !sum.is_finite() || sum + manual_preamp_db > DSP_LIMIT_DB {
            return Err(EqualizerError::ExcessiveResponse);
        }
    }
    Ok(sum)
}

fn sample_peak(
    filters: &[Peaking],
    sample_rate: f64,
    manual_preamp_db: f64,
) -> Result<f64, EqualizerError> {
    let nyquist = sample_rate / 2.0;
    let mut frequencies = Vec::new();
    let add = |frequencies: &mut Vec<f64>, frequency: f64| {
        frequencies.push(f64::from(frequency.clamp(0.0, nyquist) as f32));
    };
    add(&mut frequencies, 0.0);
    add(&mut frequencies, nyquist);
    for step in 0..384 {
        add(&mut frequencies, nyquist.powf(f64::from(step) / 383.0));
    }
    for step in 1..128 {
        add(&mut frequencies, nyquist * f64::from(step) / 128.0);
    }
    for filter in filters {
        let EqualizerBand {
            frequency_hz, q, ..
        } = filter.band;
        add(&mut frequencies, frequency_hz);
        let width = frequency_hz.min(nyquist - frequency_hz) / q;
        for offset in [0.0625, 0.125, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0] {
            add(&mut frequencies, frequency_hz - width * offset);
            add(&mut frequencies, frequency_hz + width * offset);
        }
    }

    let mut refinements_remaining = 2;
    loop {
        frequencies.sort_unstable_by(f64::total_cmp);
        frequencies.dedup();
        let gains: Vec<f64> = frequencies
            .iter()
            .map(|&frequency| response_at(filters, sample_rate, frequency, manual_preamp_db))
            .collect::<Result<_, _>>()?;
        let peak = gains.iter().copied().fold(0.0, f64::max);
        if refinements_remaining == 0 {
            return Ok(peak);
        }
        refinements_remaining -= 1;

        let mut peaks: Vec<usize> = gains
            .windows(3)
            .enumerate()
            .filter_map(|(i, window)| {
                let [left, middle, right] = [window[0], window[1], window[2]];
                (middle >= left && middle >= right && (middle > left || middle > right))
                    .then_some(i + 1)
            })
            .collect();
        if peaks.is_empty() {
            return Ok(peak);
        }
        // Refine the strongest local peaks first. The coarse grid, centers
        // and two refinement passes add at most 3521 candidate points.
        peaks.sort_by(|&a, &b| gains[b].total_cmp(&gains[a]));
        for index in peaks.into_iter().take(MAX_BANDS) {
            let left = frequencies[index - 1];
            let span = frequencies[index + 1] - left;
            for step in 1..16 {
                add(&mut frequencies, left + span * f64::from(step) / 16.0);
            }
        }
    }
}
