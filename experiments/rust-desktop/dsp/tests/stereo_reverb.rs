use pear_preview_dsp::{ReverbSettings, StereoReverb};
use std::f32::consts::TAU;

const RATE: u32 = 48_000;

fn active_settings() -> ReverbSettings {
    ReverbSettings {
        intensity: 1.0,
        ..ReverbSettings::default()
    }
}

fn reverb(settings: ReverbSettings) -> StereoReverb {
    let mut reverb = StereoReverb::new(RATE);
    reverb.set_settings(settings);
    reverb
}

#[test]
fn defaults_bypass_stereo_pcm_bit_for_bit() {
    let settings = ReverbSettings::default();
    assert_eq!(settings.intensity, 0.0);
    assert_eq!(settings.high_pass_hz, 180.0);
    assert_eq!(settings.low_pass_hz, 6500.0);

    let mut reverb = reverb(settings);
    for dry in [[-0.0, 0.0], [-0.25, 0.75], [1.0, -1.0], [0.125, -0.875]] {
        assert_eq!(
            reverb.process_frame(dry).map(f32::to_bits),
            dry.map(f32::to_bits)
        );
    }
}

#[test]
fn impulse_has_unity_dry_attack_and_a_decaying_stereo_tail() {
    let mut reverb = reverb(active_settings());
    let impulse = [0.5, 0.25];
    assert_eq!(reverb.process_frame(impulse), impulse);
    let mut energy = [0.0; 3];
    let mut distinct = false;
    for i in 0..3 * RATE {
        let [left, right] = reverb.process_frame([0.0; 2]);
        assert!(left.abs() < 0.5 && right.abs() < 0.5);
        distinct |= (left - right).abs() > 0.001;
        energy[(i / RATE) as usize] += left * left + right * right;
    }
    assert!(distinct);
    assert!(energy[0] > 0.0001, "{energy:?}");
    assert!(energy[1] < energy[0] * 0.1, "{energy:?}");
    assert!(energy[2] < energy[1] * 0.1, "{energy:?}");
}

fn wet_energy_at(settings: ReverbSettings, hz: f32) -> f32 {
    let mut reverb = reverb(settings);
    (0..RATE)
        .map(|i| {
            let dry = (i as f32 * TAU * hz / RATE as f32).sin() * 0.25;
            let [left, right] = reverb.process_frame([dry, dry]);
            if i < RATE / 2 {
                0.0
            } else {
                (left - dry).powi(2) + (right - dry).powi(2)
            }
        })
        .sum()
}

#[test]
fn tone_controls_filter_wet_audio_only_and_use_exact_hertz() {
    let defaults = active_settings();
    let raised_high_pass = ReverbSettings {
        high_pass_hz: 900.0,
        ..defaults
    };
    let lowered_low_pass = ReverbSettings {
        low_pass_hz: 1200.0,
        ..defaults
    };
    let adjacent_low_pass = ReverbSettings {
        low_pass_hz: 6501.0,
        ..defaults
    };
    let default_low_tone = wet_energy_at(defaults, 250.0);
    let default_high_tone = wet_energy_at(defaults, 8_000.0);
    assert!(default_low_tone > 0.01);
    assert!(default_high_tone > 0.01);
    assert!(wet_energy_at(raised_high_pass, 250.0) < default_low_tone * 0.1);
    assert!(wet_energy_at(lowered_low_pass, 8_000.0) < default_high_tone * 0.1);
    assert!(wet_energy_at(adjacent_low_pass, 8_000.0) > default_high_tone);

    let mut reverb = reverb(lowered_low_pass);
    assert_eq!(reverb.process_frame([0.25, -0.75]), [0.25, -0.75]);
}

#[test]
fn repeating_settings_across_block_boundaries_keeps_dsp_state_continuous() {
    let input: Vec<_> = (0..10_000)
        .map(|i| {
            let phase = i as f32 * 0.05;
            [0.25 * phase.sin(), 0.2 * phase.cos()]
        })
        .collect();
    let mut continuous = reverb(active_settings());
    let mut chunked = reverb(active_settings());
    let updated = ReverbSettings {
        intensity: 0.3,
        high_pass_hz: 350.0,
        low_pass_hz: 11_450.0,
    };

    let mut wet_audible = false;
    for (segment, settings) in [
        (&input[..3900], active_settings()),
        (&input[3900..], updated),
    ] {
        continuous.set_settings(settings);
        for chunk in segment.chunks(127) {
            chunked.set_settings(settings);
            for &pcm in chunk {
                let expected = continuous.process_frame(pcm);
                wet_audible |= expected != pcm;
                assert_eq!(expected, chunked.process_frame(pcm));
            }
        }
    }
    assert!(wet_audible);
}

#[test]
fn intensity_changes_ramp_from_the_current_level_and_end_at_dry() {
    let mut held = reverb(active_settings());
    let mut changed = reverb(active_settings());
    for i in 0..RATE {
        let dry = [(i as f32 * 0.05).sin() * 0.4; 2];
        assert_eq!(held.process_frame(dry), changed.process_frame(dry));
    }

    changed.set_settings(ReverbSettings::default());
    let baseline = held.process_frame([0.0; 2]);
    let first = changed.process_frame([0.0; 2]);
    assert!(baseline.iter().any(|sample| sample.abs() > 0.001));
    for (original, faded) in baseline.into_iter().zip(first) {
        assert!((original - faded).abs() <= 0.0011 * original.abs());
    }
    for _ in 0..(RATE / 100) {
        let dry = [0.125; 2];
        held.process_frame(dry);
        changed.process_frame(dry);
    }

    let resumed = ReverbSettings {
        intensity: 0.75,
        ..active_settings()
    };
    let before = changed.process_frame([0.0; 2]);
    changed.set_settings(resumed);
    let after = changed.process_frame([0.0; 2]);
    assert!((after[0] - before[0]).abs() < 0.02);

    changed.set_settings(ReverbSettings::default());
    for _ in 0..(RATE / 50) {
        changed.process_frame([0.125; 2]);
    }
    for _ in 0..1024 {
        assert_eq!(changed.process_frame([0.25, -0.75]), [0.25, -0.75]);
    }
    changed.set_settings(active_settings());
    for _ in 0..8192 {
        assert_eq!(changed.process_frame([0.0; 2]), [0.0; 2]);
    }
}

#[test]
fn cutoff_changes_do_not_extend_a_wet_fade_out() {
    let mut mixer = reverb(active_settings());
    for i in 0..RATE {
        mixer.process_frame([(i as f32 * 0.05).sin() * 0.4; 2]);
    }

    let dry = ReverbSettings::default();
    mixer.set_settings(dry);
    let half_ramp_frames = RATE / 100;
    for _ in 1..half_ramp_frames {
        mixer.process_frame([0.0; 2]);
    }
    assert_ne!(mixer.process_frame([0.0; 2]), [0.0; 2]);

    mixer.set_settings(ReverbSettings {
        low_pass_hz: dry.low_pass_hz + 1.0,
        ..dry
    });
    for _ in 1..half_ramp_frames {
        mixer.process_frame([0.0; 2]);
    }
    assert_eq!(mixer.process_frame([0.0; 2]), [0.0; 2]);
}

#[test]
fn reset_clears_tank_and_filters_and_keeps_current_settings() {
    let settings = ReverbSettings {
        intensity: 0.7,
        high_pass_hz: 300.0,
        low_pass_hz: 4500.0,
    };
    let mut reset = reverb(settings);
    for i in 0..4096 {
        reset.process_frame([(i as f32 * 0.25).sin(); 2]);
    }
    reset.reset();
    let mut fresh = reverb(settings);
    fresh.reset();
    let mut tail_audible = false;
    for i in 0..8192 {
        let pcm = if i == 0 { [0.25; 2] } else { [0.0; 2] };
        let expected = fresh.process_frame(pcm);
        tail_audible |= expected != pcm;
        assert_eq!(reset.process_frame(pcm), expected);
    }
    assert!(tail_audible);
}

#[test]
fn overload_and_invalid_pcm_never_escape_the_output_rails() {
    let mut reverb = reverb(active_settings());
    let mut wet_audible = false;
    for i in 0..RATE {
        let dry = [
            (i as f32 * 0.065).sin() * 3.0,
            (i as f32 * 0.09).cos() * 3.0,
        ];
        let dry = match i % 127 {
            0 => [f32::NAN, f32::INFINITY],
            1 => [f32::MAX, -f32::MAX],
            _ => dry,
        };
        for (output, input) in reverb.process_frame(dry).into_iter().zip(dry) {
            assert!(output.is_finite() && output.abs() <= 1.0, "{output}");
            wet_audible |= input.abs() < 1.0 && (output - input).abs() > 0.01;
        }
    }
    assert!(wet_audible);
}

#[test]
fn invalid_controls_fall_back_to_defaults_and_low_sample_rates_are_safe() {
    let mut invalid = reverb(ReverbSettings {
        intensity: f32::INFINITY,
        high_pass_hz: f32::NAN,
        low_pass_hz: f32::NEG_INFINITY,
    });
    assert_eq!(invalid.process_frame([0.25, -0.75]), [0.25, -0.75]);
    invalid.set_settings(ReverbSettings {
        intensity: 1.0,
        high_pass_hz: f32::NAN,
        low_pass_hz: f32::NEG_INFINITY,
    });
    let mut defaults = reverb(active_settings());
    for i in 0..8192 {
        let pcm = [(i as f32 * 0.05).sin() * 0.25; 2];
        assert_eq!(invalid.process_frame(pcm), defaults.process_frame(pcm));
    }

    let mut low_rate = StereoReverb::new(1000);
    low_rate.set_settings(ReverbSettings {
        high_pass_hz: 1000.0,
        low_pass_hz: 20_000.0,
        ..active_settings()
    });
    for i in 0..8192 {
        let pcm = [(i as f32 * 0.25).sin(); 2];
        assert_eq!(low_rate.process_frame(pcm), pcm);
    }
}
