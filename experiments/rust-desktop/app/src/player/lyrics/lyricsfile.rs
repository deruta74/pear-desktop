//! Optional LRCLIB Lyricsfile v1 word timing. See <https://lrclib.net/docs.md>.

use serde::Deserialize;
use serde_saphyr::options::MergeKeyPolicy;

use super::{
    DURATION_TOLERANCE_SECONDS, Line, MAX_LINES, MAX_MARKERS_PER_LINE, MAX_OFFSET_MS,
    MAX_TEXT_BYTES, MAX_WORDS, Word, lyric_text, shift_clock,
};

// LRCLIB's standard LRC can round cues to centiseconds.
const ALIGNMENT_MS: u32 = 15;

#[derive(Deserialize)]
struct Lyricsfile {
    version: String,
    #[serde(default)]
    metadata: Metadata,
    lines: Vec<Cue>,
}

#[derive(Default, Deserialize)]
struct Metadata {
    #[serde(default)]
    offset_ms: i32,
}

#[derive(Deserialize)]
struct Cue {
    text: String,
    start_ms: u32,
    #[serde(default)]
    words: Vec<WordCue>,
}

#[derive(Deserialize)]
struct WordCue {
    text: String,
    start_ms: u32,
}

pub(super) fn parse(input: &str, duration: f64) -> Option<Vec<Line>> {
    if input.len() > MAX_TEXT_BYTES {
        return None;
    }
    let options = serde_saphyr::options! {
        budget: serde_saphyr::budget! {
            max_documents: 1,
            max_aliases: 0,
            max_anchors: 0,
            max_depth: 8,
            max_inclusion_depth: 0,
            max_events: 32_768,
            max_total_scalar_bytes: MAX_TEXT_BYTES,
        },
        merge_keys: MergeKeyPolicy::Error,
        reject_unsupported_tags: true,
        with_snippet: false,
    };
    let raw: Lyricsfile = serde_saphyr::from_str_with_options(input, options).ok()?;
    let offset = raw.metadata.offset_ms;
    if raw.version != "1.0"
        || raw.lines.len() > MAX_LINES
        || !(-MAX_OFFSET_MS..=MAX_OFFSET_MS).contains(&offset)
    {
        return None;
    }
    let limit = ((duration + DURATION_TOLERANCE_SECONDS) * 1000.0) as u32;
    let mut lines = Vec::with_capacity(raw.lines.len());
    let mut total_words = 0;
    let mut raw_lines = raw.lines;
    raw_lines.sort_by_key(|line| line.start_ms);
    let mut cues = raw_lines.into_iter().peekable();
    while let Some(cue) = cues.next() {
        if cue.start_ms > limit {
            return None;
        }
        let next = cues.peek().map_or(limit, |cue| cue.start_ms);
        let line = convert(cue, i64::from(offset), next)?;
        total_words += line.words.len();
        if total_words > MAX_WORDS {
            return None;
        }
        lines.push(line);
    }
    lines
        .iter()
        .any(|line| !line.text.is_empty())
        .then_some(lines)
}

fn convert(cue: Cue, offset: i64, next: u32) -> Option<Line> {
    let text = lyric_text(&cue.text).ok()?;
    let time_ms = shift_clock(cue.start_ms, offset);
    let valid_words = !text.is_empty()
        && cue.words.len() <= MAX_MARKERS_PER_LINE
        && cue
            .words
            .iter()
            .all(|word| !word.text.is_empty() && (cue.start_ms..=next).contains(&word.start_ms))
        && cue
            .words
            .windows(2)
            .all(|pair| pair[0].start_ms <= pair[1].start_ms)
        && cue
            .words
            .iter()
            .map(|word| word.text.as_str())
            .collect::<String>()
            == text;
    let words = if valid_words {
        cue.words
            .into_iter()
            .map(|word| Word {
                time_ms: shift_clock(word.start_ms, offset),
                text: word.text,
            })
            .collect()
    } else {
        Vec::new()
    };
    Some(Line {
        time_ms,
        text,
        words,
    })
}

pub(super) fn merge_words(lines: &mut [Line], rich: &[Line]) {
    let mut total_words: usize = lines.iter().map(|line| line.words.len()).sum();
    for line in lines {
        if !line.words.is_empty() || line.text.is_empty() {
            continue;
        }
        let start = line.time_ms.saturating_sub(ALIGNMENT_MS);
        let end = line.time_ms.saturating_add(ALIGNMENT_MS);
        let first = rich.partition_point(|cue| cue.time_ms < start);
        let last = rich.partition_point(|cue| cue.time_ms <= end);
        let mut matches = rich[first..last]
            .iter()
            .filter(|cue| cue.text == line.text && !cue.words.is_empty());
        if let Some(cue) = matches.next()
            && matches.next().is_none()
            && total_words + cue.words.len() <= MAX_WORDS
        {
            line.words.clone_from(&cue.words);
            total_words += line.words.len();
        }
    }
}
