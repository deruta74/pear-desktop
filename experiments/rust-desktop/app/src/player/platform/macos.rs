use std::path::Path;

use tao::window::Window;
use wry::{WebView, WebViewBuilder};

use super::{Pane, child_bounds};

pub(in crate::player) struct Layout;

impl Layout {
    pub(in crate::player) fn new(_: &Window, _: &Path) -> crate::Result<Self> {
        Ok(Self)
    }

    pub(in crate::player) fn build(
        &self,
        window: &Window,
        configure: impl for<'a> FnOnce(WebViewBuilder<'a>) -> WebViewBuilder<'a>,
        pane: Pane,
        queue_visible: bool,
    ) -> crate::Result<WebView> {
        let (video_bounds, controls_bounds) = child_bounds(window, queue_visible);
        let bounds = match pane {
            Pane::Video => video_bounds,
            Pane::Controls => controls_bounds,
        };
        Ok(configure(WebViewBuilder::new())
            .with_bounds(bounds)
            .build_as_child(window)?)
    }

    pub(in crate::player) fn arrange(
        &self,
        window: &Window,
        player: Option<&WebView>,
        controls: &WebView,
        queue_visible: bool,
    ) -> crate::Result<()> {
        let (player_bounds, controls_bounds) = child_bounds(window, queue_visible);
        if !queue_visible {
            controls.set_visible(false)?;
        }
        if let Some(player) = player {
            player.set_bounds(player_bounds)?;
        }
        if queue_visible {
            controls.set_bounds(controls_bounds)?;
            controls.set_visible(true)?;
        }
        Ok(())
    }
}
