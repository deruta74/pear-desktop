use pear_preview_dsp::equalizer::{EqualizerBand, EqualizerSettings, GraphicMode, MAX_BANDS};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Layout {
    Bands8,
    Bands14,
    Bands20,
    Custom,
}

impl Layout {
    fn graphic(self) -> Option<GraphicMode> {
        match self {
            Self::Bands8 => Some(GraphicMode::Bands8),
            Self::Bands14 => Some(GraphicMode::Bands14),
            Self::Bands20 => Some(GraphicMode::Bands20),
            Self::Custom => None,
        }
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Band {
    frequency_hz: f64,
    gain_db: f64,
    q: f64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Profile {
    enabled: bool,
    layout: Layout,
    preamp_db: f64,
    auto_preamp: bool,
    bands: Vec<Band>,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            enabled: false,
            layout: Layout::Bands8,
            preamp_db: 0.0,
            auto_preamp: true,
            bands: GraphicMode::Bands8
                .flat_bands()
                .into_iter()
                .map(|band| Band {
                    frequency_hz: band.frequency_hz,
                    gain_db: band.gain_db,
                    q: band.q,
                })
                .collect(),
        }
    }
}

impl Profile {
    pub(super) fn disable(&mut self) {
        self.enabled = false;
    }

    pub(super) fn normalize(self) -> Option<Self> {
        let mut profile = self;
        if !(-24.0..=12.0).contains(&profile.preamp_db)
            || profile.bands.len() > MAX_BANDS
            || profile
                .bands
                .iter()
                .any(|band| !(-48.0..=48.0).contains(&band.gain_db))
        {
            return None;
        }
        if let Some(layout) = profile.layout.graphic() {
            let canonical = layout.flat_bands();
            if canonical.len() != profile.bands.len() {
                return None;
            }
            for (band, canonical) in profile.bands.iter_mut().zip(canonical) {
                band.frequency_hz = canonical.frequency_hz;
                band.q = canonical.q;
            }
        } else if profile.bands.iter().any(|band| {
            !(20.0..=20_000.0).contains(&band.frequency_hz) || !(0.05..=1000.0).contains(&band.q)
        }) {
            return None;
        }
        Some(profile)
    }

    pub(super) fn apply(&self, engine: &mut super::engine::Engine) -> Result<(), &'static str> {
        let bands: Vec<_> = self
            .bands
            .iter()
            .map(|band| EqualizerBand {
                frequency_hz: band.frequency_hz,
                gain_db: band.gain_db,
                q: band.q,
            })
            .collect();
        engine
            .set_equalizer(EqualizerSettings {
                bands: &bands,
                manual_preamp_db: self.preamp_db,
                auto_preamp: self.auto_preamp,
                bypass: !self.enabled,
            })
            .map_err(|_| "Could not apply this equalizer profile. Try less gain or lower Q.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixes_graphic_band_centres_and_validates_custom_input() {
        let mut profile = Profile::default();
        profile.bands[0].frequency_hz = 10_000.0;
        profile.bands[0].q = 50.0;
        profile.bands[0].gain_db = 6.0;
        let mut profile = profile.normalize().unwrap();
        assert_eq!(profile.bands[0].frequency_hz, 31.5);
        assert_eq!(profile.bands[0].gain_db, 6.0);
        profile.bands[0].frequency_hz = 19.0;
        profile.layout = Layout::Custom;
        assert!(profile.normalize().is_none());
    }
}
