use super::*;

#[test]
fn excited_stereo_tank_returns_distinct_taps_after_predelay() {
    let mut tank = Dattorro::new(48_000);
    let mut params = DattorroParams::from_intensity(1.0);
    params.wet_gain = 1.0;
    tank.set_params(params);
    let mut impulse = vec![0.0; 4_096];
    impulse[0] = 1.0;
    let mut left = vec![0.0; impulse.len()];
    let mut right = vec![0.0; impulse.len()];
    tank.process(&impulse, None, &mut left, &mut right);

    assert_eq!(left.iter().position(|&sample| sample != 0.0), Some(2857));
    assert_eq!(right.iter().position(|&sample| sample != 0.0), Some(2944));
}

fn render(tank: &mut Dattorro, left: &[f32], right: Option<&[f32]>) -> [Vec<f32>; 2] {
    let mut output_left = vec![0.0; left.len()];
    let mut output_right = vec![0.0; left.len()];
    tank.process(left, right, &mut output_left, &mut output_right);
    [output_left, output_right]
}

fn engaged_tank() -> Dattorro {
    let mut tank = Dattorro::new(48_000);
    tank.set_params(DattorroParams::from_intensity(1.0));
    tank
}

#[test]
fn zero_wet_gain_silences_and_freezes_a_pending_tail() {
    let mut uninterrupted = engaged_tank();
    let mut interrupted = engaged_tank();
    let mut signal = vec![0.0; 3_000];
    signal[0] = 1.0;
    render(&mut uninterrupted, &signal, None);
    render(&mut interrupted, &signal, None);

    interrupted.set_params(DattorroParams::from_intensity(0.0));
    let silent = render(&mut interrupted, &[1.0; 4_096], None);
    assert!(silent.iter().flatten().all(|&sample| sample == 0.0));
    interrupted.set_params(DattorroParams::from_intensity(1.0));

    let tail = render(&mut uninterrupted, &[0.0; 4_096], None);
    assert!(tail.iter().flatten().any(|&sample| sample != 0.0));
    assert_eq!(render(&mut interrupted, &[0.0; 4_096], None), tail);
}

#[test]
fn reset_clears_delays_and_restores_a_silent_default() {
    let mut tank = engaged_tank();
    render(&mut tank, &[1.0; 3_000], None);
    tank.reset();
    let silent = render(&mut tank, &[1.0; 4_096], None);
    assert!(silent.iter().flatten().all(|&sample| sample == 0.0));

    tank.set_params(DattorroParams::from_intensity(1.0));
    let silence = render(&mut tank, &[0.0; 8_192], None);
    assert!(silence.iter().flatten().all(|&sample| sample == 0.0));

    tank.reset();
    tank.set_params(DattorroParams::from_intensity(1.0));
    assert_eq!(
        render(&mut tank, &[0.25; 8_192], None),
        render(&mut engaged_tank(), &[0.25; 8_192], None)
    );
}

#[test]
fn mono_is_duplicated_and_nonfinite_or_out_of_range_pcm_is_sanitized() {
    let mut input = vec![0.0; 8_192];
    input[..6].copy_from_slice(&[2.0, -2.0, f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.75]);
    let mut clean = vec![0.0; 8_192];
    clean[..6].copy_from_slice(&[1.0, -1.0, 0.0, 0.0, 0.0, 0.75]);
    let actual = render(&mut engaged_tank(), &input, None);
    let expected = render(&mut engaged_tank(), &clean, Some(&clean));

    assert!(expected.iter().flatten().any(|&sample| sample != 0.0));
    assert_eq!(actual, expected);
}

#[test]
fn absent_input_leaves_outputs_and_pending_tail_unchanged() {
    let mut uninterrupted = engaged_tank();
    let mut interrupted = engaged_tank();
    render(&mut uninterrupted, &[0.5; 3_000], None);
    render(&mut interrupted, &[0.5; 3_000], None);

    let mut left = [1.0; 128];
    let mut right = [-1.0; 128];
    interrupted.process(&[], None, &mut left, &mut right);
    assert_eq!(left, [1.0; 128]);
    assert_eq!(right, [-1.0; 128]);
    let tail = render(&mut uninterrupted, &[0.0; 4_096], None);
    assert!(tail.iter().flatten().any(|&sample| sample != 0.0));
    assert_eq!(render(&mut interrupted, &[0.0; 4_096], None), tail);
}

#[test]
fn nonfinite_intensities_are_silent_and_finite_values_clamp() {
    let input = [0.25; 4_096];
    let full_intensity = render(&mut engaged_tank(), &input, None);
    assert!(full_intensity.iter().flatten().any(|&sample| sample != 0.0));

    for intensity in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.1] {
        let params = DattorroParams::from_intensity(intensity);
        assert_eq!(params.wet_gain, 0.0, "intensity {intensity}");
        let mut tank = Dattorro::new(48_000);
        tank.set_params(params);
        let mut left = [1.0; 4_096];
        let mut right = [-1.0; 4_096];
        tank.process(&input, None, &mut left, &mut right);
        assert_eq!(left, [0.0; 4_096]);
        assert_eq!(right, [0.0; 4_096]);
    }

    let mut over_maximum = Dattorro::new(48_000);
    over_maximum.set_params(DattorroParams::from_intensity(2.0));
    assert_eq!(render(&mut over_maximum, &input, None), full_intensity);
}
