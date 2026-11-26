use std::f64::consts::TAU;

use pear_preview_dsp::equalizer::{
    EqualizerBand, EqualizerError, EqualizerSettings, GraphicMode, StereoEqualizer,
};

const RATE: u32 = 48_000;

fn band(frequency_hz: f64, gain_db: f64, q: f64) -> EqualizerBand {
    EqualizerBand {
        frequency_hz,
        gain_db,
        q,
    }
}

fn settings(bands: &[EqualizerBand]) -> EqualizerSettings<'_> {
    EqualizerSettings {
        bands,
        ..Default::default()
    }
}

fn assert_close(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "expected {expected} +/- {tolerance}, got {actual}"
    );
}

#[test]
fn graphic_centers_and_q_match_the_released_profiles() {
    for (mode, count, second_center, q) in [
        (
            GraphicMode::Bands8,
            8,
            76.710_490_182_992_12,
            1.087_285_108_771_585,
        ),
        (
            GraphicMode::Bands14,
            14,
            50.868_594_780_073_32,
            2.066_721_864_559_446,
        ),
        (
            GraphicMode::Bands20,
            20,
            43.724_170_220_142_28,
            3.035_964_411_366_417,
        ),
    ] {
        let bands = mode.flat_bands();
        assert_eq!(bands.len(), count);
        assert_eq!(bands[0].frequency_hz, 31.5);
        assert_close(bands[1].frequency_hz, second_center, 1e-8);
        assert_close(bands[count - 1].frequency_hz, 16_000.0, 1e-8);
        for band in bands {
            assert_eq!(band.gain_db, 0.0);
            assert_close(band.q, q, 1e-8);
        }
    }
}

#[test]
fn flat_or_bypassed_audio_keeps_a_unity_stereo_path() {
    let flat_bands = GraphicMode::Bands20.flat_bands();
    let boosted = [band(1200.0, 18.0, 0.8)];
    for config in [
        settings(&flat_bands),
        EqualizerSettings {
            bands: &boosted,
            manual_preamp_db: 12.0,
            auto_preamp: true,
            bypass: true,
        },
    ] {
        let mut equalizer = StereoEqualizer::new(RATE, config, 0.125).unwrap();
        let original = [[-0.0, -1.0], [f32::MIN_POSITIVE, 1.0], [2.0, -3.0]];
        let mut pcm = original;
        equalizer.process_in_place(&mut pcm);
        assert_eq!(
            pcm.map(|frame| frame.map(f32::to_bits)),
            original.map(|frame| frame.map(f32::to_bits))
        );
        assert_eq!(equalizer.effective_preamp_db(), 0.0);
    }
}

#[test]
fn center_response_has_the_requested_gain_and_manual_preamp() {
    let center = 2400.0;
    for gain_db in [-18.0, 12.0] {
        let bands = [band(center, gain_db, 1.25)];
        let config = EqualizerSettings {
            manual_preamp_db: -6.0,
            ..settings(&bands)
        };
        let mut equalizer = StereoEqualizer::new(RATE, config, 0.25).unwrap();
        let mut input_power = 0.0;
        let mut output_power = 0.0;
        for frame in 0..4800 {
            let x = (0.125 * (TAU * center * f64::from(frame) / f64::from(RATE)).sin()) as f32;
            let [left, right] = equalizer.process_frame([x, 0.0]);
            assert_eq!(right, 0.0);
            if frame >= 2400 {
                input_power += f64::from(x).powi(2);
                output_power += f64::from(left).powi(2);
            }
        }
        assert_close(
            10.0 * (output_power / input_power).log10(),
            gain_db - 6.0,
            1e-5,
        );
    }
}

#[test]
fn auto_preamp_uses_source_headroom_without_applying_source_gain_again() {
    let bands = [band(2400.0, 12.0, 1.25)];
    let config = EqualizerSettings {
        manual_preamp_db: 8.0,
        auto_preamp: true,
        ..settings(&bands)
    };
    let mut equalizer = StereoEqualizer::new(RATE, config, 1.0).unwrap();
    assert_close(equalizer.effective_preamp_db(), -12.1, 1e-5);
    equalizer.set_source_volume(0.5);
    assert_close(
        equalizer.effective_preamp_db(),
        -(12.1 + 20.0 * 0.5_f64.log10()),
        1e-5,
    );
    for volume in [0.1, 0.0] {
        equalizer.set_source_volume(volume);
        assert_eq!(equalizer.effective_preamp_db(), 0.0);
    }
    equalizer.set_source_volume(f64::NAN);
    assert_close(equalizer.effective_preamp_db(), -12.1, 1e-5);

    let mut manual = StereoEqualizer::new(RATE, settings(&bands), 1.0).unwrap();
    equalizer.set_source_volume(0.1);
    assert_eq!(
        equalizer.process_frame([0.125, -0.25]),
        manual.process_frame([0.125, -0.25])
    );
}

#[test]
fn low_sample_rate_skips_nyquist_and_higher_bands() {
    let bands = [
        band(0.0, 24.0, 1.0),
        band(4000.0, 24.0, 1.0),
        band(16_000.0, 24.0, 1.0),
    ];
    let config = EqualizerSettings {
        auto_preamp: true,
        ..settings(&bands)
    };
    let mut equalizer = StereoEqualizer::new(8000, config, 1.0).unwrap();
    assert_eq!(equalizer.effective_preamp_db(), 0.0);
    assert_eq!(equalizer.process_frame([0.125, -0.25]), [0.125, -0.25]);
}

#[test]
fn rejection_covers_invalid_and_excessive_controls() {
    for invalid in [
        band(-1.0, 0.0, 1.0),
        band(20_001.0, 0.0, 1.0),
        band(f64::NAN, 0.0, 1.0),
        band(1000.0, 48.01, 1.0),
        band(1000.0, f64::INFINITY, 1.0),
        band(1000.0, 1.0, 0.0),
        band(1000.0, 1.0, 1000.01),
        band(1000.0, 1.0, f64::NAN),
    ] {
        assert!(matches!(
            StereoEqualizer::new(RATE, settings(&[invalid]), 1.0),
            Err(EqualizerError::InvalidBand(0))
        ));
    }
    assert!(matches!(
        StereoEqualizer::new(0, settings(&[]), 1.0),
        Err(EqualizerError::InvalidSampleRate)
    ));
    assert!(matches!(
        StereoEqualizer::new(u32::MAX, settings(&[]), 1.0),
        Err(EqualizerError::InvalidSampleRate)
    ));
    let bad_preamp = EqualizerSettings {
        manual_preamp_db: -24.01,
        ..settings(&[])
    };
    assert!(matches!(
        StereoEqualizer::new(RATE, bad_preamp, 1.0),
        Err(EqualizerError::InvalidPreamp)
    ));
    let excess = [band(1000.0, 1.0, 1.0); 65];
    assert!(matches!(
        StereoEqualizer::new(RATE, settings(&excess), 1.0),
        Err(EqualizerError::TooManyBands)
    ));
    let overload = [band(1000.0, 48.0, 1.0); 6];
    // A following cut cannot repair overflow in an earlier stage.
    let overload_then_cut = [overload.as_slice(), &[band(1000.0, -48.0, 1.0)]].concat();
    let config = EqualizerSettings {
        auto_preamp: true,
        ..settings(&overload_then_cut)
    };
    assert!(matches!(
        StereoEqualizer::new(RATE, config, 1.0),
        Err(EqualizerError::ExcessiveResponse)
    ));
}

#[test]
fn chunk_boundaries_and_reset_preserve_expected_filter_state() {
    let bands = [band(300.0, 10.0, 0.6), band(2000.0, -16.0, 2.0)];
    let mut equalizer = StereoEqualizer::new(RATE, settings(&bands), 1.0).unwrap();
    let mut original = [[0.0; 2]; 128];
    original[0] = [0.25, -0.75];
    let mut continuous = original;
    equalizer.process_in_place(&mut continuous);
    assert_ne!(continuous[1], [0.0; 2]);

    equalizer.reset();
    let mut chunked = original;
    for chunk in chunked.chunks_mut(7) {
        equalizer.process_in_place(chunk);
    }
    assert_eq!(chunked, continuous);

    equalizer.reset();
    assert_eq!(
        equalizer.process_frame([f32::NAN, f32::INFINITY]),
        [0.0, 0.0]
    );
    assert_eq!(equalizer.process_frame([0.0, 0.0]), [0.0, 0.0]);
}

#[test]
fn peaking_cascade_impulse_matches_chromium_web_audio() {
    // 48 kHz OfflineAudioContext, 0.5 impulse, GainNode, and serial BiquadFilterNodes.
    let expected = [
        0.328_021_26,
        -0.062_513_65,
        -0.055_333_63,
        0.007_822_112,
        0.077_475_99,
        0.081_796_12,
        0.028_919_486,
        -0.010_896_735,
        -0.001_320_777_3,
        0.023_566_31,
        0.018_992_845,
        -0.009_300_721,
        -0.021_944_148,
        -0.004_405_876,
        0.017_170_105,
        0.016_242_946,
    ];
    let bands = [
        band(100.0, 8.0, 0.8),
        band(4200.0, -12.0, 2.0),
        band(9800.0, 6.0, 3.5),
    ];
    let config = EqualizerSettings {
        manual_preamp_db: -3.0,
        ..settings(&bands)
    };
    let mut equalizer = StereoEqualizer::new(RATE, config, 1.0).unwrap();
    for (i, expected) in expected.into_iter().enumerate() {
        let actual = equalizer.process_frame(if i == 0 { [0.5, -0.25] } else { [0.0; 2] });
        assert_close(f64::from(actual[0]), expected, 1e-7);
        assert_close(f64::from(actual[1]), -0.5 * expected, 1e-7);
    }
}

#[test]
fn auto_preamp_tracks_chromium_peaks_across_sample_rates() {
    // Reference from Chromium getFrequencyResponse over 65536 steps and a 1 mHz
    // grid within 2 Hz of each band center.
    let cases: [&[EqualizerBand]; 3] = [
        &[band(1234.5, 24.0, 1000.0), band(1235.1, 24.0, 1000.0)],
        &[band(500.0, 12.0, 0.8), band(800.0, 12.0, 1.0)],
        &[band(19_999.0, 24.0, 1000.0)],
    ];
    for (rate, peaks) in [
        (8000, [35.154_697, 19.626_587, 0.0]),
        (44_100, [36.425_958, 19.878_441, 23.999_982]),
        (48_000, [36.432_554, 19.879_744, 23.999_997]),
        (96_000, [36.459_309, 19.885_029, 24.0]),
    ] {
        for (bands, peak) in cases.into_iter().zip(peaks) {
            let config = EqualizerSettings {
                auto_preamp: true,
                ..settings(bands)
            };
            let equalizer = StereoEqualizer::new(rate, config, 1.0).unwrap();
            let expected = if peak > 0.0 { -peak - 0.1 } else { 0.0 };
            assert_close(equalizer.effective_preamp_db(), expected, 0.02);
        }
    }
}

#[test]
fn rejects_an_unrepresentable_pole_pair() {
    let nearly_dc = [band(1e-20, 12.0, 1000.0)];
    assert!(matches!(
        StereoEqualizer::new(384_000, settings(&nearly_dc), 1.0),
        Err(EqualizerError::UnstableBand(0))
    ));
}

#[test]
fn prepared_equalizer_can_be_replaced_without_running_a_destructor() {
    assert!(!std::hint::black_box(
        std::mem::needs_drop::<StereoEqualizer>()
    ));
}
