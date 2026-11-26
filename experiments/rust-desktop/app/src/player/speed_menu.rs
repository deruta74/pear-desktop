use muda::{CheckMenuItem, MenuId, Submenu};

use super::iframe::Snapshot;

pub(super) struct SpeedMenu {
    menu: Submenu,
    choices: Vec<(f64, CheckMenuItem)>,
    checked: Option<Option<f64>>,
}

impl SpeedMenu {
    pub(super) fn new() -> Self {
        Self {
            menu: Submenu::new("Playback Speed", false),
            choices: Vec::new(),
            checked: None,
        }
    }

    pub(super) fn submenu(&self) -> &Submenu {
        &self.menu
    }

    pub(super) fn requested(&mut self, id: &MenuId) -> Option<f64> {
        if !self.menu.is_enabled() {
            return None;
        }
        let rate = self.choices.iter().find(|(_, item)| item.id() == id)?.0;
        // A check item toggles itself. Restore the observed rate until it changes.
        self.checked = None;
        Some(rate)
    }

    pub(super) fn update(&mut self, sample: Option<&Snapshot>) -> muda::Result<()> {
        let available = sample
            .filter(|sample| sample.ready && !sample.blocked && sample.error.is_none())
            .and_then(|sample| sample.playback_rates.as_deref())
            .filter(|rates| rates.len() > 1);
        let Some(available) = available else {
            if self.menu.is_enabled() {
                self.menu.set_enabled(false);
            }
            return Ok(());
        };
        let rate = sample.and_then(|sample| sample.playback_rate);
        if !self
            .choices
            .iter()
            .map(|(value, _)| value)
            .eq(available.iter())
        {
            self.menu.set_enabled(false);
            while let Some((_, item)) = self.choices.last() {
                self.menu.remove(item)?;
                self.choices.pop();
            }
            for &value in available {
                let item = CheckMenuItem::new(format!("{value}×"), true, rate == Some(value), None);
                self.menu.append(&item)?;
                self.choices.push((value, item));
            }
            self.checked = Some(rate);
        } else if self.checked != Some(rate) {
            for (value, item) in &self.choices {
                item.set_checked(rate == Some(*value));
            }
            self.checked = Some(rate);
        }
        if !self.menu.is_enabled() {
            self.menu.set_enabled(true);
        }
        Ok(())
    }
}
