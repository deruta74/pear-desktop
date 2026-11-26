use std::path::Path;

use gtk::{Box as GtkBox, Orientation, prelude::*};
use tao::{platform::unix::WindowExtUnix, window::Window};
use webkit2gtk::WebViewExt as _;
use wry::{WebView, WebViewBuilder, WebViewBuilderExtUnix, WebViewExtUnix};

use super::{PANEL_WIDTH, Pane};
use crate::Result;

pub(in crate::player) struct Layout {
    video: GtkBox,
    queue: GtkBox,
}

impl Layout {
    pub(in crate::player) fn new(window: &Window, _data_dir: &Path) -> Result<Self> {
        let parent = window
            .default_vbox()
            .ok_or("Tao window has no GTK content box")?;
        let row = GtkBox::new(Orientation::Horizontal, 0);
        let video = GtkBox::new(Orientation::Vertical, 0);
        let queue = GtkBox::new(Orientation::Vertical, 0);

        queue.set_size_request(PANEL_WIDTH, -1);
        queue.set_hexpand(false);
        queue.set_no_show_all(true);
        row.pack_start(&video, true, true, 0);
        row.pack_start(&queue, false, true, 0);
        parent.pack_start(&row, true, true, 0);
        video.show();
        row.show();

        Ok(Self { video, queue })
    }

    pub(in crate::player) fn build(
        &self,
        _window: &Window,
        configure: impl for<'a> FnOnce(WebViewBuilder<'a>) -> WebViewBuilder<'a>,
        pane: Pane,
        queue_visible: bool,
    ) -> Result<WebView> {
        let holder = match pane {
            Pane::Video => &self.video,
            Pane::Controls => &self.queue,
        };
        // Wry destroys its GTK widget on drop, which removes it from the holder.
        let view = configure(WebViewBuilder::new())
            .with_visible(true)
            .build_gtk(holder)?;
        self.queue.set_visible(queue_visible);
        Ok(view)
    }

    pub(in crate::player) fn arrange(
        &self,
        _window: &Window,
        _player: Option<&WebView>,
        _controls: &WebView,
        queue_visible: bool,
    ) -> Result<()> {
        self.queue.set_visible(queue_visible);
        Ok(())
    }
}

pub(in crate::player) fn observe_video(
    view: &WebView,
    url: &str,
    on_problem: impl Fn(&'static str) + Clone + 'static,
) {
    let expected_url = url.to_owned();
    let failed = on_problem.clone();
    let native = view.webview();
    native.connect_load_failed(move |_, _, url, _| {
        if url == expected_url {
            failed("Could not load the video player. Use Reload Player or Open in browser.");
        }
        false
    });
    native.connect_web_process_terminated(move |_, _| {
        on_problem("The video player stopped. Use Reload Player or Open in browser.");
    });
}
