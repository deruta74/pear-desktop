use std::{
    fs,
    io::Cursor,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

use super::*;

struct Fixture(PathBuf);

impl Fixture {
    fn from_bytes(bytes: &[u8]) -> Self {
        static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

        let path = std::env::temp_dir().join(format!(
            "pear-local-audio-{}-{}.wav",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        std::io::Write::write_all(&mut file, bytes).unwrap();
        Self(path)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn wav_fixture<S: hound::Sample + Copy>(spec: hound::WavSpec, samples: &[S]) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut writer = hound::WavWriter::new(Cursor::new(&mut bytes), spec).unwrap();
    for sample in samples {
        writer.write_sample(*sample).unwrap();
    }
    writer.finalize().unwrap();
    bytes
}

const MONO_I16: hound::WavSpec = hound::WavSpec {
    channels: 1,
    sample_rate: 8_000,
    bits_per_sample: 16,
    sample_format: hound::SampleFormat::Int,
};

#[test]
fn decodes_mono_pcm_as_stereo_and_seeks_by_frame() {
    let fixture = Fixture::from_bytes(&wav_fixture(MONO_I16, &[0i16, i16::MIN, 16_384]));
    let mut wav = WavSource::open(&fixture.0).unwrap();

    assert_eq!(wav.info().frames, 3);
    assert_eq!(wav.info().sample_rate, 8_000);
    assert_eq!(wav.read_frame().unwrap(), [0.0, 0.0]);
    wav.seek_to(2).unwrap();
    assert_eq!(wav.read_frame().unwrap(), [0.5, 0.5]);
    wav.seek_to(1).unwrap();
    assert_eq!(wav.read_frame().unwrap(), [-1.0, -1.0]);
}

#[test]
fn retains_distinct_float_channels_and_sanitizes_nonfinite_samples() {
    let spec = hound::WavSpec {
        channels: 2,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
        ..MONO_I16
    };
    let fixture = Fixture::from_bytes(&wav_fixture(spec, &[0.25f32, -0.5, f32::NAN, 2.0]));
    let mut wav = WavSource::open(&fixture.0).unwrap();

    assert_eq!(wav.read_frame().unwrap(), [0.25, -0.5]);
    assert_eq!(wav.read_frame().unwrap(), [0.0, 1.0]);
}

#[test]
fn normalizes_eight_and_twenty_four_bit_pcm() {
    let spec = hound::WavSpec {
        bits_per_sample: 8,
        ..MONO_I16
    };
    let fixture = Fixture::from_bytes(&wav_fixture(spec, &[-128i8, 64]));
    let mut wav = WavSource::open(&fixture.0).unwrap();
    assert_eq!(wav.read_frame().unwrap(), [-1.0; 2]);
    assert_eq!(wav.read_frame().unwrap(), [0.5; 2]);

    let spec = hound::WavSpec {
        bits_per_sample: 24,
        ..MONO_I16
    };
    let fixture = Fixture::from_bytes(&wav_fixture(spec, &[-8_388_608i32, 4_194_304]));
    let mut wav = WavSource::open(&fixture.0).unwrap();
    assert_eq!(wav.read_frame().unwrap(), [-1.0; 2]);
    assert_eq!(wav.read_frame().unwrap(), [0.5; 2]);
}

#[test]
fn decodes_sixty_four_bit_float() {
    let header = b"RIFF\x34\0\0\0WAVE\
                   fmt \x10\0\0\0\x03\0\x02\0\x40\x1f\0\0\0\xf4\x01\0\x10\0\x40\0\
                   data\x10\0\0\0";
    let mut bytes = header.to_vec();
    bytes.extend_from_slice(&(-0.25f64).to_le_bytes());
    bytes.extend_from_slice(&0.75f64.to_le_bytes());
    let fixture = Fixture::from_bytes(&bytes);
    let mut wav = WavSource::open(&fixture.0).unwrap();

    assert_eq!(wav.read_frame().unwrap(), [-0.25, 0.75]);
}

#[test]
fn rejects_a_truncated_wav_and_a_directory() {
    let mut truncated = wav_fixture(MONO_I16, &[0i16, 1]);
    truncated.pop();
    let fixture = Fixture::from_bytes(&truncated);

    assert!(matches!(
        WavSource::open(&fixture.0),
        Err(EngineOpenError::UnsupportedWav)
    ));
    assert!(matches!(
        WavSource::open(&std::env::temp_dir()),
        Err(EngineOpenError::UnavailableWav)
    ));
}

#[test]
fn seeks_past_an_odd_sized_metadata_chunk() {
    let mut bytes = wav_fixture(MONO_I16, &[16_384i16]);
    bytes.splice(12..12, *b"JUNK\x01\0\0\0x\0");
    let size = (bytes.len() - 8) as u32;
    bytes[4..8].copy_from_slice(&size.to_le_bytes());
    let fixture = Fixture::from_bytes(&bytes);

    assert_eq!(
        WavSource::open(&fixture.0).unwrap().read_frame().unwrap(),
        [0.5, 0.5]
    );
}

#[test]
fn pause_holds_position_and_resume_uses_the_same_source_frame() {
    let (shared, mut queue, mut render) = setup(3, 8_000, 8_000);
    enqueue(&mut queue, 0, &[[0.25, -0.25], [0.5, -0.5], [0.75, -0.75]]);
    let mut output = [9.0f32; 2];

    render.fill(&mut output, 2);
    assert_eq!(output, [0.0, 0.0]);
    assert_eq!(shared.frame(), 0);

    shared.playing.store(true, Ordering::Release);
    render.fill(&mut output, 2);
    assert_eq!(output, [0.25, -0.25]);
    assert_eq!(shared.frame(), 1);

    shared.playing.store(false, Ordering::Release);
    render.fill(&mut output, 2);
    assert_eq!(output, [0.0, 0.0]);
    assert_eq!(shared.frame(), 1);

    shared.playing.store(true, Ordering::Release);
    render.fill(&mut output, 2);
    assert_eq!(output, [0.5, -0.5]);
    assert_eq!(shared.frame(), 2);
}

#[test]
fn resampling_speed_volume_and_end_track_source_frames() {
    let (shared, mut queue, mut render) = setup(3, 8_000, 16_000);
    enqueue(&mut queue, 0, &[[0.0, 0.0], [0.5, -0.5], [1.0, -1.0]]);
    shared.playing.store(true, Ordering::Release);
    shared.volume.store(0.5f32.to_bits(), Ordering::Relaxed);

    let mut output = [9.0f32; 4];
    render.fill(&mut output, 2);
    assert_eq!(output, [0.0, 0.0, 0.125, -0.125]);
    assert_eq!(shared.frame(), 1);

    shared.speed.store(2.0f32.to_bits(), Ordering::Relaxed);
    render.fill(&mut output, 2);
    assert_eq!(output, [0.25, -0.25, 0.5, -0.5]);
    assert_eq!(shared.frame(), 3);

    render.fill(&mut output, 2);
    assert_eq!(output, [0.0; 4]);
    assert_eq!(shared.frame(), 3);
}

#[test]
fn rapid_seeks_discard_stale_frames_and_underruns_hold_position() {
    let (shared, mut queue, mut render) = setup(12, 8_000, 8_000);
    enqueue(&mut queue, 0, &[[0.25, 0.25]; 2]);
    shared.playing.store(true, Ordering::Release);
    let first = shared.seek_to(10);
    enqueue(&mut queue, first, &[[0.5, 0.5]; 2]);
    let second = shared.seek_to(6);
    let mut output = [9.0f32; 2];

    render.fill(&mut output, 2);
    assert_eq!(output, [0.0, 0.0]);
    assert_eq!(shared.frame(), 6);

    enqueue(&mut queue, second, &[[0.75, -0.75]]);
    render.fill(&mut output, 2);
    assert_eq!(output, [0.75, -0.75]);
    assert_eq!(shared.frame(), 7);
}

#[test]
fn output_underrun_allows_playback_to_continue_and_invalidated_stream_stops_it() {
    let (shared, mut queue, mut render) = setup(3, 8_000, 8_000);
    enqueue(&mut queue, 0, &[[0.25, -0.25]; 3]);
    shared.playing.store(true, Ordering::Release);
    let mut output = [0.0f32; 2];

    shared.report_stream_error(cpal::StreamError::BufferUnderrun);
    render.fill(&mut output, 2);
    assert_eq!(output, [0.25, -0.25]);
    assert_eq!(shared.frame(), 1);

    shared.report_stream_error(cpal::StreamError::StreamInvalidated);
    shared.report_stream_error(cpal::StreamError::BufferUnderrun);
    render.fill(&mut output, 2);
    assert_eq!(output, [0.0; 2]);
    assert_eq!(shared.error.load(Ordering::Acquire), OUTPUT_ERROR);
    assert_eq!(shared.frame(), 1);
}

#[test]
fn wet_output_adds_a_tail_and_seek_clears_it() {
    let (shared, mut queue, mut render) = setup(4_096, 8_000, 8_000);
    shared.reverb.set(ReverbSettings {
        intensity: 0.8,
        ..ReverbSettings::default()
    });
    shared.playing.store(true, Ordering::Release);

    let mut chunk = [[0.0; 2]; 32];
    chunk[0] = [0.75; 2];
    enqueue(&mut queue, 0, &chunk);
    let mut output = [0.0f32; 64];
    render.fill(&mut output, 2);

    let mut heard_tail = false;
    for _ in 0..63 {
        enqueue(&mut queue, 0, &[[0.0; 2]; 32]);
        render.fill(&mut output, 2);
        heard_tail |= output.iter().any(|sample| sample.abs() > 0.0001);
    }
    assert!(heard_tail, "no wet signal followed the impulse");

    let generation = shared.seek_to(1_000);
    for _ in 0..8 {
        enqueue(&mut queue, generation, &[[0.0; 2]; 32]);
        render.fill(&mut output, 2);
        assert_eq!(output, [0.0; 64]);
    }
}

#[test]
fn wet_tail_continues_after_an_impulse_at_eof_and_is_bounded() {
    let (shared, mut queue, mut render) = setup(1, 8_000, 8_000);
    shared.reverb.set(ReverbSettings {
        intensity: 0.8,
        ..ReverbSettings::default()
    });
    shared.playing.store(true, Ordering::Release);
    enqueue(&mut queue, 0, &[[0.75; 2]]);
    render.fill(&mut [0.0f32; 2], 2);
    assert_eq!(shared.frame(), 1);
    assert_eq!(
        shared.status(1),
        (1, true),
        "the local player must offer Pause during the wet tail"
    );

    let mut output = [0.0f32; 256];
    let mut heard_tail = false;
    for _ in 0..64 {
        render.fill(&mut output, 2);
        heard_tail |= output.iter().any(|sample| sample.abs() > 0.0001);
        assert_eq!(shared.frame(), 1);
    }
    assert!(heard_tail, "no wet signal followed the final source frame");

    for _ in 0..124 {
        render.fill(&mut output, 2);
    }
    render.fill(&mut output, 2);
    assert_eq!(output, [0.0; 256]);
    assert_eq!(shared.frame(), 1);
    assert_eq!(shared.status(1), (1, false));
}

#[test]
fn pause_silences_eof_tail_and_replay_starts_with_a_clean_reverb() {
    let (shared, mut queue, mut render) = setup(1, 8_000, 8_000);
    shared.reverb.set(ReverbSettings {
        intensity: 0.8,
        ..ReverbSettings::default()
    });
    shared.playing.store(true, Ordering::Release);
    enqueue(&mut queue, 0, &[[0.75; 2]]);
    render.fill(&mut [0.0f32; 2], 2);

    let mut output = [0.0f32; 256];
    let mut heard_tail = false;
    for _ in 0..64 {
        render.fill(&mut output, 2);
        if output.iter().any(|sample| sample.abs() > 0.0001) {
            heard_tail = true;
            break;
        }
    }
    assert!(heard_tail, "no wet signal was present before pause");

    shared.playing.store(false, Ordering::Release);
    render.fill(&mut output, 2);
    assert_eq!(output, [0.0; 256]);
    let generation = shared.seek_to(0);
    enqueue(&mut queue, generation, &[[0.0; 2]]);
    shared.playing.store(true, Ordering::Release);
    for _ in 0..64 {
        render.fill(&mut output, 2);
        assert_eq!(output, [0.0; 256]);
    }
    assert_eq!(shared.frame(), 1);
}

#[test]
fn eq_only_tail_survives_eof_but_is_reset_when_replaying() {
    use pear_preview_dsp::equalizer::{EqualizerBand, EqualizerSettings, StereoEqualizer};
    let shared = Arc::new(Shared::new());
    let (mut queue, consumer) = RingBuffer::new(32);
    let (mut updates, tone) = super::eq::Updates::new(8_000);
    let mut render = Render::new(
        consumer,
        Arc::clone(&shared),
        WavInfo {
            frames: 1,
            sample_rate: 8_000,
        },
        8_000,
        tone,
    );
    updates.replace(Some(
        StereoEqualizer::new(
            8_000,
            EqualizerSettings {
                bands: &[EqualizerBand {
                    frequency_hz: 100.0,
                    gain_db: 18.0,
                    q: 16.0,
                }],
                ..EqualizerSettings::default()
            },
            1.0,
        )
        .unwrap(),
    ));
    let mut output = [0.0f32; 64];
    render.fill(&mut output, 2); // Install the profile while paused.
    enqueue(&mut queue, 0, &[[0.5, -0.5]]);
    shared.playing.store(true, Ordering::Release);
    render.fill(&mut output, 2);
    assert!(output[2..].iter().any(|sample| sample.abs() > 0.0001));
    assert_eq!(shared.status(1), (1, true));
    let generation = shared.seek_to(0);
    enqueue(&mut queue, generation, &[[0.0, 0.0]]);
    render.fill(&mut output, 2);
    assert_eq!(output, [0.0; 64]);
}

#[test]
fn decode_worker_keeps_streaming_and_seeks_after_eof() {
    let fixture = Fixture::from_bytes(&wav_fixture(MONO_I16, &[0i16, 8_192, 16_384]));
    let wav = WavSource::open(&fixture.0).unwrap();
    let shared = Arc::new(Shared::new());
    shared.playing.store(true, Ordering::Release);
    let (queue, mut reader) = RingBuffer::new(2);
    let state = Arc::clone(&shared);
    let worker = std::thread::spawn(move || decode_stream(wav, queue, &state));

    let first = wait_for_frame(&mut reader);
    let second = wait_for_frame(&mut reader);
    let third = wait_for_frame(&mut reader);
    let generation = shared.seek_to(1);
    worker.thread().unpark();
    let seeked = wait_for_frame(&mut reader);
    shared.stopping.store(true, Ordering::Release);
    worker.thread().unpark();
    worker.join().unwrap();

    assert_eq!(first.pcm, [0.0; 2]);
    assert_eq!(second.pcm, [0.25; 2]);
    assert_eq!(third.pcm, [0.5; 2]);
    assert_eq!(seeked.generation, generation);
    assert_eq!(seeked.pcm, [0.25; 2]);
}

#[test]
#[ignore = "requires a configured default audio output and plays a synthetic tone"]
fn cpal_default_device_plays_synthetic_wav() {
    const SAMPLE_RATE: u32 = 48_000;
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: SAMPLE_RATE,
        ..MONO_I16
    };
    let samples: Vec<i16> = (0..SAMPLE_RATE * 2)
        .flat_map(|frame| {
            let time = f64::from(frame) / f64::from(SAMPLE_RATE);
            [440.0, 660.0].map(|frequency| {
                (3_200.0 * (std::f64::consts::TAU * frequency * time).sin()) as i16
            })
        })
        .collect();
    let fixture = Fixture::from_bytes(&wav_fixture(spec, &samples));
    let mut engine = Engine::open(&fixture.0).unwrap();
    let initial = engine.snapshot();
    assert_eq!(initial.position_ms, 0);
    assert_eq!(initial.duration_ms, 2_000);
    assert!(!initial.playing);

    engine.set_volume(0.5);
    engine.set_playing(true);
    let first_play = wait_for_snapshot(&mut engine, |snapshot| {
        snapshot.playing && snapshot.position_ms >= 180
    });
    engine.set_playing(false);
    std::thread::sleep(Duration::from_millis(120));
    let paused = engine.snapshot();
    std::thread::sleep(Duration::from_millis(120));
    assert_eq!(engine.snapshot().position_ms, paused.position_ms);
    assert!(!paused.playing);
    assert!(paused.position_ms >= first_play.position_ms);

    engine.seek_ms(1_000);
    assert_eq!(engine.snapshot().position_ms, 1_000);
    assert!(!engine.snapshot().playing);
    engine.set_speed(2.0);
    engine
        .set_equalizer(pear_preview_dsp::equalizer::EqualizerSettings {
            manual_preamp_db: 6.0,
            ..pear_preview_dsp::equalizer::EqualizerSettings::default()
        })
        .unwrap();
    engine.set_reverb(ReverbSettings {
        intensity: 0.7,
        high_pass_hz: 200.0,
        low_pass_hz: 5_500.0,
    });

    engine.set_playing(true);
    let during_effect = wait_for_snapshot(&mut engine, |snapshot| {
        snapshot.playing && snapshot.position_ms >= 1_300
    });
    let ended = wait_for_snapshot(&mut engine, |snapshot| !snapshot.playing);
    assert_eq!(ended.position_ms, ended.duration_ms);

    engine.set_speed(1.0);
    engine.set_playing(true);
    let replay = wait_for_snapshot(&mut engine, |snapshot| {
        snapshot.playing && (100..1_000).contains(&snapshot.position_ms)
    });
    engine.set_playing(false);
    println!(
        "CPAL synthetic WAV positions in ms: first play {}, paused {}, effect {}, ended {}, replay {}",
        first_play.position_ms,
        paused.position_ms,
        during_effect.position_ms,
        ended.position_ms,
        replay.position_ms,
    );
}

fn wait_for_snapshot(engine: &mut Engine, check: impl Fn(&Snapshot) -> bool) -> Snapshot {
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.error, None);
        if check(&snapshot) {
            return snapshot;
        }
        assert!(
            Instant::now() < deadline,
            "audio state did not advance as expected at {} ms (playing: {})",
            snapshot.position_ms,
            snapshot.playing,
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn setup(
    frames: u32,
    sample_rate: u32,
    output_rate: u32,
) -> (Arc<Shared>, Producer<QueuedFrame>, Render) {
    let shared = Arc::new(Shared::new());
    let (producer, consumer) = RingBuffer::new(32);
    let (_updates, tone) = super::eq::Updates::new(output_rate);
    let render = Render::new(
        consumer,
        Arc::clone(&shared),
        WavInfo {
            frames,
            sample_rate,
        },
        output_rate,
        tone,
    );
    (shared, producer, render)
}

fn enqueue(queue: &mut Producer<QueuedFrame>, generation: u32, frames: &[[f32; 2]]) {
    for &pcm in frames {
        assert!(queue.push(QueuedFrame { generation, pcm }).is_ok());
    }
}

fn wait_for_frame(reader: &mut rtrb::Consumer<QueuedFrame>) -> QueuedFrame {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(frame) = reader.pop() {
            return frame;
        }
        assert!(Instant::now() < deadline, "decoder did not provide a frame");
        std::thread::sleep(Duration::from_millis(1));
    }
}
