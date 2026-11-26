use std::{
    fs::File,
    io::{self, BufReader, Read, Seek, SeekFrom},
};

use hound::{Sample, SampleFormat};

use super::{
    EngineOpenError,
    source::{AudioInfo, MAX_INPUT_RATE},
};

const MAX_HEADER_CHUNKS: usize = 4_096;
const PCM: u16 = 1;
const IEEE_FLOAT: u16 = 3;
const EXTENSIBLE: u16 = 0xfffe;

// The remaining bytes of the WAVEFORMATEXTENSIBLE PCM/IEEE float subtype GUID.
const SUBTYPE_GUID_SUFFIX: [u8; 14] = [0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];

struct Format {
    channels: u16,
    sample_rate: u32,
    bits_per_sample: u16,
    sample_format: SampleFormat,
}

impl Format {
    fn bytes_per_sample(&self) -> u16 {
        self.bits_per_sample / 8
    }

    fn bytes_per_frame(&self) -> u16 {
        self.channels * self.bytes_per_sample()
    }
}

pub(super) struct WavSource {
    reader: BufReader<File>,
    format: Format,
    info: AudioInfo,
    data_offset: u64,
}

impl WavSource {
    pub(super) fn open(file: File, file_length: u64) -> Result<Self, EngineOpenError> {
        let unsupported = |_| EngineOpenError::UnsupportedAudio;
        let mut reader = BufReader::with_capacity(64 * 1024, file);
        let riff_end = hound::read_wave_header(&mut reader).map_err(unsupported)?;
        if riff_end < 12 || riff_end > file_length {
            return Err(EngineOpenError::UnsupportedAudio);
        }

        let mut format = None;
        let mut position = 12_u64;
        for _ in 0..MAX_HEADER_CHUNKS {
            let data_offset = position + 8;
            if data_offset > riff_end {
                break;
            }
            let mut chunk = [0_u8; 8];
            reader
                .read_exact(&mut chunk)
                .map_err(|_| EngineOpenError::UnsupportedAudio)?;
            let size = le_u32(&chunk, 4);
            let data_end = data_offset + u64::from(size);
            if data_end > riff_end {
                break;
            }

            match &chunk[..4] {
                b"fmt " => format = Some(read_format(&mut reader, size)?),
                b"data" => {
                    let format = format.ok_or(EngineOpenError::UnsupportedAudio)?;
                    let frame_size = u32::from(format.bytes_per_frame());
                    if size == 0 || !size.is_multiple_of(frame_size) {
                        break;
                    }
                    let info = AudioInfo {
                        frames: size / frame_size,
                        sample_rate: format.sample_rate,
                    };
                    return Ok(Self {
                        reader,
                        format,
                        info,
                        data_offset,
                    });
                }
                _ => {}
            }
            // RIFF pads odd-sized chunks to an even byte boundary.
            position = data_end + u64::from(size % 2);
            reader
                .seek(SeekFrom::Start(position))
                .map_err(|_| EngineOpenError::UnsupportedAudio)?;
        }
        Err(EngineOpenError::UnsupportedAudio)
    }

    pub(super) fn info(&self) -> AudioInfo {
        self.info
    }

    pub(super) fn seek_to(&mut self, frame: u32) -> io::Result<()> {
        let offset = self.data_offset + u64::from(frame) * u64::from(self.format.bytes_per_frame());
        self.reader.seek(SeekFrom::Start(offset))?;
        Ok(())
    }

    pub(super) fn read_frame(&mut self) -> hound::Result<[f32; 2]> {
        let left = self.read_sample()?;
        let right = if self.format.channels == 2 {
            self.read_sample()?
        } else {
            left
        };
        Ok([left, right])
    }

    fn read_sample(&mut self) -> hound::Result<f32> {
        let bits = self.format.bits_per_sample;
        let bytes = self.format.bytes_per_sample();
        let format = self.format.sample_format;
        let sample = match (format, bits) {
            (SampleFormat::Float, 64) => {
                let mut raw = [0_u8; 8];
                self.reader.read_exact(&mut raw)?;
                f64::from_le_bytes(raw)
            }
            (SampleFormat::Float, _) => {
                f64::from(f32::read(&mut self.reader, format, bytes, bits)?)
            }
            (SampleFormat::Int, _) => {
                let pcm = i32::read(&mut self.reader, format, bytes, bits)?;
                f64::from(pcm) / (1_u32 << (bits - 1)) as f64
            }
        };
        Ok(if sample.is_finite() {
            sample.clamp(-1.0, 1.0) as f32
        } else {
            0.0
        })
    }
}

fn read_format(reader: &mut impl Read, size: u32) -> Result<Format, EngineOpenError> {
    let unsupported = EngineOpenError::UnsupportedAudio;
    if size < 16 {
        return Err(unsupported);
    }
    let mut bytes = [0_u8; 40];
    let bytes_read = size.min(bytes.len() as u32) as usize;
    reader
        .read_exact(&mut bytes[..bytes_read])
        .map_err(|_| EngineOpenError::UnsupportedAudio)?;

    let mut tag = le_u16(&bytes, 0);
    let channels = le_u16(&bytes, 2);
    let sample_rate = le_u32(&bytes, 4);
    let byte_rate = le_u32(&bytes, 8);
    let block_align = le_u16(&bytes, 12);
    let bits_per_sample = le_u16(&bytes, 14);

    if tag == EXTENSIBLE {
        let extension_size = u32::from(le_u16(&bytes, 16));
        let valid_bits = le_u16(&bytes, 18);
        if size < 40
            || extension_size < 22
            || size < 18 + extension_size
            || valid_bits > bits_per_sample
            || bytes[26..40] != SUBTYPE_GUID_SUFFIX
        {
            return Err(unsupported);
        }
        // Valid PCM bits occupy the high bits of the sample container.
        tag = le_u16(&bytes, 24);
    }

    let sample_format = match (tag, bits_per_sample) {
        (PCM, 8 | 16 | 24 | 32) => SampleFormat::Int,
        (IEEE_FLOAT, 32 | 64) => SampleFormat::Float,
        _ => return Err(unsupported),
    };
    if !matches!(channels, 1 | 2)
        || !(1..=MAX_INPUT_RATE).contains(&sample_rate)
        || block_align != channels * (bits_per_sample / 8)
        || byte_rate != u32::from(block_align) * sample_rate
    {
        return Err(unsupported);
    }
    Ok(Format {
        channels,
        sample_rate,
        bits_per_sample,
        sample_format,
    })
}

fn le_u16(bytes: &[u8], start: usize) -> u16 {
    u16::from_le_bytes([bytes[start], bytes[start + 1]])
}

fn le_u32(bytes: &[u8], start: usize) -> u32 {
    u32::from_le_bytes([
        bytes[start],
        bytes[start + 1],
        bytes[start + 2],
        bytes[start + 3],
    ])
}
