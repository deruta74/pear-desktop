use std::path::{Path, PathBuf};

use tao::window::Window;
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    },
    ProcessFailedEventHandler,
};
use wry::{WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

use super::{Pane, child_bounds};

pub(in crate::player) struct Layout {
    webview_data_dir: PathBuf,
}

pub(in crate::player) fn observe_video(
    view: &WebView,
    on_problem: impl Fn(&'static str) + 'static,
) -> crate::Result<()> {
    let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
        if let Some(args) = args {
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            // WebView2 supplies these COM arguments on the controller thread.
            unsafe { args.ProcessFailedKind(&mut kind) }?;
            if matches!(
                kind,
                COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
                    | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
            ) {
                on_problem("The video player stopped. Use Reload Player or Open in browser.");
            }
        }
        Ok(())
    }));
    // Closing the Wry controller releases its event handlers.
    let mut token = 0;
    unsafe { view.webview().add_ProcessFailed(&handler, &mut token) }?;
    Ok(())
}

impl Layout {
    pub(in crate::player) fn new(_window: &Window, data_dir: &Path) -> crate::Result<Self> {
        Ok(Self {
            webview_data_dir: data_dir.join("WebView2"),
        })
    }

    pub(in crate::player) fn build(
        &self,
        window: &Window,
        configure: impl for<'a> FnOnce(WebViewBuilder<'a>) -> WebViewBuilder<'a>,
        pane: Pane,
        queue_visible: bool,
    ) -> crate::Result<WebView> {
        let (video_bounds, controls_bounds) = child_bounds(window, queue_visible);
        let mut context = WebContext::new(Some(self.webview_data_dir.clone()));
        let builder = configure(WebViewBuilder::new_with_web_context(&mut context));
        let builder = match pane {
            Pane::Video => builder
                .with_profile_name("PearPreviewVideo")
                .with_bounds(video_bounds),
            Pane::Controls => builder
                .with_profile_name("PearPreviewControls")
                .with_https_scheme(true)
                .with_bounds(controls_bounds)
                .with_visible(queue_visible),
        };
        let view = builder.build_as_child(window)?;
        crate::verify_private_session(&view)?;
        Ok(view)
    }

    pub(in crate::player) fn arrange(
        &self,
        window: &Window,
        player: Option<&WebView>,
        controls: &WebView,
        queue_visible: bool,
    ) -> crate::Result<()> {
        let (video_bounds, controls_bounds) = child_bounds(window, queue_visible);
        if !queue_visible {
            controls.set_visible(false)?;
        }
        if let Some(player) = player {
            player.set_bounds(video_bounds)?;
        }
        if queue_visible {
            controls.set_bounds(controls_bounds)?;
            controls.set_visible(true)?;
        }
        Ok(())
    }
}
