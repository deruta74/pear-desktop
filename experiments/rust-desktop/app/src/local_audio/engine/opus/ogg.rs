use std::{
    collections::VecDeque,
    fs::File,
    io::{self, Read, Seek, SeekFrom},
};

use ::ogg::reading::{BasePacketReader, OggPage, PageParser};

use super::MAX_PACKET_FRAMES;

const NO_GRANULE: u64 = u64::MAX;
const MAX_PAGE_BYTES: usize = 27 + 255 + 255 * 255;
const MAX_READ_BYTES: usize = 16 * 1024 * 1024;

pub(super) struct Packet {
    pub(super) start: u64,
    pub(super) frames: usize,
    pub(super) data: Vec<u8>,
}

pub(super) struct OggOpus {
    input: Input,
    serial: u32,
    audio_offset: u64,
    tail: PageInfo,
    next_offset: u64,
    sequence: Option<u32>,
    prev_continues: bool,
    prev_granule: Option<u64>,
    parser: BasePacketReader,
    packets: VecDeque<Packet>,
}

impl OggOpus {
    pub(super) fn open(file: File, length: u64) -> io::Result<(Self, Vec<u8>)> {
        let mut input = Input {
            file,
            length,
            remaining: MAX_READ_BYTES,
        };
        let (first, page) = input.read_page(0)?;
        if first.flags != 2 || first.granule != 0 || first.sequence != 0 || first.ends_continued {
            return Err(invalid());
        }
        let mut parser = BasePacketReader::new();
        parser.push_page(page).map_err(io::Error::other)?;
        let head = parser
            .read_packet()
            .filter(|packet| packet.last_in_page())
            .filter(|packet| packet.data.starts_with(b"OpusHead"))
            .ok_or_else(invalid)?;
        let tail = input.tail()?;
        if tail.serial != first.serial || tail.granule > i64::MAX as u64 {
            return Err(invalid());
        }
        let mut source = Self {
            input,
            serial: first.serial,
            audio_offset: 0,
            tail,
            next_offset: first.next_offset,
            sequence: Some(first.sequence),
            prev_continues: false,
            prev_granule: None,
            parser,
            packets: VecDeque::new(),
        };
        loop {
            let page = source.push_next_page()?;
            if page.flags & 4 != 0 {
                return Err(invalid());
            }
            // RFC 7845 §4 assigns granule zero to the page completing OpusTags.
            match source.parser.read_packet() {
                None if page.granule == NO_GRANULE => continue,
                Some(tags)
                    if page.granule == 0
                        && tags.last_in_page()
                        && !page.ends_continued
                        && tags.data.starts_with(b"OpusTags") =>
                {
                    break;
                }
                _ => return Err(invalid()),
            }
        }
        source.audio_offset = source.next_offset;
        source.fill_packets()?;
        Ok((source, head.data))
    }

    pub(super) fn start(&self) -> u64 {
        self.packets
            .front()
            .expect("open loaded the first audio page")
            .start
    }

    pub(super) fn end(&self) -> u64 {
        self.tail.granule
    }

    pub(super) fn reset_budget(&mut self) {
        self.input.remaining = MAX_READ_BYTES;
    }

    pub(super) fn seek(&mut self, granule: u64) -> io::Result<()> {
        self.reset_budget();
        let mut lower = self.audio_offset;
        let mut upper = self.tail.offset;
        // Anchor on a non-final page before the requested warmup. Reading the final page
        // with the preceding page's granule allows us to distinguish duration from end trim.
        while upper.saturating_sub(lower) > 2 * MAX_PAGE_BYTES as u64 {
            let middle = lower + (upper - lower) / 2;
            if let Some(page) = self.input.find_page(
                middle,
                upper.min(middle + MAX_PAGE_BYTES as u64),
                self.serial,
            )? && page.granule < granule
            {
                lower = page.offset;
            } else {
                upper = middle;
            }
        }
        self.next_offset = lower;
        self.sequence = None;
        self.prev_continues = false;
        self.prev_granule = None;
        self.packets.clear();
        self.parser.update_after_seek();
        Ok(())
    }

    pub(super) fn next_packet(&mut self) -> io::Result<Packet> {
        if self.packets.is_empty()
            && let Err(error) = self.fill_packets()
        {
            self.packets.clear();
            return Err(error);
        }
        self.packets.pop_front().ok_or_else(invalid)
    }

    fn push_next_page(&mut self) -> io::Result<PageInfo> {
        let (info, page) = self.input.read_page(self.next_offset)?;
        if info.serial != self.serial
            || info.flags & 2 != 0
            || (info.flags & 4 != 0) != (info.offset == self.tail.offset)
            || self.sequence.is_some_and(|previous| {
                info.sequence != previous.wrapping_add(1)
                    || self.prev_continues != (info.flags & 1 != 0)
            })
        {
            return Err(invalid());
        }
        self.parser.push_page(page).map_err(io::Error::other)?;
        self.sequence = Some(info.sequence);
        self.prev_continues = info.ends_continued;
        self.next_offset = info.next_offset;
        Ok(info)
    }

    fn fill_packets(&mut self) -> io::Result<()> {
        while self.packets.is_empty() {
            let page = self.push_next_page()?;
            let mut total = 0;
            while let Some(packet) = self.parser.read_packet() {
                let frames = packet_frames(&packet.data).ok_or_else(invalid)?;
                self.packets.push_back(Packet {
                    start: total,
                    frames,
                    data: packet.data,
                });
                total += frames as u64;
            }
            if page.granule == NO_GRANULE && self.packets.is_empty() {
                continue;
            }
            if page.granule > i64::MAX as u64 {
                return Err(invalid());
            }
            let final_page = page.offset == self.tail.offset;
            // RFC 7845 permits an initial positive granule offset. If the first audio page
            // is also the last, a smaller granule instead denotes padding at the end.
            let start = self
                .prev_granule
                .unwrap_or_else(|| page.granule.saturating_sub(total));
            let end = start.checked_add(total).ok_or_else(invalid)?;
            if page.granule < start || page.granule > end || (!final_page && page.granule != end) {
                return Err(invalid());
            }
            for packet in &mut self.packets {
                packet.start += start;
            }
            self.prev_granule = Some(page.granule);
        }
        Ok(())
    }
}

// RFC 6716 section 3.2 defines how to read packet duration from the TOC and frame count.
fn packet_frames(data: &[u8]) -> Option<usize> {
    let toc = *data.first()?;
    let config = toc >> 3;
    let frames_per_element = match config {
        0..=11 => [480, 960, 1_920, 2_880][usize::from(config & 3)],
        12..=15 => [480, 960][usize::from(config & 1)],
        _ => [120, 240, 480, 960][usize::from(config & 3)],
    };
    let elements = match toc & 3 {
        0 => 1,
        1 | 2 => 2,
        _ => usize::from(*data.get(1)? & 0x3f),
    };
    let frames = frames_per_element * elements;
    (1..=MAX_PACKET_FRAMES).contains(&frames).then_some(frames)
}

#[derive(Clone, Copy)]
struct PageInfo {
    offset: u64,
    next_offset: u64,
    granule: u64,
    serial: u32,
    sequence: u32,
    flags: u8,
    ends_continued: bool,
}

struct Input {
    file: File,
    length: u64,
    remaining: usize,
}

impl Input {
    fn read_page(&mut self, offset: u64) -> io::Result<(PageInfo, OggPage)> {
        self.file.seek(SeekFrom::Start(offset))?;
        let mut header = [0; 27];
        self.read_exact(offset, &mut header)?;
        if !header.starts_with(b"OggS")
            || header[5] & !7 != 0
            || (header[26] == 0 && header[5] & 1 != 0)
        {
            return Err(invalid());
        }
        let (mut parser, segment_count) = PageParser::new(header).map_err(io::Error::other)?;
        let mut segments = vec![0; segment_count];
        self.read_exact(offset + 27, &mut segments)?;
        let ends_continued = segments.last() == Some(&255);
        let mut body = vec![0; parser.parse_segments(segments)];
        let body_offset = offset + 27 + segment_count as u64;
        self.read_exact(body_offset, &mut body)?;
        let info = PageInfo {
            offset,
            next_offset: body_offset + body.len() as u64,
            granule: u64::from_le_bytes(header[6..14].try_into().unwrap()),
            serial: u32::from_le_bytes(header[14..18].try_into().unwrap()),
            sequence: u32::from_le_bytes(header[18..22].try_into().unwrap()),
            flags: header[5],
            ends_continued,
        };
        let page = parser.parse_packet_data(body).map_err(io::Error::other)?;
        Ok((info, page))
    }

    fn tail(&mut self) -> io::Result<PageInfo> {
        let start = self.length.saturating_sub(MAX_PAGE_BYTES as u64);
        let bytes = self.window(start, self.length)?;
        for (index, magic) in bytes.windows(4).enumerate().rev() {
            if magic == b"OggS"
                && let Ok((page, _)) = self.read_page(start + index as u64)
                && page.next_offset == self.length
                && page.flags & 4 != 0
                && !page.ends_continued
            {
                return Ok(page);
            }
        }
        Err(invalid())
    }

    fn find_page(&mut self, start: u64, end: u64, serial: u32) -> io::Result<Option<PageInfo>> {
        let bytes = self.window(start, (end + 3).min(self.length))?;
        for (index, magic) in bytes.windows(4).enumerate() {
            if magic == b"OggS"
                && let Ok((page, _)) = self.read_page(start + index as u64)
                && page.serial == serial
                && page.flags & 6 == 0
                && page.granule <= i64::MAX as u64
            {
                return Ok(Some(page));
            }
        }
        Ok(None)
    }

    fn window(&mut self, start: u64, end: u64) -> io::Result<Vec<u8>> {
        let mut bytes = vec![0; (end - start) as usize];
        self.file.seek(SeekFrom::Start(start))?;
        self.read_exact(start, &mut bytes)?;
        Ok(bytes)
    }

    fn read_exact(&mut self, offset: u64, bytes: &mut [u8]) -> io::Result<()> {
        if bytes.len() as u64 > self.length.saturating_sub(offset) {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        self.remaining = self
            .remaining
            .checked_sub(bytes.len())
            .ok_or_else(invalid)?;
        self.file.read_exact(bytes)
    }
}

fn invalid() -> io::Error {
    io::ErrorKind::InvalidData.into()
}
