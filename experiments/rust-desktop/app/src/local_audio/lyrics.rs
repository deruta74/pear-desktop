use std::{fs::File, io::Read, path::Path};

use serde::Serialize;

use crate::player::lyrics::{Line, MAX_TEXT_BYTES, parse_lrc};

pub(super) type Loaded = Result<Vec<Line>, &'static str>;

#[derive(Default)]
pub(super) struct State {
    lines: Vec<Line>,
    pub(super) loading: bool,
    error: Option<&'static str>,
}

#[derive(Serialize)]
pub(super) struct View<'a> {
    available: bool,
    loading: bool,
    line: Option<&'a str>,
    error: Option<&'static str>,
}

impl State {
    pub(super) fn finish(&mut self, result: Loaded) {
        self.loading = false;
        self.error = match result {
            Ok(lines) => {
                self.lines = lines;
                None
            }
            Err(problem) => Some(problem),
        };
    }

    pub(super) fn view(&self, position_ms: u64) -> View<'_> {
        View {
            available: !self.lines.is_empty(),
            loading: self.loading,
            line: current_line(&self.lines, position_ms),
            error: self.error,
        }
    }
}

pub(super) const UNREADABLE: &str = "Could not read the selected lyrics file.";

pub(super) fn read(path: &Path) -> Loaded {
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("lrc"))
    {
        return Err("Choose an .lrc lyrics file.");
    }
    if !path.is_file() {
        return Err(UNREADABLE);
    }
    let mut options = File::options();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A regular file can be replaced by a named pipe after the path check.
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| UNREADABLE)?;
    if !file.metadata().map_err(|_| UNREADABLE)?.is_file() {
        return Err(UNREADABLE);
    }
    let mut bytes = Vec::new();
    file.take(MAX_TEXT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| UNREADABLE)?;
    if bytes.len() > MAX_TEXT_BYTES {
        return Err("The lyrics file is larger than 64 KiB.");
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "Choose a UTF-8 .lrc lyrics file.")?;
    let lines = parse_lrc(text).map_err(|_| "The selected .lrc file could not be parsed.")?;
    if !lines.iter().any(|line| !line.text.is_empty()) {
        return Err("The selected .lrc file contains no timed lyrics.");
    }
    Ok(lines)
}

pub(super) fn current_line(lines: &[Line], position_ms: u64) -> Option<&str> {
    let after = lines.partition_point(|line| u64::from(line.time_ms) <= position_ms);
    lines[..after]
        .last()
        .filter(|line| !line.text.is_empty())
        .map(|line| line.text.as_str())
}
