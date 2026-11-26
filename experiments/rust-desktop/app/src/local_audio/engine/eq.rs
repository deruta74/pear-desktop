use pear_preview_dsp::equalizer::StereoEqualizer;
use rtrb::{Consumer, Producer, PushError, RingBuffer};

pub(super) struct Updates {
    producer: Producer<Option<StereoEqualizer>>,
    pending: Option<Option<StereoEqualizer>>,
}

impl Updates {
    pub(super) fn new(rate: u32) -> (Self, Tone) {
        let (producer, consumer) = RingBuffer::new(1);
        (
            Self {
                producer,
                pending: None,
            },
            Tone {
                consumer,
                current: None,
                previous: None,
                fade_frames: (rate / 50).max(1),
                remaining: 0,
                volume: 1.0,
            },
        )
    }

    pub(super) fn replace(&mut self, settings: Option<StereoEqualizer>) {
        self.pending = Some(settings);
        self.flush();
    }

    pub(super) fn flush(&mut self) {
        if let Some(pending) = self.pending.take()
            && let Err(PushError::Full(pending)) = self.producer.push(pending)
        {
            self.pending = Some(pending);
        }
    }
}

pub(super) struct Tone {
    consumer: Consumer<Option<StereoEqualizer>>,
    current: Option<StereoEqualizer>,
    previous: Option<StereoEqualizer>,
    fade_frames: u32,
    remaining: u32,
    volume: f32,
}

impl Tone {
    pub(super) fn update(&mut self, volume: f32, active: bool) {
        if !active && self.remaining != 0 {
            self.previous = None;
            self.remaining = 0;
        }
        if self.remaining == 0
            && let Ok(next) = self.consumer.pop()
        {
            self.previous = std::mem::replace(&mut self.current, next);
            if active {
                self.remaining = self.fade_frames;
            } else {
                self.previous = None;
            }
            if let Some(current) = &mut self.current {
                current.set_source_volume(f64::from(volume));
            }
        }
        if self.volume != volume {
            self.volume = volume;
            for profile in [&mut self.current, &mut self.previous]
                .into_iter()
                .flatten()
            {
                profile.set_source_volume(f64::from(volume));
            }
        }
    }

    pub(super) fn process(&mut self, input: [f32; 2]) -> [f32; 2] {
        let current = self
            .current
            .as_mut()
            .map_or(input, |profile| profile.process_frame(input));
        if self.remaining == 0 {
            return current;
        }
        let previous = self
            .previous
            .as_mut()
            .map_or(input, |profile| profile.process_frame(input));
        self.remaining -= 1;
        let amount = 1.0 - self.remaining as f64 / self.fade_frames as f64;
        if self.remaining == 0 {
            self.previous = None;
        }
        std::array::from_fn(|index| {
            (f64::from(previous[index]) * (1.0 - amount) + f64::from(current[index]) * amount)
                as f32
        })
    }

    pub(super) fn reset(&mut self) {
        self.previous = None;
        self.remaining = 0;
        if let Some(profile) = &mut self.current {
            profile.reset();
        }
    }

    pub(super) fn has_tail(&self) -> bool {
        [&self.current, &self.previous]
            .into_iter()
            .flatten()
            .any(StereoEqualizer::has_filters)
    }
}

#[cfg(test)]
mod tests {
    use pear_preview_dsp::equalizer::EqualizerSettings;

    use super::*;

    fn with_preamp(db: f64) -> Option<StereoEqualizer> {
        Some(
            StereoEqualizer::new(
                48_000,
                EqualizerSettings {
                    manual_preamp_db: db,
                    ..EqualizerSettings::default()
                },
                1.0,
            )
            .unwrap(),
        )
    }

    #[test]
    fn crossfades_profiles_and_retains_the_latest_pending_update() {
        let (mut updates, mut tone) = Updates::new(48_000);
        let input = [0.2, -0.2];
        updates.replace(with_preamp(6.0));
        tone.update(1.0, true);
        let first = tone.process(input);
        assert!((0.2..0.21).contains(&first[0]));
        for _ in 1..960 {
            tone.process(input);
        }
        assert!(tone.process(input)[0] > 0.39);
        updates.replace(with_preamp(-6.0));
        updates.replace(with_preamp(12.0));
        updates.replace(None);
        tone.update(1.0, true);
        updates.flush();
        for _ in 0..960 {
            tone.process(input);
        }
        assert!(tone.process(input)[0] < 0.11);
        tone.update(1.0, true);
        for _ in 0..960 {
            tone.process(input);
        }
        assert_eq!(tone.process(input), input);
    }
}
