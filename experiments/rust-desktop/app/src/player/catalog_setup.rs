use std::path::PathBuf;

use tao::window::Window;

use super::preferences::Preferences;

const TITLE: &str = "YouTube Data API key file";

pub(super) fn update(
    window: &Window,
    preferences: &mut Preferences,
    forget: bool,
    launch_override: bool,
) {
    let path = if forget {
        None
    } else {
        let Some(path) = choose_key_file(window) else {
            return;
        };
        Some(path)
    };
    match preferences.set_youtube_key_file(path) {
        Ok(()) => {
            let change = if forget {
                "Pear forgot the saved key file location. This takes effect the next time you open Pear."
            } else {
                "The next time you open Pear, it can use this key file for YouTube video details and public search. Data API requests use your Google Cloud project's quota."
            };
            let message = if launch_override {
                format!("{change}\n\nThe launch override takes priority while it is set.")
            } else {
                change.to_owned()
            };
            show_feedback(window, &message, false);
        }
        Err(problem) => show_feedback(window, problem, true),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn choose_key_file(window: &Window) -> Option<PathBuf> {
    rfd::FileDialog::new()
        .set_parent(window)
        .set_title("Choose a YouTube Data API key file")
        .pick_file()
}

#[cfg(target_os = "linux")]
fn choose_key_file(window: &Window) -> Option<PathBuf> {
    use gtk::prelude::{FileChooserExt, NativeDialogExt};
    use tao::platform::unix::WindowExtUnix;

    let dialog = gtk::FileChooserNative::new(
        Some("Choose a YouTube Data API key file"),
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
fn show_feedback(window: &Window, message: &str, error: bool) {
    let level = if error {
        rfd::MessageLevel::Error
    } else {
        rfd::MessageLevel::Info
    };
    rfd::MessageDialog::new()
        .set_parent(window)
        .set_level(level)
        .set_title(TITLE)
        .set_description(message)
        .show();
}

#[cfg(target_os = "linux")]
fn show_feedback(window: &Window, message: &str, error: bool) {
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
    dialog.set_title(TITLE);
    dialog.run();
    dialog.close();
}
