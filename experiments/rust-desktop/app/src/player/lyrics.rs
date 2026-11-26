use std::time::Duration;

use serde::{Deserialize, Serialize};
use ureq::{
    Agent, Body,
    http::header,
    tls::{RootCerts, TlsConfig, TlsProvider},
};

mod lyricsfile;

const ENDPOINT: &str = "https://lrclib.net/api/get";
const USER_AGENT: &str = concat!(
    "Pear Desktop Rust Preview/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/deruta74/pear-desktop)"
);
const MAX_BODY_BYTES: u64 = 256 * 1024;
pub(crate) const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_QUERY_CHARS: usize = 160;
pub(super) const MAX_DURATION_SECONDS: u32 = 24 * 60 * 60;
const DURATION_TOLERANCE_SECONDS: f64 = 3.0;
const MAX_OFFSET_MS: i32 = 60_000;
const MAX_LINE_CHARS: usize = 512;
const MAX_LINES: usize = 1000;
const MAX_REPEATED_TIMES: usize = 16;
const MAX_MARKERS_PER_LINE: usize = 64;
const MAX_WORDS: usize = 4096;
const MAX_CLOCK_BYTES: usize = "1440:00.000".len();

#[derive(Clone)]
pub(super) struct Client {
    agent: Agent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum Document {
    Synced { lines: Vec<Line> },
    Plain { lines: Vec<String> },
    Instrumental,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Line {
    pub(crate) time_ms: u32,
    pub(crate) text: String,
    pub(super) words: Vec<Word>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Word {
    pub(super) time_ms: u32,
    pub(super) text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LookupError {
    InvalidQuery,
    Network,
    InvalidResponse,
    Throttled,
    Service,
}

impl Client {
    pub(super) fn new() -> Self {
        let agent = Agent::config_builder()
            .https_only(true)
            .proxy(None)
            .max_redirects(0)
            .timeout_connect(Some(Duration::from_secs(3)))
            .timeout_global(Some(Duration::from_secs(5)))
            .http_status_as_error(false)
            .tls_config(
                TlsConfig::builder()
                    .provider(TlsProvider::NativeTls)
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .build()
            .new_agent();
        Self { agent }
    }

    pub(super) fn lookup(
        &self,
        title: &str,
        artist: &str,
        duration: u32,
    ) -> Result<Option<Document>, LookupError> {
        let title = normalize_query(title).ok_or(LookupError::InvalidQuery)?;
        let artist = normalize_query(artist).ok_or(LookupError::InvalidQuery)?;
        if !(1..=MAX_DURATION_SECONDS).contains(&duration) {
            return Err(LookupError::InvalidQuery);
        }
        let mut response = self
            .agent
            .get(ENDPOINT)
            .query("track_name", &title)
            .query("artist_name", &artist)
            .query("duration", duration.to_string())
            .header(header::ACCEPT, "application/json")
            .header(header::USER_AGENT, USER_AGENT)
            .call()
            .map_err(transport_error)?;
        interpret_response(
            response.status().as_u16(),
            response.body_mut(),
            &title,
            &artist,
            duration,
        )
    }
}

pub(super) fn normalize_query(query: &str) -> Option<String> {
    let trimmed = query.trim();
    if trimmed.is_empty()
        || trimmed.chars().nth(MAX_QUERY_CHARS).is_some()
        || query.chars().any(char::is_control)
    {
        return None;
    }
    Some(trimmed.to_owned())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Track {
    track_name: String,
    artist_name: String,
    duration: f64,
    instrumental: bool,
    synced_lyrics: Option<String>,
    plain_lyrics: Option<String>,
    lyricsfile: Option<serde_json::Value>,
}

fn interpret_response(
    status: u16,
    body: &mut Body,
    title: &str,
    artist: &str,
    duration: u32,
) -> Result<Option<Document>, LookupError> {
    match status {
        200 => {}
        404 => return Ok(None),
        429 => return Err(LookupError::Throttled),
        _ => return Err(LookupError::Service),
    }
    if !body
        .mime_type()
        .is_some_and(|mime| mime.eq_ignore_ascii_case("application/json"))
    {
        return Err(LookupError::InvalidResponse);
    }
    let bytes = body
        .with_config()
        .limit(MAX_BODY_BYTES)
        .read_to_vec()
        .map_err(transport_error)?;
    let track: Track = serde_json::from_slice(&bytes).map_err(|_| LookupError::InvalidResponse)?;
    let actual_title = normalize_query(&track.track_name).ok_or(LookupError::InvalidResponse)?;
    let actual_artist = normalize_query(&track.artist_name).ok_or(LookupError::InvalidResponse)?;
    if track.duration <= 0.0 || track.duration > f64::from(MAX_DURATION_SECONDS) {
        return Err(LookupError::InvalidResponse);
    }
    if !same_recording_name(title, &actual_title)
        || !same_recording_name(artist, &actual_artist)
        || (track.duration - f64::from(duration)).abs() > DURATION_TOLERANCE_SECONDS
    {
        return Ok(None);
    }

    decode_track(track)
}

fn same_recording_name(expected: &str, actual: &str) -> bool {
    expected
        .split_whitespace()
        .map(str::to_lowercase)
        .eq(actual.split_whitespace().map(str::to_lowercase))
}

fn decode_track(track: Track) -> Result<Option<Document>, LookupError> {
    if track.instrumental {
        return Ok(Some(Document::Instrumental));
    }
    let rich = track
        .lyricsfile
        .as_ref()
        .and_then(serde_json::Value::as_str)
        .and_then(|text| lyricsfile::parse(text, track.duration));
    let synced = track.synced_lyrics.as_deref().map(parse_lrc).transpose();
    let synced_error = match synced {
        Ok(Some(mut lines)) if lines.iter().any(|line| !line.text.is_empty()) => {
            if let Some(rich) = rich {
                lyricsfile::merge_words(&mut lines, &rich);
            }
            return Ok(Some(with_opening_gap(lines)));
        }
        Err(error) => Some(error),
        _ => None,
    };
    if let Some(lines) = rich {
        return Ok(Some(with_opening_gap(lines)));
    }
    if let Some(plain) = track.plain_lyrics.as_deref() {
        let lines = parse_plain(plain)?;
        if lines.iter().any(|line| !line.is_empty()) {
            return Ok(Some(Document::Plain { lines }));
        }
    }
    synced_error.map_or(Ok(None), Err)
}

fn with_opening_gap(mut lines: Vec<Line>) -> Document {
    if lines.len() < MAX_LINES
        && lines
            .first()
            .is_some_and(|line| line.time_ms > 300 && !line.text.is_empty())
    {
        lines.insert(
            0,
            Line {
                time_ms: 0,
                text: String::new(),
                words: Vec::new(),
            },
        );
    }
    Document::Synced { lines }
}

fn parse_plain(input: &str) -> Result<Vec<String>, LookupError> {
    if input.len() > MAX_TEXT_BYTES {
        return Err(LookupError::InvalidResponse);
    }
    let mut lines = Vec::new();
    for line in input.trim_matches(['\r', '\n']).lines() {
        if lines.len() == MAX_LINES {
            return Err(LookupError::InvalidResponse);
        }
        lines.push(lyric_text(line)?);
    }
    Ok(lines)
}

pub(crate) fn parse_lrc(input: &str) -> Result<Vec<Line>, LookupError> {
    if input.len() > MAX_TEXT_BYTES {
        return Err(LookupError::InvalidResponse);
    }
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    let offset_ms = input.lines().rev().find_map(offset_tag).unwrap_or(0);
    let mut lines = Vec::new();
    let mut total_bytes = 0;
    let mut total_words = 0;
    for row in input.lines() {
        let mut content = row.trim_start();
        let mut times = Vec::new();
        while let Some((timestamp, rest)) =
            content.strip_prefix('[').and_then(|s| s.split_once(']'))
        {
            let Some(time_ms) = timestamp_ms(timestamp) else {
                break;
            };
            if times.len() == MAX_REPEATED_TIMES {
                return Err(LookupError::InvalidResponse);
            }
            times.push(time_ms);
            content = rest;
        }
        let Some(&first_time) = times.first() else {
            continue;
        };
        let (text, words) = inline_lyrics(content, first_time)?;
        total_bytes += text.len() * times.len();
        total_words += words.len() * times.len();
        if lines.len() + times.len() > MAX_LINES
            || total_bytes > MAX_TEXT_BYTES
            || total_words > MAX_WORDS
        {
            return Err(LookupError::InvalidResponse);
        }
        for time in times {
            let word_shift = i64::from(offset_ms) + i64::from(time) - i64::from(first_time);
            lines.push(Line {
                time_ms: shift_clock(time, i64::from(offset_ms)),
                text: text.clone(),
                words: words
                    .iter()
                    .map(|word| Word {
                        time_ms: shift_clock(word.time_ms, word_shift),
                        text: word.text.clone(),
                    })
                    .collect(),
            });
        }
    }
    lines.sort_by_key(|line| line.time_ms);
    Ok(lines)
}

fn offset_tag(line: &str) -> Option<i32> {
    let (tag, value) = line
        .trim()
        .strip_prefix('[')?
        .strip_suffix(']')?
        .split_once(':')?;
    if !tag.eq_ignore_ascii_case("offset") {
        return None;
    }
    let value = value.trim().parse::<i32>().ok()?;
    (-MAX_OFFSET_MS..=MAX_OFFSET_MS)
        .contains(&value)
        .then_some(value)
}

fn timestamp_ms(value: &str) -> Option<u32> {
    let (minutes, rest) = value.split_once(':')?;
    let (seconds, fraction) = match rest.split_once(['.', ':']) {
        Some((seconds, fraction)) => {
            let milliseconds = digits(fraction, 3)? * 10_u32.pow((3 - fraction.len()) as u32);
            (seconds, milliseconds)
        }
        None => (rest, 0),
    };
    let minutes = digits(minutes, 4)?;
    let seconds = digits(seconds, 2)?;
    let time_ms = minutes * 60_000 + seconds * 1000 + fraction;
    (seconds < 60 && time_ms <= MAX_DURATION_SECONDS * 1000).then_some(time_ms)
}

fn digits(value: &str, max_digits: usize) -> Option<u32> {
    if value.is_empty() || value.len() > max_digits || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn shift_clock(time_ms: u32, shift_ms: i64) -> u32 {
    (i64::from(time_ms) + shift_ms).clamp(0, i64::from(MAX_DURATION_SECONDS) * 1000) as u32
}

fn inline_lyrics(content: &str, line_time: u32) -> Result<(String, Vec<Word>), LookupError> {
    let markers: Vec<_> = content
        .match_indices('<')
        .filter_map(|(start, _)| {
            let suffix = &content[start + 1..];
            let close = suffix
                .bytes()
                .take(MAX_CLOCK_BYTES + 1)
                .position(|byte| byte == b'>')?;
            let time_ms = timestamp_ms(&suffix[..close])?;
            Some((start, start + close + 2, time_ms))
        })
        .take(MAX_MARKERS_PER_LINE + 1)
        .collect();
    if markers.is_empty() {
        return Ok((lyric_text(content)?, Vec::new()));
    }
    if markers.len() > MAX_MARKERS_PER_LINE {
        return Err(LookupError::InvalidResponse);
    }

    let prefix = &content[..markers[0].0];
    let mut text = prefix.to_owned();
    let mut words = Vec::new();
    if !prefix.is_empty() {
        words.push(Word {
            time_ms: line_time,
            text: prefix.to_owned(),
        });
    }
    for (index, &(_, end, time_ms)) in markers.iter().enumerate() {
        let next = markers.get(index + 1).map_or(content.len(), |next| next.0);
        let part = &content[end..next];
        text.push_str(part);
        if !part.is_empty() {
            words.push(Word {
                time_ms,
                text: part.to_owned(),
            });
        }
    }
    let text = lyric_text(&text)?;
    if text.is_empty()
        || markers[0].2 < line_time
        || markers.windows(2).any(|pair| pair[1].2 < pair[0].2)
    {
        words.clear();
    }
    Ok((text, words))
}

fn lyric_text(line: &str) -> Result<String, LookupError> {
    if line.chars().nth(MAX_LINE_CHARS).is_some()
        || line.chars().any(|ch| ch.is_control() && ch != '\t')
    {
        return Err(LookupError::InvalidResponse);
    }
    Ok(if line.trim().is_empty() {
        String::new()
    } else {
        line.to_owned()
    })
}

fn transport_error(error: ureq::Error) -> LookupError {
    match error {
        ureq::Error::BodyExceedsLimit(_)
        | ureq::Error::Decompress(_, _)
        | ureq::Error::LargeResponseHeader(_, _)
        | ureq::Error::Protocol(_) => LookupError::InvalidResponse,
        _ => LookupError::Network,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(
        status: u16,
        json: impl Into<Vec<u8>>,
        duration: u32,
    ) -> Result<Option<Document>, LookupError> {
        let mut body = Body::builder().mime_type("application/json").data(json);
        interpret_response(status, &mut body, "Moon  Song", "Björk", duration)
    }

    #[test]
    fn accepts_multilingual_queries_within_the_scalar_limit() {
        assert_eq!(
            normalize_query("  Björk  音楽  "),
            Some("Björk  音楽".into())
        );
        assert_eq!(normalize_query(&"界".repeat(160)), Some("界".repeat(160)));
        assert_eq!(normalize_query(&"界".repeat(161)), None);
        assert_eq!(normalize_query(" "), None);
        assert_eq!(normalize_query("line\n"), None);
    }

    #[test]
    fn matches_only_the_requested_recording() {
        let track = serde_json::json!({
            "trackName": "  moon song ", "artistName": "BJÖRK", "duration": 112.4,
            "instrumental": true,
        });
        assert_eq!(
            response(200, track.to_string(), 110),
            Ok(Some(Document::Instrumental))
        );
        assert_eq!(response(200, track.to_string(), 109), Ok(None));

        let mut other = track;
        other["trackName"] = "Moon Song (Live)".into();
        assert_eq!(response(200, other.to_string(), 112), Ok(None));
        other["trackName"] = "Moon Song".into();
        other["artistName"] = "Other artist".into();
        assert_eq!(response(200, other.to_string(), 112), Ok(None));
    }

    #[test]
    fn preserves_blank_timed_lines_and_sorts_equal_times_stably() {
        let lines = parse_lrc(
            "\u{feff}[ar:Artist]\r\n[0:05][0:01.2]first\r\n[0:01.20]second\n[00:03.042]\n[offset:+250]",
        ).unwrap();
        let clocks: Vec<_> = lines
            .iter()
            .map(|line| (line.time_ms, line.text.as_str()))
            .collect();
        assert_eq!(
            clocks,
            [
                (1450, "first"),
                (1450, "second"),
                (3292, ""),
                (5250, "first")
            ]
        );
    }

    #[test]
    fn preserves_text_and_shifts_word_times_for_repeated_lines() {
        let lines = parse_lrc("[0:01][0:04]Hi <0:01.25>there <b>friend</b><0:02>").unwrap();
        assert_eq!(
            lines[0],
            Line {
                time_ms: 1000,
                text: "Hi there <b>friend</b>".into(),
                words: vec![
                    Word {
                        time_ms: 1000,
                        text: "Hi ".into()
                    },
                    Word {
                        time_ms: 1250,
                        text: "there <b>friend</b>".into()
                    },
                ],
            }
        );
        assert_eq!(lines[1].time_ms, 4000);
        assert_eq!(lines[1].words[1].time_ms, 4250);
    }

    #[test]
    fn retains_line_text_when_word_markers_go_backwards() {
        let lines = parse_lrc("[0:01]<0:01.7>one <0:01.2>two").unwrap();
        assert_eq!(lines[0].text, "one two");
        assert!(lines[0].words.is_empty());
    }

    #[test]
    fn clamps_negative_offset_for_line_and_word_clocks() {
        let lines = parse_lrc("[0:01]<0:01.2>one <0:01.8>two\n[offset:-1500]").unwrap();
        assert_eq!(lines[0].time_ms, 0);
        assert_eq!(lines[0].words[0].time_ms, 0);
        assert_eq!(lines[0].words[1].time_ms, 300);
    }

    #[test]
    fn uses_plain_when_synced_lyrics_have_no_valid_timing() {
        let track = serde_json::json!({
            "trackName": "Moon Song", "artistName": "Björk", "duration": 110,
            "instrumental": false, "plainLyrics": "one\n\nthree\n",
            "syncedLyrics": "[0:99.1]invalid",
        });
        assert_eq!(
            response(200, track.to_string(), 110),
            Ok(Some(Document::Plain {
                lines: vec!["one".into(), "".into(), "three".into()],
            }))
        );
    }

    #[test]
    fn merges_lyricsfile_words_into_matching_lrc_and_keeps_the_opening_gap() {
        let word_timed = r#"
version: "1.0"
lines:
- text: "Moon Song"
  start_ms: 1504
  words:
  - text: "Moon "
    start_ms: 1504
  - text: "Song"
    start_ms: 1850
- text: "Unrelated"
  start_ms: 2500
  words:
  - text: "Unrelated"
    start_ms: 2500
"#;
        let track = serde_json::json!({
            "trackName": "Moon Song", "artistName": "Björk", "duration": 110,
            "instrumental": false, "lyricsfile": word_timed,
            "syncedLyrics": "[00:01.50]Moon Song\n[00:02.50]Stay here",
        });
        let Ok(Some(Document::Synced { lines })) = response(200, track.to_string(), 110) else {
            panic!("Expected synced lyrics");
        };
        assert_eq!((lines[0].time_ms, lines[0].text.as_str()), (0, ""));
        assert_eq!(lines[1].words[1].time_ms, 1850);
        assert_eq!(lines[2].text, "Stay here");
        assert!(lines[2].words.is_empty());
    }

    #[test]
    fn falls_back_to_standard_lyrics_when_rich_data_has_an_anchor() {
        let track = serde_json::json!({
            "trackName": "Moon Song", "artistName": "Björk", "duration": 110,
            "instrumental": false,
            "lyricsfile": "version: '1.0'\nlines: &lyrics\n- text: Moon\n  start_ms: 0\n  words:\n  - text: Moon\n    start_ms: 0",
            "syncedLyrics": "[00:00.00]Moon",
        });
        let Ok(Some(Document::Synced { lines })) = response(200, track.to_string(), 110) else {
            panic!("Expected synced lyrics");
        };
        assert_eq!(lines[0].text, "Moon");
        assert!(lines[0].words.is_empty());
    }

    #[test]
    fn bounds_repeated_timestamps_before_expanding_lines() {
        let repeated = "[0:01]".repeat(17) + "words";
        assert_eq!(parse_lrc(&repeated), Err(LookupError::InvalidResponse));
    }

    #[test]
    fn bounds_decoded_json_and_classifies_http_errors() {
        let oversized = vec![b' '; 256 * 1024 + 1];
        assert_eq!(
            response(200, oversized, 110),
            Err(LookupError::InvalidResponse)
        );
        assert_eq!(response(404, b"", 110), Ok(None));
        assert_eq!(response(429, b"", 110), Err(LookupError::Throttled));
        assert_eq!(response(302, b"", 110), Err(LookupError::Service));
    }

    #[test]
    fn serializes_word_and_line_clocks_for_controls() {
        let lines = parse_lrc("[0:01]<0:01.2>word").unwrap();
        assert_eq!(
            serde_json::to_value(Document::Synced { lines }).unwrap(),
            serde_json::json!({
                "kind": "synced",
                "lines": [{"timeMs": 1000, "text": "word", "words": [{"timeMs": 1200, "text": "word"}]}],
            }),
        );
    }
}
