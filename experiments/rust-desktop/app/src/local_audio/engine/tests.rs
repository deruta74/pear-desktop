use std::{
    fs,
    io::{Cursor, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

use super::*;

struct Fixture(PathBuf);

impl Fixture {
    fn from_bytes(bytes: &[u8]) -> Self {
        Self::with_extension(bytes, "wav")
    }

    fn with_extension(bytes: &[u8], extension: &str) -> Self {
        static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

        let path = std::env::temp_dir().join(format!(
            "pear-local-audio-{}-{}.{extension}",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        file.write_all(bytes).unwrap();
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
fn defers_natural_end_while_another_file_is_opening() {
    let shared = Shared::new();
    shared.playing.store(true, Ordering::Release);
    shared.publish_frame(0, 4, true);
    assert!(!shared.take_end(0, !shared.status(4).1, false));
    shared.publish_frame(0, 4, false);
    assert!(!shared.take_end(0, !shared.status(4).1, true));
    assert!(shared.take_end(0, !shared.status(4).1, false));
    assert!(!shared.take_end(0, !shared.status(4).1, false));
}

#[test]
fn only_a_decoding_failure_can_advance_a_playing_track() {
    let shared = Shared::new();
    assert!(!shared.take_end(DECODE_ERROR, false, false));
    shared.playing.store(true, Ordering::Release);
    assert!(!shared.take_end(OUTPUT_ERROR, true, false));
    assert!(!shared.take_end(DECODE_ERROR, false, true));
    assert!(shared.take_end(DECODE_ERROR, false, false));
    assert!(!shared.take_end(DECODE_ERROR, false, false));
}

#[test]
fn ogg_opus_preskip_can_cross_packet_boundaries() {
    // A 37 ms mono libopus encode with OpusHead pre-skip set to 1,001 frames.
    let media = include_bytes!("fixtures/mono-preskip.opus");
    let fixture = Fixture::with_extension(media, "opus");
    let mut source = AudioSource::open(&fixture.0).unwrap();
    assert_eq!(source.info().sample_rate, 48_000);
    assert_eq!(source.info().frames, 1_087);
    for index in 0..1_087 {
        let frame = source.read_frame().unwrap();
        assert_eq!(frame[0], frame[1]);
        match index {
            0 => assert_opus_frame(frame, [0.075_286_865; 2]),
            43 => assert_opus_frame(frame, [-0.063_842_77; 2]),
            1_086 => assert_opus_frame(frame, [-0.006_500_244; 2]),
            _ => (),
        }
    }
    assert_eq!(
        source.read_frame().unwrap_err().kind(),
        std::io::ErrorKind::UnexpectedEof
    );
    source.seek_to(0).unwrap();
    assert_opus_frame(source.read_frame().unwrap(), [0.075_286_865; 2]);
}

#[test]
fn ogg_opus_seeks_to_sequential_samples_through_the_padded_final_page() {
    // A 5.975 s stereo libopus encode with large pages that exercise Ogg bisection.
    let media = include_bytes!("fixtures/stereo-tail-page.ogg");
    let fixture = Fixture::with_extension(media, "ogg");
    let mut source = AudioSource::open(&fixture.0).unwrap();
    assert_eq!(source.info().sample_rate, 48_000);
    assert_eq!(source.info().frames, 286_800);
    let frames: Vec<_> = (0..source.info().frames)
        .map(|_| source.read_frame().unwrap())
        .collect();
    assert_opus_frame(frames[43], [0.239_135_74, 0.066_040_04]);
    assert_opus_frame(frames[286_799], [-0.157_012_94, -0.180_236_82]);
    assert_eq!(
        source.read_frame().unwrap_err().kind(),
        std::io::ErrorKind::UnexpectedEof
    );
    for index in [67_560, 0, 285_789, 143_400, 286_799, 1] {
        source.seek_to(index).unwrap();
        let start = index as usize;
        for &expected in &frames[start..(start + 512).min(frames.len())] {
            assert_opus_frame(source.read_frame().unwrap(), expected);
        }
    }
    source.seek_to(286_800).unwrap();
    assert_eq!(
        source.read_frame().unwrap_err().kind(),
        std::io::ErrorKind::UnexpectedEof
    );
}

#[test]
fn ogg_opus_accepts_code_three_packets_with_more_than_31_frames() {
    // One packet with forty 2.5 ms CELT frames, minus 120 samples of pre-skip.
    check_short_ogg_opus(
        include_bytes!("fixtures/forty-frames.opus"),
        4_680,
        [0.004_302_978_5, 0.120_513_916],
    );
}

#[test]
fn ogg_opus_honors_the_initial_granule_of_a_single_audio_page() {
    // The last granule is shifted by ten seconds. This page has no earlier audio granule.
    check_short_ogg_opus(
        include_bytes!("fixtures/offset-single-page.opus"),
        1_879,
        [0.075_286_865, -0.000_549_316_4],
    );
}

#[test]
fn ogg_opus_accepts_comment_headers_that_span_two_pages() {
    // The OpusTags header begins on a page with granule -1 and completes at granule 0.
    check_short_ogg_opus(
        include_bytes!("fixtures/split-opus-tags.opus"),
        1_087,
        [0.075_286_865, -0.006_500_244],
    );
}

fn check_short_ogg_opus(media: &[u8], frames: u32, [first, last]: [f32; 2]) {
    let fixture = Fixture::with_extension(media, "opus");
    let mut source = AudioSource::open(&fixture.0).unwrap();
    assert_eq!(source.info().frames, frames);
    let sequential: Vec<_> = (0..frames).map(|_| source.read_frame().unwrap()).collect();
    // The endpoint PCM comes from the reference libopus decoder.
    assert_opus_frame(sequential[0], [first; 2]);
    assert_opus_frame(sequential[frames as usize - 1], [last; 2]);
    assert_eq!(
        source.read_frame().unwrap_err().kind(),
        std::io::ErrorKind::UnexpectedEof
    );
    for index in [frames - 1, 0, frames / 3, 1] {
        source.seek_to(index).unwrap();
        assert_opus_frame(source.read_frame().unwrap(), sequential[index as usize]);
    }
}

#[test]
fn ogg_opus_rejects_invalid_inputs_and_other_ogg_codecs() {
    let opus = include_bytes!("fixtures/mono-preskip.opus");
    let vorbis = include_bytes!("fixtures/reject-vorbis.ogg");
    for bytes in [&b"OggSbad header"[..], &opus[..opus.len() - 1], &vorbis[..]] {
        let fixture = Fixture::with_extension(bytes, "opus");
        assert!(matches!(
            AudioSource::open(&fixture.0),
            Err(EngineOpenError::UnsupportedAudio)
        ));
    }
}

#[test]
fn ogg_opus_rejects_a_chained_file_with_a_different_final_stream() {
    let mono = include_bytes!("fixtures/mono-preskip.opus");
    let stereo = include_bytes!("fixtures/stereo-tail-page.ogg");
    let chain = [&mono[..], &stereo[..]].concat();
    let fixture = Fixture::with_extension(&chain, "ogg");
    assert!(matches!(
        AudioSource::open(&fixture.0),
        Err(EngineOpenError::UnsupportedAudio)
    ));
}

#[test]
fn ogg_opus_bounds_resynchronization_on_a_large_gap() {
    let media = include_bytes!("fixtures/mono-preskip.opus");
    let audio_start = media
        .windows(4)
        .enumerate()
        .filter(|(_, header)| *header == b"OggS")
        .nth(2)
        .unwrap()
        .0;
    let fixture = Fixture::with_extension(&media[..audio_start], "opus");
    let mut file = fs::OpenOptions::new().write(true).open(&fixture.0).unwrap();
    file.seek(SeekFrom::End(20 * 1024 * 1024)).unwrap();
    file.write_all(&media[audio_start..]).unwrap();
    drop(file);
    assert!(matches!(
        AudioSource::open(&fixture.0),
        Err(EngineOpenError::UnsupportedAudio)
    ));
}

fn assert_opus_frame(actual: [f32; 2], expected: [f32; 2]) {
    for (actual, expected) in actual.into_iter().zip(expected) {
        assert!(
            (actual - expected).abs() < 0.000_075,
            "{actual} != {expected}"
        );
    }
}

#[test]
fn mp3_uses_gapless_duration_and_seeks_to_the_same_samples() {
    let fixture = Fixture::from_bytes(include_bytes!("fixtures/stereo-gapless.mp3"));
    let mut source = AudioSource::open(&fixture.0).unwrap();
    assert_eq!(source.info().sample_rate, 48_000);
    assert_eq!(source.info().frames, 28_800);
    let frames: Vec<_> = (0..source.info().frames)
        .map(|_| source.read_frame().unwrap())
        .collect();
    assert!(source.read_frame().is_err());
    assert!(
        frames
            .iter()
            .any(|[left, right]| (left - right).abs() > 0.05)
    );
    for index in [26_971, 0, 17_301, 28_799, 259] {
        source.seek_to(index).unwrap();
        let actual = source.read_frame().unwrap();
        for (actual, expected) in actual.into_iter().zip(frames[index as usize]) {
            assert!((actual - expected).abs() < 0.0001, "frame {index}");
        }
    }
    source.seek_to(source.info().frames).unwrap();
    assert!(source.read_frame().is_err());
}

#[test]
fn mp3_without_duration_counts_complete_frames_and_duplicates_mono() {
    let media = include_bytes!("fixtures/mono-untagged.mp3");
    for (media, packets) in [(&media[..], 12), (&media[..media.len() - 1], 11)] {
        let fixture = Fixture::from_bytes(media);
        let mut source = AudioSource::open(&fixture.0).unwrap();
        assert_eq!(source.info().sample_rate, 22_050);
        assert_eq!(source.info().frames, packets * 576);
        for _ in 0..packets * 576 {
            let [left, right] = source.read_frame().unwrap();
            assert_eq!(left, right);
        }
        assert!(source.read_frame().is_err());
        source.seek_to(packets * 576 - 1).unwrap();
        assert!(source.read_frame().is_ok());
    }
}

#[test]
fn mp3_without_xing_frame_count_still_trims_encoder_padding() {
    let mut media = include_bytes!("fixtures/stereo-gapless.mp3").to_vec();
    let xing = media.windows(4).position(|field| field == b"Xing").unwrap();
    // Keep the byte count, seek table, quality and encoder extension.
    assert_eq!(&media[xing + 4..xing + 8], &[0, 0, 0, 15]);
    media[xing + 7] &= !1;
    let end = xing + 156;
    media.copy_within(xing + 12..end, xing + 8);
    media[end - 4..end].fill(0);

    let fixture = Fixture::from_bytes(&media);
    let mut source = AudioSource::open(&fixture.0).unwrap();
    assert_eq!(source.info().frames, 28_800);
    source.seek_to(28_799).unwrap();
    assert!(source.read_frame().is_ok());
    assert!(source.read_frame().is_err());
}

#[test]
fn mp3_seek_rebuilds_the_reservoir_for_low_bitrate_stereo() {
    let fixture = Fixture::from_bytes(include_bytes!("fixtures/stereo-low-bitrate.mp3"));
    let mut source = AudioSource::open(&fixture.0).unwrap();
    assert_eq!(source.info().sample_rate, 24_000);
    let frames: Vec<_> = (0..source.info().frames)
        .map(|_| source.read_frame().unwrap())
        .collect();
    let start = 31_827;
    source.seek_to(start as u32).unwrap();
    for &expected in &frames[start..start + 2_048] {
        let actual = source.read_frame().unwrap();
        for (actual, expected) in actual.into_iter().zip(expected) {
            assert!((actual - expected).abs() < 0.0001);
        }
    }
}

#[test]
fn decodes_flac_packets_and_seeks_to_an_exact_frame() {
    // Four 192-frame blocks with different constant values in each channel.
    let fixture = Fixture::from_bytes(include_bytes!("fixtures/stereo.flac"));
    let mut source = AudioSource::open(&fixture.0).unwrap();
    assert_eq!(source.info().frames, 768);
    assert_eq!(source.info().sample_rate, 8_000);
    assert_eq!(source.read_frame().unwrap(), [0.125, -0.25]);
    source.seek_to(383).unwrap();
    assert_eq!(source.read_frame().unwrap(), [-0.5, 0.25]);
    assert_eq!(source.read_frame().unwrap(), [0.5, -0.25]);
    source.seek_to(767).unwrap();
    assert_eq!(source.read_frame().unwrap(), [0.0, 0.125]);
    assert!(source.read_frame().is_err());
    source.seek_to(768).unwrap();
    source.seek_to(0).unwrap();
    assert_eq!(source.read_frame().unwrap(), [0.125, -0.25]);
}

#[test]
fn seeks_within_a_large_unindexed_flac_packet() {
    let fixture = Fixture::from_bytes(include_bytes!("fixtures/unindexed.flac"));
    let mut source = AudioSource::open(&fixture.0).unwrap();
    let frames: Vec<_> = (0..source.info().frames)
        .map(|_| source.read_frame().unwrap())
        .collect();
    for index in [4607, 2304, 0] {
        source.seek_to(index).unwrap();
        assert_eq!(source.read_frame().unwrap(), frames[index as usize]);
    }
}

#[test]
fn rejects_a_flac_seek_table_point_outside_its_audio_payload() {
    let original = include_bytes!("fixtures/stereo.flac");
    let mut data = original[..42].to_vec();
    data[4] &= 0x7f;
    data.extend_from_slice(&[0x83, 0, 0, 18]);
    data.extend_from_slice(&0_u64.to_be_bytes());
    data.extend_from_slice(&u64::MAX.to_be_bytes());
    data.extend_from_slice(&192_u16.to_be_bytes());
    data.extend_from_slice(&original[42..]);
    let fixture = Fixture::from_bytes(&data);
    assert!(matches!(
        AudioSource::open(&fixture.0),
        Err(EngineOpenError::UnsupportedAudio)
    ));
}

#[test]
fn decodes_mono_pcm_as_stereo_and_seeks_by_frame() {
    let fixture = Fixture::from_bytes(&wav_fixture(MONO_I16, &[0i16, i16::MIN, 16_384]));
    let mut wav = AudioSource::open(&fixture.0).unwrap();

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
    let mut wav = AudioSource::open(&fixture.0).unwrap();

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
    let mut wav = AudioSource::open(&fixture.0).unwrap();
    assert_eq!(wav.read_frame().unwrap(), [-1.0; 2]);
    assert_eq!(wav.read_frame().unwrap(), [0.5; 2]);

    let spec = hound::WavSpec {
        bits_per_sample: 24,
        ..MONO_I16
    };
    let fixture = Fixture::from_bytes(&wav_fixture(spec, &[-8_388_608i32, 4_194_304]));
    let mut wav = AudioSource::open(&fixture.0).unwrap();
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
    let mut wav = AudioSource::open(&fixture.0).unwrap();

    assert_eq!(wav.read_frame().unwrap(), [-0.25, 0.75]);
}

#[test]
fn rejects_a_truncated_wav_and_a_directory() {
    let mut truncated = wav_fixture(MONO_I16, &[0i16, 1]);
    truncated.pop();
    let fixture = Fixture::from_bytes(&truncated);

    assert!(matches!(
        AudioSource::open(&fixture.0),
        Err(EngineOpenError::UnsupportedAudio)
    ));
    assert!(matches!(
        AudioSource::open(&std::env::temp_dir()),
        Err(EngineOpenError::UnavailableAudio)
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
        AudioSource::open(&fixture.0).unwrap().read_frame().unwrap(),
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
        AudioInfo {
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
    let wav = AudioSource::open(&fixture.0).unwrap();
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
    let initial = engine.snapshot(false);
    assert_eq!(initial.position_ms, 0);
    assert_eq!(initial.duration_ms, 2_000);
    assert!(!initial.playing);

    engine.set_volume(0.5);
    engine.set_playing(true);
    let first_play = wait_for_snapshot(&mut engine, |snapshot| {
        snapshot.playing && snapshot.position_ms >= 180
    });
    engine.seek_ms(2_000);
    let scrubbed_to_end = engine.snapshot(false);
    assert_eq!(scrubbed_to_end.position_ms, 2_000);
    assert!(!scrubbed_to_end.playing);
    assert!(!scrubbed_to_end.finished);
    engine.set_playing(true);
    wait_for_snapshot(&mut engine, |snapshot| {
        snapshot.playing && snapshot.position_ms >= first_play.position_ms
    });
    engine.set_playing(false);
    std::thread::sleep(Duration::from_millis(120));
    let paused = engine.snapshot(false);
    std::thread::sleep(Duration::from_millis(120));
    assert_eq!(engine.snapshot(false).position_ms, paused.position_ms);
    assert!(!paused.playing);
    assert!(paused.position_ms >= first_play.position_ms);

    engine.seek_ms(1_000);
    assert_eq!(engine.snapshot(false).position_ms, 1_000);
    assert!(!engine.snapshot(false).playing);
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
    wait_for_snapshot(&mut engine, |snapshot| {
        snapshot.playing && snapshot.position_ms == snapshot.duration_ms
    });
    engine.set_playing(true);
    let still_in_tail = engine.snapshot(false);
    assert_eq!(still_in_tail.position_ms, still_in_tail.duration_ms);
    let ended = wait_for_snapshot(&mut engine, |snapshot| !snapshot.playing);
    assert_eq!(ended.position_ms, ended.duration_ms);
    assert!(ended.finished);
    assert!(!engine.snapshot(false).finished);

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
        let snapshot = engine.snapshot(false);
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
        AudioInfo {
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

#[test]
fn prepares_mp3_text_tags_after_skipping_artwork_and_large_text() {
    let audio = include_bytes!("fixtures/mono-untagged.mp3");
    let mut frames = Vec::new();
    let mut frame = |id: &[u8; 4], value: &[u8]| {
        frames.extend_from_slice(id);
        frames.extend_from_slice(&synchsafe(value.len()));
        frames.extend_from_slice(&[0, 0]);
        frames.extend_from_slice(value);
    };
    frame(b"APIC", &vec![0xff; 100_000]);
    frame(b"TIT2", &vec![0xff; 20_000]);
    frame(b"TIT2", b"\x03Signal\n \xe2\x80\xaeTest");
    frame(b"TPE1", &[0, b'J', b'o', b's', 0xe9]);
    frame(b"TALB", &[1, 0xff, 0xfe, b'E', 0, b'P', 0]);
    let mut tagged = b"ID3\x04\x00\x00".to_vec();
    tagged.extend_from_slice(&synchsafe(frames.len()));
    tagged.extend_from_slice(&frames);
    tagged.extend_from_slice(audio);

    let fixture = Fixture::with_extension(&tagged, "mp3");
    let mut prepared = PreparedAudio::read(&fixture.0).unwrap();
    let tags = prepared.metadata();
    assert_eq!(tags.title, "Signal Test");
    assert_eq!(tags.artist.as_deref(), Some("José"));
    assert_eq!(tags.album.as_deref(), Some("EP"));
    assert!(prepared.0.read_frame().is_ok());
}

#[test]
fn mp3_uses_id3v1_only_for_missing_text_fields() {
    let audio = include_bytes!("fixtures/mono-untagged.mp3");
    let mut footer = [0; 128];
    footer[..3].copy_from_slice(b"TAG");
    footer[3..9].copy_from_slice(b"Legacy");
    footer[33..37].copy_from_slice(b"Jos\xe9");
    footer[63..69].copy_from_slice(b"Album ");

    for has_new_title in [false, true] {
        let mut bytes = Vec::new();
        if has_new_title {
            bytes.extend_from_slice(b"ID3\x04\0\0\0\0\0\x0eTIT2\0\0\0\x04\0\0\x03New");
        }
        bytes.extend_from_slice(audio);
        bytes.extend_from_slice(&footer);
        let fixture = Fixture::with_extension(&bytes, "mp3");
        let mut prepared = PreparedAudio::read(&fixture.0).unwrap();
        assert_eq!(
            prepared.metadata().title,
            if has_new_title { "New" } else { "Legacy" }
        );
        assert_eq!(prepared.metadata().artist.as_deref(), Some("José"));
        assert_eq!(prepared.metadata().album.as_deref(), Some("Album"));
        assert_eq!(prepared.0.info().frames, 12 * 576);
        assert!(prepared.0.read_frame().is_ok());
    }
}

fn synchsafe(len: usize) -> [u8; 4] {
    [21, 14, 7, 0].map(|shift| ((len >> shift) & 0x7f) as u8)
}

fn comments(entries: &[&[u8]]) -> Vec<u8> {
    let mut bytes = 0_u32.to_le_bytes().to_vec();
    bytes.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for entry in entries {
        bytes.extend_from_slice(&(entry.len() as u32).to_le_bytes());
        bytes.extend_from_slice(entry);
    }
    bytes
}

#[test]
fn prepares_flac_text_when_the_picture_and_comment_payloads_are_unusable() {
    let audio = include_bytes!("fixtures/stereo.flac");
    let mut tagged = audio[..42].to_vec();
    tagged[4] &= 0x7f;
    let mut block = |kind, value: &[u8]| {
        tagged.push(kind);
        tagged.extend_from_slice(&(value.len() as u32).to_be_bytes()[1..]);
        tagged.extend_from_slice(value);
    };
    // These blocks belong to metadata and playback can skip them entirely.
    block(6, &vec![0xff; 90_000]);
    block(4, &u32::MAX.to_le_bytes());
    block(
        0x80 | 4,
        &comments(&[
            b"METADATA_BLOCK_PICTURE=broken",
            b"title=FLAC label",
            b"ARTIST=First",
            b"artist=Second",
            b"ALBUM=Sessions",
        ]),
    );
    tagged.extend_from_slice(&audio[42..]);

    let fixture = Fixture::with_extension(&tagged, "flac");
    let mut prepared = PreparedAudio::read(&fixture.0).unwrap();
    let tags = prepared.metadata();
    assert_eq!(tags.title, "FLAC label");
    assert_eq!(tags.artist.as_deref(), Some("First"));
    assert_eq!(tags.album.as_deref(), Some("Sessions"));
    let first = prepared.0.read_frame().unwrap();
    prepared.0.seek_to(0).unwrap();
    assert_eq!(prepared.0.read_frame().unwrap(), first);
}

#[test]
fn prepares_ogg_opus_comments_and_ignores_embedded_picture_comments() {
    use ogg::{
        PacketReader,
        writing::{PacketWriteEndInfo, PacketWriter},
    };

    let audio = include_bytes!("fixtures/mono-preskip.opus");
    let mut reader = PacketReader::new(Cursor::new(audio));
    let mut bytes = Vec::new();
    let mut writer = PacketWriter::new(&mut bytes);
    while let Some(packet) = reader.read_packet().unwrap() {
        let end = if packet.last_in_stream() {
            PacketWriteEndInfo::EndStream
        } else if packet.last_in_page() {
            PacketWriteEndInfo::EndPage
        } else {
            PacketWriteEndInfo::NormalPacket
        };
        let serial = packet.stream_serial();
        let granule = packet.absgp_page();
        let data = if packet.data.starts_with(b"OpusTags") {
            let picture = ["METADATA_BLOCK_PICTURE=", &"X".repeat(70_000)].concat();
            let mut tags = b"OpusTags".to_vec();
            tags.extend(comments(&[
                picture.as_bytes(),
                b"TITLE= Opus label ",
                b"artist=Voice",
                b"ALBUM=Sessions",
            ]));
            tags
        } else {
            packet.data
        };
        writer.write_packet(data, serial, end, granule).unwrap();
    }

    let fixture = Fixture::with_extension(&bytes, "opus");
    let mut prepared = PreparedAudio::read(&fixture.0).unwrap();
    let tags = prepared.metadata();
    assert_eq!(tags.title, "Opus label");
    assert_eq!(tags.artist.as_deref(), Some("Voice"));
    assert_eq!(tags.album.as_deref(), Some("Sessions"));
    assert_eq!(prepared.0.info().frames, 1_087);
    assert!(prepared.0.read_frame().is_ok());
}

#[test]
fn preserves_wav_playback_and_falls_back_to_a_sanitized_basename() {
    let bytes = wav_fixture(MONO_I16, &[0_i16, 100]);
    let fixture = Fixture::with_extension(&bytes, "wav");
    let prepared = PreparedAudio::read(&fixture.0).unwrap();
    let tags = prepared.metadata();
    assert!(tags.title.is_empty());
    assert!(tags.artist.is_none());
    assert!(tags.album.is_none());
    assert_eq!(
        tags.clone()
            .with_filename(Path::new("private/music/\u{202e} test.wav"))
            .title,
        "test.wav",
    );
}
