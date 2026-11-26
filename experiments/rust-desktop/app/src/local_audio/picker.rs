use std::path::PathBuf;

use tao::{event_loop::EventLoopProxy, window::Window};

use super::AudioEvent;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Folder,
    Lyrics(u64),
}

impl Kind {
    fn title(self) -> &'static str {
        match self {
            Self::Folder => "Open audio folder",
            Self::Lyrics(_) => "Open lyrics file",
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod native_picker {
    use std::{
        future::Future,
        pin::Pin,
        sync::Arc,
        task::{Context, Poll, Wake, Waker},
    };

    use super::{AudioEvent, EventLoopProxy, Kind, PathBuf, Window};

    pub(in crate::local_audio) struct Picker {
        dialog: Pin<Box<dyn Future<Output = Option<rfd::FileHandle>>>>,
        waker: Waker,
    }

    struct PickerWake {
        kind: Kind,
        events: EventLoopProxy<AudioEvent>,
    }

    impl Wake for PickerWake {
        fn wake(self: Arc<Self>) {
            let _ = self.events.send_event(AudioEvent::PickerReady(self.kind));
        }
    }

    impl Picker {
        pub(in crate::local_audio) fn poll(&mut self) -> Poll<Option<PathBuf>> {
            self.dialog
                .as_mut()
                .poll(&mut Context::from_waker(&self.waker))
                .map(|file| file.map(|file| file.path().to_path_buf()))
        }
    }

    pub(in crate::local_audio) fn open(
        window: &Window,
        kind: Kind,
        events: EventLoopProxy<AudioEvent>,
    ) -> Picker {
        let dialog = rfd::AsyncFileDialog::new()
            .set_parent(window)
            .set_title(kind.title());
        let _ = events.send_event(AudioEvent::PickerReady(kind));
        Picker {
            dialog: match kind {
                Kind::Folder => Box::pin(dialog.pick_folder()),
                Kind::Lyrics(_) => Box::pin(dialog.add_filter("LRC files", &["lrc"]).pick_file()),
            },
            waker: Waker::from(Arc::new(PickerWake { kind, events })),
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(super) use native_picker::{Picker, open};

#[cfg(target_os = "linux")]
pub(super) struct Picker(gtk::FileChooserNative);

#[cfg(target_os = "linux")]
impl Drop for Picker {
    fn drop(&mut self) {
        use gtk::prelude::NativeDialogExt;
        self.0.destroy();
    }
}

#[cfg(target_os = "linux")]
pub(super) fn open(window: &Window, kind: Kind, events: EventLoopProxy<AudioEvent>) -> Picker {
    use gtk::prelude::{FileChooserExt, NativeDialogExt};
    use tao::platform::unix::WindowExtUnix;

    let dialog = gtk::FileChooserNative::new(
        Some(kind.title()),
        Some(window.gtk_window()),
        match kind {
            Kind::Folder => gtk::FileChooserAction::SelectFolder,
            Kind::Lyrics(_) => gtk::FileChooserAction::Open,
        },
        Some("Open"),
        Some("Cancel"),
    );
    if matches!(kind, Kind::Lyrics(_)) {
        let filter = gtk::FileFilter::new();
        filter.set_name(Some("LRC files"));
        filter.add_pattern("*.[lL][rR][cC]");
        dialog.add_filter(filter);
    }
    dialog.set_modal(true);
    dialog.connect_response(move |dialog, response| {
        let path = if response == gtk::ResponseType::Accept {
            dialog.filename()
        } else {
            None
        };
        let _ = events.send_event(AudioEvent::PickerSelected(kind, path));
    });
    dialog.show();
    Picker(dialog)
}
