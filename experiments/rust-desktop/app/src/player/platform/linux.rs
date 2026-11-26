use std::{
    path::Path,
    time::{Duration, Instant},
};

use gtk::{Box as GtkBox, Orientation, glib, prelude::*};
use tao::{platform::unix::WindowExtUnix, window::Window};
use webkit2gtk::WebViewExt as _;
use wry::{WebView, WebViewBuilder, WebViewBuilderExtUnix, WebViewExtUnix};

use super::{PANEL_WIDTH, Pane};
use crate::Result;

#[derive(Default)]
pub(in crate::player) struct DeadlineTimer(Option<(Instant, glib::Source)>);

impl DeadlineTimer {
    pub(in crate::player) fn schedule(&mut self, deadline: Option<Instant>) -> Option<Instant> {
        if let (Some(next), Some((scheduled, source))) = (deadline, self.0.as_ref())
            && *scheduled <= next
            && !source.is_destroyed()
        {
            // Tao must wait for the same wakeup the attached source will provide.
            return Some(*scheduled);
        }
        self.cancel();
        let deadline = deadline?;

        // Tao's Linux WaitUntil can block in GTK without arming a wakeup.
        // Round up so GTK cannot wake Tao just before the requested time.
        let delay = deadline.saturating_duration_since(Instant::now());
        let millis =
            delay.as_millis() + u128::from(!delay.subsec_nanos().is_multiple_of(1_000_000));
        let timeout = Duration::from_millis(millis.min(u128::from(u32::MAX)) as u64);
        let source = glib::timeout_source_new(timeout, None, glib::Priority::DEFAULT, || {
            glib::ControlFlow::Break
        });
        source.attach(None);
        self.0 = Some((deadline, source));
        Some(deadline)
    }

    fn cancel(&mut self) {
        if let Some((_, source)) = self.0.take() {
            source.destroy();
        }
    }
}

impl Drop for DeadlineTimer {
    fn drop(&mut self) {
        self.cancel();
    }
}

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

#[cfg(test)]
mod timer_tests {
    use super::*;

    #[test]
    fn retaining_an_earlier_source_also_retains_its_wake_time() {
        let mut timer = DeadlineTimer::default();
        let early = Instant::now() + Duration::from_secs(10);
        assert_eq!(timer.schedule(Some(early)), Some(early));
        assert_eq!(
            timer.schedule(Some(early + Duration::from_millis(1))),
            Some(early)
        );
        assert_eq!(timer.schedule(None), None);
    }
}
