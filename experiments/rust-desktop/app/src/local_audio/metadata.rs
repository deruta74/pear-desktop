use std::{
    io::{self, Read, Seek, SeekFrom},
    path::Path,
};

pub(super) use crate::media::Metadata;

const MAX_TEXT_BYTES: u64 = 4 * 1024;
const MAX_TEXT_CHARS: usize = 180;
const MAX_FIELDS: usize = 256;

#[derive(Clone, Copy)]
enum Field {
    Title,
    Artist,
    Album,
}

impl Metadata {
    pub(super) fn with_filename(mut self, path: &Path) -> Self {
        if self.title.is_empty() {
            self.title = filename(path);
        }
        self
    }

    fn insert(&mut self, field: Field, text: &str) {
        if self.has(field) {
            return;
        }
        let text = sanitize(text);
        if text.is_empty() {
            return;
        }
        match field {
            Field::Title => self.title = text,
            Field::Artist => self.artist = Some(text),
            Field::Album => self.album = Some(text),
        }
    }

    fn has(&self, field: Field) -> bool {
        match field {
            Field::Title => !self.title.is_empty(),
            Field::Artist => self.artist.is_some(),
            Field::Album => self.album.is_some(),
        }
    }

    pub(super) fn read_vorbis(mut reader: impl Read + Seek, size: u64) -> io::Result<Self> {
        let mut metadata = Self::default();
        let mut remaining = size;
        let vendor = vorbis_length(&mut reader, &mut remaining)?;
        skip(&mut reader, vendor)?;
        let count = read_comment_u32(&mut reader, &mut remaining)?;
        for _ in 0..count.min(MAX_FIELDS as u64) {
            let length = vorbis_length(&mut reader, &mut remaining)?;
            if !(6..=MAX_TEXT_BYTES).contains(&length) {
                skip(&mut reader, length)?;
                continue;
            }
            let mut key = [0; 6];
            reader.read_exact(&mut key)?;
            let mut value_length = length - 6;
            let field = if key.eq_ignore_ascii_case(b"TITLE=") {
                Some(Field::Title)
            } else if key.eq_ignore_ascii_case(b"ALBUM=") {
                Some(Field::Album)
            } else if key.eq_ignore_ascii_case(b"ARTIST") && value_length > 0 {
                let mut separator = [0];
                reader.read_exact(&mut separator)?;
                value_length -= 1;
                (separator[0] == b'=').then_some(Field::Artist)
            } else {
                None
            };
            if let Some(field) = field.filter(|&field| !metadata.has(field)) {
                let mut value = vec![0; value_length as usize];
                reader.read_exact(&mut value)?;
                if let Ok(text) = str::from_utf8(&value) {
                    metadata.insert(field, text);
                }
            } else {
                skip(&mut reader, value_length)?;
            }
        }
        Ok(metadata)
    }

    pub(super) fn read_id3(
        mut reader: impl Read + Seek,
        version: u8,
        flags: u8,
        size: u64,
    ) -> io::Result<Self> {
        let mut metadata = Self::default();
        // Whole-tag unsynchronization and v2.2 compression change the layout
        // of on-disk frame offsets. Leave these tags to the filename fallback.
        if flags & 0x80 != 0 || (version == 2 && flags & 0x40 != 0) {
            return Ok(metadata);
        }
        let mut remaining = size;
        if flags & 0x40 != 0 {
            let mut size = [0; 4];
            take(&mut remaining, size.len() as u64)?;
            reader.read_exact(&mut size)?;
            let rest = if version == 3 {
                u64::from(u32::from_be_bytes(size))
            } else {
                synchsafe(size)?
                    .checked_sub(4)
                    .ok_or(io::ErrorKind::InvalidData)?
            };
            take(&mut remaining, rest)?;
            skip(&mut reader, rest)?;
        }
        let header_size = if version == 2 { 6 } else { 10 };
        for _ in 0..MAX_FIELDS {
            if remaining < header_size as u64 {
                break;
            }
            let mut header = [0; 10];
            reader.read_exact(&mut header[..header_size])?;
            if header[0] == 0 {
                break; // Padding.
            }
            remaining -= header_size as u64;
            let length = match version {
                2 => u64::from(u32::from_be_bytes([0, header[3], header[4], header[5]])),
                3 => u64::from(u32::from_be_bytes(
                    header[4..8].try_into().expect("four frame size bytes"),
                )),
                _ => synchsafe(header[4..8].try_into().expect("four frame size bytes"))?,
            };
            take(&mut remaining, length)?;
            let field = match &header[..if version == 2 { 3 } else { 4 }] {
                b"TT2" | b"TIT2" => Some(Field::Title),
                b"TP1" | b"TPE1" => Some(Field::Artist),
                b"TAL" | b"TALB" => Some(Field::Album),
                _ => None,
            };
            // Format flags indicate extra bytes or transformed payloads.
            if let Some(field) = field.filter(|&field| {
                header[9] == 0 && (1..=MAX_TEXT_BYTES).contains(&length) && !metadata.has(field)
            }) {
                let mut value = vec![0; length as usize];
                reader.read_exact(&mut value)?;
                if let Some(text) = id3_text(&value) {
                    metadata.insert(field, &text);
                }
            } else {
                skip(&mut reader, length)?;
            }
        }
        Ok(metadata)
    }

    pub(super) fn fill_id3v1(
        &mut self,
        mut reader: impl Read + Seek,
        audio_start: u64,
        file_size: u64,
    ) -> io::Result<()> {
        let mut footer = [0; 128];
        let Some(start) = file_size
            .checked_sub(footer.len() as u64)
            .filter(|&start| start >= audio_start)
        else {
            return Ok(());
        };
        let fields = [
            (Field::Title, 3..33),
            (Field::Artist, 33..63),
            (Field::Album, 63..93),
        ];
        if fields.iter().all(|&(field, _)| self.has(field)) {
            return Ok(());
        }
        reader.seek(SeekFrom::Start(start))?;
        reader.read_exact(&mut footer)?;
        if &footer[..3] != b"TAG" {
            return Ok(());
        }
        for (field, range) in fields {
            if !self.has(field) {
                let text: String = footer[range]
                    .iter()
                    .copied()
                    .take_while(|&byte| byte != 0)
                    .map(char::from)
                    .collect();
                self.insert(field, &text);
            }
        }
        Ok(())
    }
}

fn id3_text(value: &[u8]) -> Option<String> {
    let (&encoding, text) = value.split_first()?;
    let text = match encoding {
        0 => text.iter().copied().map(char::from).collect(),
        3 => str::from_utf8(text).ok()?.to_owned(),
        1 | 2 => {
            let (text, little_endian) = match (encoding, text) {
                (1, [0xff, 0xfe, rest @ ..]) => (rest, true),
                (1, [0xfe, 0xff, rest @ ..]) => (rest, false),
                (2, _) => (text, false),
                _ => return None,
            };
            let (pairs, trailing) = text.as_chunks::<2>();
            if !trailing.is_empty() {
                return None;
            }
            let decode = if little_endian {
                u16::from_le_bytes
            } else {
                u16::from_be_bytes
            };
            let units: Vec<_> = pairs
                .iter()
                .copied()
                .map(decode)
                .take_while(|&unit| unit != 0)
                .collect();
            return String::from_utf16(&units).ok();
        }
        _ => return None,
    };
    Some(
        text.split_once('\0')
            .map_or(text.as_str(), |part| part.0)
            .to_owned(),
    )
}

pub(super) fn synchsafe(bytes: [u8; 4]) -> io::Result<u64> {
    if bytes.iter().any(|byte| byte & 0x80 != 0) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(bytes
        .into_iter()
        .fold(0, |size, byte| (size << 7) | u64::from(byte)))
}

fn vorbis_length(reader: &mut impl Read, remaining: &mut u64) -> io::Result<u64> {
    let length = read_comment_u32(reader, remaining)?;
    take(remaining, length)?;
    Ok(length)
}

fn read_comment_u32(reader: &mut impl Read, remaining: &mut u64) -> io::Result<u64> {
    let mut value = [0; 4];
    take(remaining, value.len() as u64)?;
    reader.read_exact(&mut value)?;
    Ok(u64::from(u32::from_le_bytes(value)))
}

fn take(remaining: &mut u64, length: u64) -> io::Result<()> {
    *remaining = remaining
        .checked_sub(length)
        .ok_or(io::ErrorKind::InvalidData)?;
    Ok(())
}

fn skip(reader: &mut impl Seek, size: u64) -> io::Result<()> {
    // Every length came from a bounded container with a 32-bit size.
    reader.seek_relative(size as i64)
}

pub(super) fn filename(path: &Path) -> String {
    let name = sanitize(&path.file_name().unwrap_or_default().to_string_lossy());
    if name.is_empty() {
        "Audio file".to_owned()
    } else {
        name
    }
}

fn sanitize(value: &str) -> String {
    let value: String = value
        .chars()
        .filter(|&ch| {
            !ch.is_control()
                && !matches!(ch, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .skip_while(|ch| ch.is_whitespace())
        .take(MAX_TEXT_CHARS)
        .collect();
    value.trim_end().to_owned()
}
