use pear_preview_dsp::{Dattorro, DattorroParams};
use std::{env, path::Path, process::Command};

const STEP_FRAMES: usize = 16_384;
const INTENSITIES: [f64; 7] = [0.0, 0.05, 0.35, 0.4, 0.0, 0.5, 1.0];
const PARTITIONS: [usize; 4] = [1, 17, 128, 511];
// Each frame has L/R input followed by L/R worklet output.
const FRAME_BYTES: usize = 4 * size_of::<f32>();

fn assert_worklet_parity(rate: u32, mix: &str) {
    let oracle = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/worklet-oracle.mjs");
    let node = env::var_os("PEAR_DSP_NODE").unwrap_or_else(|| "node".into());
    let output = Command::new(node)
        .arg(oracle)
        .arg(rate.to_string())
        .arg(STEP_FRAMES.to_string())
        .arg(mix)
        .args(INTENSITIES.map(|intensity| intensity.to_string()))
        .output()
        .expect("run the worklet oracle with Node 24 on PATH or set PEAR_DSP_NODE");
    assert!(
        output.status.success(),
        "worklet oracle failed (use Node 24): {}",
        String::from_utf8_lossy(&output.stderr)
    );

    assert_eq!(
        output.stdout.len(),
        INTENSITIES.len() * STEP_FRAMES * FRAME_BYTES
    );

    let mut tank = Dattorro::new(rate);
    for (step, intensity) in INTENSITIES.into_iter().enumerate() {
        let mut params = DattorroParams::from_intensity(intensity);
        if mix == "binary" && params.wet_gain > 0.0 {
            params.wet_gain = 1.0;
        }
        tank.set_params(params);

        let mut channels = std::array::from_fn(|_| Vec::with_capacity(STEP_FRAMES));
        let start = step * STEP_FRAMES * FRAME_BYTES;
        let end = start + STEP_FRAMES * FRAME_BYTES;
        let (frames, _) = output.stdout[start..end].as_chunks::<FRAME_BYTES>();
        for frame in frames {
            let (samples, _) = frame.as_chunks::<{ size_of::<f32>() }>();
            for (channel, &bytes) in channels.iter_mut().zip(samples) {
                channel.push(f32::from_le_bytes(bytes));
            }
        }

        let [left, right, expected_left, expected_right] = channels;
        let mut wet_left = vec![0.0; STEP_FRAMES];
        let mut wet_right = vec![0.0; STEP_FRAMES];
        let mut from = 0;
        for size in PARTITIONS.into_iter().cycle() {
            let to = (from + size).min(STEP_FRAMES);
            tank.process(
                &left[from..to],
                Some(&right[from..to]),
                &mut wet_left[from..to],
                &mut wet_right[from..to],
            );
            if to == STEP_FRAMES {
                break;
            }
            from = to;
        }

        for (channel, (actual, expected)) in
            [(wet_left, expected_left), (wet_right, expected_right)]
                .into_iter()
                .enumerate()
        {
            // Ensure that each engaged comparison exercises real audio.
            if intensity > 0.0 {
                assert!(expected.iter().any(|sample| sample.abs() > 1e-6));
            }
            for (frame, (actual, expected)) in actual.into_iter().zip(expected).enumerate() {
                // JS and Rust pow implementations can round parameters differently.
                let tolerance = 1e-9 + 1e-6 * expected.abs();
                assert!(
                    (actual - expected).abs() <= tolerance,
                    "{rate} Hz {mix} step {step} ({intensity}) channel {channel} frame {frame}: \
                     got {actual}, expected {expected}, tolerance {tolerance}"
                );
            }
        }
    }
}

#[test]
fn checked_in_worklet_matches_rust_at_four_sample_rates_and_mixed_block_sizes() {
    for rate in [8_000, 44_100, 48_000, 96_000] {
        for mix in ["binary", "curve"] {
            assert_worklet_parity(rate, mix);
        }
    }
}
