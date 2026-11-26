use std::path::PathBuf;

use muda::{MenuId, MenuItem};
use tao::window::Window;

use super::preferences::Preferences;

#[derive(Clone, Copy)]
pub(super) enum FileKind {
    ApiKey,
    OAuthClient,
}

pub(super) struct SetupMenu {
    kind: FileKind,
    pub(super) choose: MenuItem,
    pub(super) forget: MenuItem,
}

impl SetupMenu {
    pub(super) fn new(kind: FileKind, preferences: Option<&Preferences>) -> Self {
        let (choose, forget) = match kind {
            FileKind::ApiKey => (
                "Set YouTube Data API Key File…",
                "Forget YouTube Data API Key File",
            ),
            FileKind::OAuthClient => (
                "Set Google Desktop OAuth Client File…",
                "Forget Google Desktop OAuth Client File",
            ),
        };
        Self {
            kind,
            choose: MenuItem::new(choose, preferences.is_some(), None),
            forget: MenuItem::new(
                forget,
                preferences.is_some_and(|preferences| kind.has_saved(preferences)),
                None,
            ),
        }
    }

    pub(super) fn refresh(&self, preferences: Option<&Preferences>) {
        self.choose.set_enabled(preferences.is_some());
        self.forget
            .set_enabled(preferences.is_some_and(|preferences| self.kind.has_saved(preferences)));
    }

    pub(super) fn matches(&self, id: &MenuId) -> bool {
        id == self.choose.id() || id == self.forget.id()
    }

    pub(super) fn update(
        &self,
        id: &MenuId,
        window: &Window,
        preferences: &mut Preferences,
        launch_override: bool,
    ) {
        let forget = id == self.forget.id();
        if forget && !self.kind.has_saved(preferences) {
            return;
        }
        let (title, prompt, saved, forgotten) = match self.kind {
            FileKind::ApiKey => (
                "YouTube Data API key file",
                "Choose a YouTube Data API key file",
                "The next time you open Pear, it can use this key file for YouTube video details and public search. Data API requests use your Google Cloud project's quota.",
                "Pear forgot the saved key file location. This takes effect the next time you open Pear.",
            ),
            FileKind::OAuthClient => (
                "Google Desktop OAuth client file",
                "Choose a Google Desktop OAuth client JSON file",
                "Open Pear again to use this client file. Then choose Connect under Library → YouTube account to grant read-only access.",
                "Pear forgot the saved OAuth client file location. This takes effect the next time you open Pear.",
            ),
        };
        let path = if forget {
            None
        } else {
            let Some(path) = choose_file(window, prompt) else {
                return;
            };
            Some(path)
        };
        let result = match self.kind {
            FileKind::ApiKey => preferences.set_youtube_key_file(path),
            FileKind::OAuthClient => preferences.set_youtube_oauth_client_file(path),
        };
        match result {
            Ok(()) => {
                let change = if forget { forgotten } else { saved };
                let message = if launch_override {
                    format!("{change}\n\nThe launch override takes priority while it is set.")
                } else {
                    change.to_owned()
                };
                self.refresh(Some(preferences));
                show_feedback(window, title, &message, false);
            }
            Err(problem) => show_feedback(window, title, problem, true),
        }
    }
}

impl FileKind {
    fn has_saved(self, preferences: &Preferences) -> bool {
        match self {
            Self::ApiKey => preferences.youtube_key_file().is_some(),
            Self::OAuthClient => preferences.youtube_oauth_client_file().is_some(),
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn choose_file(window: &Window, prompt: &str) -> Option<PathBuf> {
    rfd::FileDialog::new()
        .set_parent(window)
        .set_title(prompt)
        .pick_file()
}

#[cfg(target_os = "linux")]
fn choose_file(window: &Window, prompt: &str) -> Option<PathBuf> {
    use gtk::prelude::{FileChooserExt, NativeDialogExt};
    use tao::platform::unix::WindowExtUnix;

    let dialog = gtk::FileChooserNative::new(
        Some(prompt),
        Some(window.gtk_window()),
        gtk::FileChooserAction::Open,
        Some("Open"),
        Some("Cancel"),
    );
    dialog.set_local_only(true);
    if dialog.run() == gtk::ResponseType::Accept {
        dialog.filename()
    } else {
        None
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn show_feedback(window: &Window, title: &str, message: &str, error: bool) {
    let level = if error {
        rfd::MessageLevel::Error
    } else {
        rfd::MessageLevel::Info
    };
    rfd::MessageDialog::new()
        .set_parent(window)
        .set_level(level)
        .set_title(title)
        .set_description(message)
        .show();
}

#[cfg(target_os = "linux")]
fn show_feedback(window: &Window, title: &str, message: &str, error: bool) {
    use gtk::prelude::{DialogExt, GtkWindowExt};
    use tao::platform::unix::WindowExtUnix;

    let level = if error {
        gtk::MessageType::Error
    } else {
        gtk::MessageType::Info
    };
    let dialog = gtk::MessageDialog::new(
        Some(window.gtk_window()),
        gtk::DialogFlags::MODAL,
        level,
        gtk::ButtonsType::Ok,
        message,
    );
    dialog.set_title(title);
    dialog.run();
    dialog.close();
}
