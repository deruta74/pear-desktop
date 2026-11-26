use std::{
    fs::File,
    io::{self, BufReader, Cursor, Read, Seek, SeekFrom},
};

use symphonia::core::units::TimeBase;

use super::AAC_FRAMES;

const MAX_BOXES: usize = 256;
const MAX_INDEX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_AAC_BYTES: u32 = 8 * 1024;

pub(super) struct Timing {
    pub(super) media_frames: u32,
    pub(super) edit: Option<Edit>,
}

pub(super) struct Edit {
    start: u32,
    duration: u64,
}

impl Edit {
    pub(super) fn bounds(
        self,
        clock: TimeBase,
        sample_rate: u32,
        media_frames: u32,
    ) -> Option<(u32, u32)> {
        let ticks_per_second = u128::from(clock.denom.get());
        let frames_per_tick = u128::from(clock.numer.get()) * u128::from(sample_rate);
        let duration = u128::from(self.duration) * frames_per_tick;
        let available = media_frames.checked_sub(self.start)?;
        // A coarse movie clock can round the edit past the shortened final packet.
        if duration > u128::from(available) * ticks_per_second + frames_per_tick {
            return None;
        }
        let frames = ((duration + ticks_per_second / 2) / ticks_per_second)
            .min(u128::from(available)) as u32;
        (frames > 0).then_some((self.start, frames))
    }
}

#[derive(Clone, Copy)]
struct Atom {
    kind: [u8; 4],
    start: u64,
    end: u64,
}

// Symphonia handles demuxing. Preflight bounds the sample sizes it allocates and
// reads the simple edit list that Symphonia 0.6.1 parses but does not apply.
pub(super) fn inspect(file: &mut File, length: u64) -> io::Result<Timing> {
    let mut input = BufReader::new(file);
    let file = atoms(&mut input, 0, length)?;
    if !file.first().is_some_and(|atom| &atom.kind == b"ftyp")
        || find(&file, b"ftyp")?.is_none_or(|atom| atom.end > 4096)
        || find(&file, b"meta")?.is_some_and(|atom| atom.end - atom.start > MAX_INDEX_BYTES)
        || file
            .iter()
            .any(|atom| matches!(&atom.kind, b"moof" | b"pssh" | b"sidx"))
    {
        return invalid();
    }
    let mdat = require(&file, b"mdat")?;
    let moov = require(&file, b"moov")?;
    if moov.end - moov.start > MAX_INDEX_BYTES {
        return invalid();
    }
    let mut index = vec![0; (moov.end - moov.start) as usize];
    input.seek(SeekFrom::Start(moov.start))?;
    input.read_exact(&mut index)?;
    let mut input = Cursor::new(index.as_slice());
    let movie = atoms(&mut input, 0, index.len() as u64)?;
    if movie
        .iter()
        .any(|atom| matches!(&atom.kind, b"mvex" | b"pssh"))
    {
        return invalid();
    }
    let track = children(&mut input, &movie, b"trak")?;
    let edit = find(&track, b"edts")?
        .map(|atom| read_edit(&mut input, atom))
        .transpose()?;
    let media = children(&mut input, &track, b"mdia")?;
    let info = children(&mut input, &media, b"minf")?;
    let table = children(&mut input, &info, b"stbl")?;
    let (count, frames) = read_timing(payload(&index, require(&table, b"stts")?))?;
    check_chunks(&index, &table, mdat, count)?;
    Ok(Timing {
        media_frames: frames,
        edit,
    })
}

fn read_edit(input: &mut (impl Read + Seek), atom: Atom) -> io::Result<Edit> {
    let list = children(input, &[atom], b"edts")?;
    let entry = require(&list, b"elst")?;
    input.seek(SeekFrom::Start(entry.start))?;
    let version = read_u32(input)?;
    let count = read_u32(input)?;
    let (duration, start) = match (count, version, entry.end - entry.start) {
        (1, 0, 20) => (
            u64::from(read_u32(input)?),
            i64::from(read_u32(input)? as i32),
        ),
        (1, 0x0100_0000, 28) => (read_u64(input)?, read_u64(input)? as i64),
        _ => return invalid(),
    };
    let start = u32::try_from(start).map_err(|_| io::ErrorKind::InvalidData)?;
    if read_u32(input)? != 0x0001_0000 || duration == 0 {
        return invalid();
    }
    Ok(Edit { start, duration })
}

fn read_timing(bytes: &[u8]) -> io::Result<(u32, u32)> {
    let mut input = Cursor::new(bytes);
    let version = read_u32(&mut input)?;
    let entries = read_u32(&mut input)?;
    if version != 0 || !(1..=2).contains(&entries) || bytes.len() != 8 + 8 * entries as usize {
        return invalid();
    }
    let mut packets = 0u32;
    let mut frames = 0u32;
    for index in 0..entries {
        let count = read_u32(&mut input)?;
        let duration = read_u32(&mut input)?;
        // The last packet may declare only the frames before the trailing padding.
        if count == 0
            || !(1..=AAC_FRAMES).contains(&duration)
            || (duration != AAC_FRAMES && (index + 1 != entries || count != 1))
        {
            return invalid();
        }
        frames = count
            .checked_mul(duration)
            .and_then(|span| frames.checked_add(span))
            .ok_or(io::ErrorKind::InvalidData)?;
        packets += count;
    }
    Ok((packets, frames))
}

fn check_chunks(index: &[u8], table: &[Atom], mdat: Atom, packets: u32) -> io::Result<()> {
    let offset = match (find(table, b"stco")?, find(table, b"co64")?) {
        (Some(atom), None) => atom,
        (None, Some(atom)) => atom,
        _ => return invalid(),
    };
    let bytes = payload(index, offset);
    let mut offsets = Cursor::new(bytes);
    let version = read_u32(&mut offsets)?;
    let chunks = read_u32(&mut offsets)?;
    let wide = &offset.kind == b"co64";
    let width = if wide { 8 } else { 4 };
    if version != 0
        || !(1..=packets).contains(&chunks)
        || bytes.len() != 8 + width * chunks as usize
    {
        return invalid();
    }
    let bytes = payload(index, require(table, b"stsc")?);
    let mut map = Cursor::new(bytes);
    let version = read_u32(&mut map)?;
    let groups = read_u32(&mut map)?;
    if version != 0 || !(1..=chunks).contains(&groups) || bytes.len() != 8 + 12 * groups as usize {
        return invalid();
    }
    let bytes = payload(index, require(table, b"stsz")?);
    let mut sizes = Cursor::new(bytes);
    let version = read_u32(&mut sizes)?;
    let fixed_size = read_u32(&mut sizes)?;
    let count = read_u32(&mut sizes)?;
    let variable_bytes = if fixed_size == 0 {
        4 * packets as usize
    } else {
        0
    };
    if version != 0
        || fixed_size > MAX_AAC_BYTES
        || count != packets
        || bytes.len() != 12 + variable_bytes
    {
        return invalid();
    }

    let (mut chunk, mut packets_per_chunk) = read_chunk_group(&mut map)?;
    if chunk != 1 {
        return invalid();
    }
    let mut remaining = packets;
    let mut previous_end = mdat.start;
    for group in 0..groups {
        let (next, next_packets) = if group + 1 == groups {
            (chunks + 1, 0)
        } else {
            read_chunk_group(&mut map)?
        };
        if next <= chunk || next > chunks + 1 || (next > chunks && group + 1 != groups) {
            return invalid();
        }
        remaining = (next - chunk)
            .checked_mul(packets_per_chunk)
            .and_then(|count| remaining.checked_sub(count))
            .ok_or(io::ErrorKind::InvalidData)?;
        for _ in chunk..next {
            let start = if wide {
                read_u64(&mut offsets)?
            } else {
                u64::from(read_u32(&mut offsets)?)
            };
            let mut length = u64::from(fixed_size) * u64::from(packets_per_chunk);
            if fixed_size == 0 {
                for _ in 0..packets_per_chunk {
                    let size = read_u32(&mut sizes)?;
                    if !(1..=MAX_AAC_BYTES).contains(&size) {
                        return invalid();
                    }
                    length += u64::from(size);
                }
            }
            let end = start
                .checked_add(length)
                .ok_or(io::ErrorKind::InvalidData)?;
            if start < previous_end || end > mdat.end {
                return invalid();
            }
            previous_end = end;
        }
        chunk = next;
        packets_per_chunk = next_packets;
    }
    if remaining != 0 {
        return invalid();
    }
    Ok(())
}

fn read_chunk_group(input: &mut impl Read) -> io::Result<(u32, u32)> {
    let first_chunk = read_u32(input)?;
    let packets_per_chunk = read_u32(input)?;
    if packets_per_chunk == 0 || read_u32(input)? != 1 {
        return invalid();
    }
    Ok((first_chunk, packets_per_chunk))
}

fn payload(index: &[u8], atom: Atom) -> &[u8] {
    // Nested atom ranges have already been validated against the moov buffer.
    &index[atom.start as usize..atom.end as usize]
}

fn find(atoms: &[Atom], kind: &[u8; 4]) -> io::Result<Option<Atom>> {
    let mut matches = atoms.iter().filter(|atom| &atom.kind == kind);
    let first = matches.next().copied();
    if matches.next().is_some() {
        return invalid();
    }
    Ok(first)
}

fn require(atoms: &[Atom], kind: &[u8; 4]) -> io::Result<Atom> {
    find(atoms, kind)?.ok_or(io::ErrorKind::InvalidData.into())
}

fn children(
    input: &mut (impl Read + Seek),
    parent: &[Atom],
    kind: &[u8; 4],
) -> io::Result<Vec<Atom>> {
    let atom = require(parent, kind)?;
    atoms(input, atom.start, atom.end)
}

fn atoms(input: &mut (impl Read + Seek), mut position: u64, end: u64) -> io::Result<Vec<Atom>> {
    let mut atoms = Vec::new();
    while position < end {
        if atoms.len() == MAX_BOXES || end - position < 8 {
            return invalid();
        }
        input.seek(SeekFrom::Start(position))?;
        let size = read_u32(input)?;
        let mut kind = [0; 4];
        input.read_exact(&mut kind)?;
        let (size, header) = match size {
            0 => (end - position, 8),
            1 if end - position >= 16 => (read_u64(input)?, 16),
            1 => return invalid(),
            size => (u64::from(size), 8),
        };
        if !(header..=end - position).contains(&size) {
            return invalid();
        }
        atoms.push(Atom {
            kind,
            start: position + header,
            end: position + size,
        });
        position += size;
    }
    Ok(atoms)
}

fn read_u32(input: &mut impl Read) -> io::Result<u32> {
    let mut bytes = [0; 4];
    input.read_exact(&mut bytes)?;
    Ok(u32::from_be_bytes(bytes))
}

fn read_u64(input: &mut impl Read) -> io::Result<u64> {
    let mut bytes = [0; 8];
    input.read_exact(&mut bytes)?;
    Ok(u64::from_be_bytes(bytes))
}

fn invalid<T>() -> io::Result<T> {
    Err(io::ErrorKind::InvalidData.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_audio::engine::tests::Fixture;

    #[test]
    fn m4a_preflight_rejects_overlapping_or_out_of_range_chunks() {
        let original = include_bytes!("../fixtures/mono-edit.m4a");
        let field = |name| original.windows(4).position(|bytes| bytes == name).unwrap();
        let mut media = original.to_vec();
        // The fixture has 12 packets in one chunk. Split it into two 6-packet chunks.
        let sizes = field(b"stsz") + 16;
        let first_chunk_size: u32 = original[sizes..sizes + 6 * 4]
            .as_chunks::<4>()
            .0
            .iter()
            .copied()
            .map(u32::from_be_bytes)
            .sum();
        let chunk_samples = field(b"stsc") + 16;
        media[chunk_samples..chunk_samples + 4].copy_from_slice(&6u32.to_be_bytes());
        let chunk_count = field(b"stco") + 8;
        media[chunk_count..chunk_count + 4].copy_from_slice(&2u32.to_be_bytes());
        let first_chunk_offset = u32::from_be_bytes(
            original[chunk_count + 4..chunk_count + 8]
                .try_into()
                .unwrap(),
        );
        let next_chunk_offset = first_chunk_offset + first_chunk_size;
        let entry = chunk_count + 8;
        media.splice(entry..entry, next_chunk_offset.to_be_bytes());
        for name in [b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stco"] {
            let size = field(name) - 4;
            let updated = u32::from_be_bytes(original[size..size + 4].try_into().unwrap()) + 4;
            media[size..size + 4].copy_from_slice(&updated.to_be_bytes());
        }

        let inspect_fixture = |bytes: &[u8]| {
            let fixture = Fixture::with_extension(bytes, "m4a");
            inspect(&mut File::open(&fixture.0).unwrap(), bytes.len() as u64)
        };
        assert!(inspect_fixture(&media).is_ok());
        for bad_offset in [next_chunk_offset - 1, next_chunk_offset + 1] {
            media[entry..entry + 4].copy_from_slice(&bad_offset.to_be_bytes());
            assert!(
                inspect_fixture(&media).is_err(),
                "chunk starts at {bad_offset}"
            );
        }
    }
}
