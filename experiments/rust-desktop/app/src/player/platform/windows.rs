use std::{
    cell::{Cell, RefCell},
    path::{Path, PathBuf},
    rc::Rc,
};

use serde::Deserialize;
use tao::window::Window;
use webview2_com::{
    ExecuteScriptCompletedHandler,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED, COREWEBVIEW2_WEB_ERROR_STATUS,
        ICoreWebView2_2, ICoreWebView2Environment2, ICoreWebView2NavigationCompletedEventArgs2,
    },
    NavigationCompletedEventHandler, NavigationStartingEventHandler, ProcessFailedEventHandler,
    take_pwstr,
};
use windows_core::{BOOL, HSTRING, Interface, PWSTR, w};
use wry::{WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

use super::{Pane, child_bounds};

pub(in crate::player) struct Layout {
    webview_data_dir: PathBuf,
}

#[derive(Default)]
enum VideoNavigation {
    #[default]
    AwaitingStart,
    Started(u64),
    Completed,
}

impl VideoNavigation {
    fn start(&mut self, id: u64, expected_url: bool) -> bool {
        match *self {
            Self::AwaitingStart if expected_url => {
                *self = Self::Started(id);
                true
            }
            Self::Started(active) => active == id,
            _ => false,
        }
    }

    fn complete(&mut self, id: u64) -> bool {
        if !matches!(*self, Self::Started(active) if active == id) {
            return false;
        }
        *self = Self::Completed;
        true
    }
}

fn webview_error(action: &str, error: windows_core::Error) -> String {
    format!(
        "Could not {action} (WebView2 0x{:08x}).",
        error.code().0 as u32
    )
}

pub(in crate::player) fn load_video_with_referer(
    view: &WebView,
    url: &str,
    referer: &str,
) -> crate::Result<()> {
    let environment = view
        .environment()
        .cast::<ICoreWebView2Environment2>()
        .map_err(|error| webview_error("access the video request environment", error))?;
    let webview = view
        .webview()
        .cast::<ICoreWebView2_2>()
        .map_err(|error| webview_error("access the video navigation interface", error))?;
    // Use the controller thread's WebView2 interfaces and retain each native error.
    unsafe {
        let request = environment
            .CreateWebResourceRequest(&HSTRING::from(url), w!("GET"), None, w!(""))
            .map_err(|error| webview_error("create the video request", error))?;
        request
            .Headers()
            .and_then(|headers| headers.SetHeader(w!("Referer"), &HSTRING::from(referer)))
            .map_err(|error| webview_error("set the video request Referer", error))?;
        webview
            .NavigateWithWebResourceRequest(&request)
            .map_err(|error| webview_error("navigate to the video", error))?;
    }
    Ok(())
}

pub(in crate::player) fn restrict_video_frames(
    view: &WebView,
    permits: impl Fn(&str) -> bool + 'static,
) -> crate::Result<()> {
    let handler = NavigationStartingEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut uri = PWSTR::null();
        // WebView2 supplies these arguments on the controller thread.
        unsafe {
            args.Uri(&mut uri)?;
            args.SetCancel(!permits(&take_pwstr(uri)))?;
        }
        Ok(())
    }));
    // Wry's Windows navigation handler covers only the top-level document.
    // WebView2 releases this frame handler when the controller closes.
    let mut token = 0;
    unsafe {
        view.webview()
            .add_FrameNavigationStarting(&handler, &mut token)
    }
    .map_err(|error| webview_error("restrict video frame navigation", error))?;
    Ok(())
}

pub(in crate::player) fn observe_video(
    view: &WebView,
    url: &str,
    smoke: bool,
    on_problem: impl Fn(&'static str) + Clone + 'static,
) -> crate::Result<()> {
    if smoke {
        let mut version = PWSTR::null();
        // WebView2 allocates this string for the caller.
        let result = unsafe { view.environment().BrowserVersionString(&mut version) };
        let version = take_pwstr(version);
        let number = version.split_ascii_whitespace().next().filter(|value| {
            result.is_ok()
                && value.len() <= 32
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte == b'.')
        });
        println!(
            "PEAR_WINDOWS_VIDEO_RUNTIME {}",
            number.unwrap_or("unavailable")
        );
    }

    let expected_url = url.to_owned();
    let navigation = Rc::new(RefCell::new(VideoNavigation::default()));
    let started = navigation.clone();
    let start_logs = Cell::new(0);
    let unexpected_logged = Cell::new(false);
    let starting = NavigationStartingEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut uri = PWSTR::null();
        let mut id = 0;
        // WebView2 supplies these COM arguments on the controller thread.
        unsafe {
            args.NavigationId(&mut id)?;
            args.Uri(&mut uri)?;
        }
        let uri = take_pwstr(uri);
        let expected = uri == expected_url;
        if !started.borrow_mut().start(id, expected) {
            if smoke && uri != "about:blank" && !unexpected_logged.replace(true) {
                println!("PEAR_WINDOWS_VIDEO_NAV_OTHER id={id} expected_url={expected}");
            }
            return Ok(());
        }
        if smoke && start_logs.get() < 2 {
            start_logs.set(start_logs.get() + 1);
            let mut redirected = BOOL::default();
            let redirected = unsafe { args.IsRedirected(&mut redirected) }
                .ok()
                .map(|_| redirected.as_bool());
            let referer_present = unsafe {
                args.RequestHeaders().and_then(|headers| {
                    let mut present = BOOL::default();
                    headers.Contains(w!("Referer"), &mut present)?;
                    Ok(present.as_bool())
                })
            };
            println!(
                "PEAR_WINDOWS_VIDEO_NAV_START id={id} expected_url={expected} redirected={redirected:?} referer_present={:?}",
                referer_present.ok(),
            );
        }
        Ok(())
    }));

    let on_load_problem = on_problem.clone();
    let completed = NavigationCompletedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut id = 0;
        unsafe { args.NavigationId(&mut id) }?;
        if !navigation.borrow_mut().complete(id) {
            return Ok(());
        }
        let mut success = BOOL::default();
        unsafe { args.IsSuccess(&mut success) }?;
        let success = success.as_bool();
        let http_status = args
            .cast::<ICoreWebView2NavigationCompletedEventArgs2>()
            .and_then(|args| {
                let mut status = 0;
                unsafe { args.HttpStatusCode(&mut status) }?;
                Ok(status)
            })
            .ok()
            .filter(|status| *status != 0);
        if smoke {
            let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
            let web_error = unsafe { args.WebErrorStatus(&mut status) }
                .ok()
                .map(|_| status.0);
            println!(
                "PEAR_WINDOWS_VIDEO_NAV_COMPLETE id={id} success={success} web_error={web_error:?} http_status={http_status:?}",
            );
        }
        if !success || http_status.is_some_and(|status| (400..600).contains(&status)) {
            on_load_problem(
                "Could not load the video player. Use Reload Player or Open in browser.",
            );
        }
        Ok(())
    }));

    let process_logged = Cell::new(false);
    let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
        if let Some(args) = args {
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            unsafe { args.ProcessFailedKind(&mut kind) }?;
            if smoke && !process_logged.replace(true) {
                println!("PEAR_WINDOWS_VIDEO_PROCESS_FAILED kind={}", kind.0);
            }
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
    let webview = view.webview();
    let mut token = 0;
    unsafe {
        webview.add_NavigationStarting(&starting, &mut token)?;
        webview.add_NavigationCompleted(&completed, &mut token)?;
        webview.add_ProcessFailed(&handler, &mut token)?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VideoDiagnostic {
    youtube_title_suffix: bool,
    player_error_visible: bool,
    video_present: bool,
    ready_state: Option<u8>,
    paused: Option<bool>,
}

pub(in crate::player) fn diagnose_video(view: &WebView) {
    const SCRIPT: &str = r#"(() => {
        const video = document.querySelector('video');
        const playerErrorVisible = Array.from(document.querySelectorAll(
            '#error-screen, .ytp-error-content-wrap, .ytp-error-content'
        )).some((element) => {
            const bounds = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return bounds.width > 0 && bounds.height > 0 &&
                style.visibility === 'visible' && style.opacity !== '0';
        });
        return {
            youtube_title_suffix: document.title.trim().endsWith(' - YouTube'),
            player_error_visible: playerErrorVisible,
            video_present: video !== null,
            ready_state: video?.readyState ?? null,
            paused: video?.paused ?? null
        };
    })()"#;

    let handler = ExecuteScriptCompletedHandler::create(Box::new(|result, json| {
        if result.is_err() {
            println!("PEAR_WINDOWS_VIDEO_DOM unavailable=completion");
            return Ok(());
        }
        let diagnostic = (json.len() <= 256)
            .then(|| serde_json::from_str::<VideoDiagnostic>(&json).ok())
            .flatten()
            .filter(|data| {
                data.ready_state.is_some() == data.video_present
                    && data.paused.is_some() == data.video_present
                    && data.ready_state.is_none_or(|state| state <= 4)
            });
        let Some(data) = diagnostic else {
            println!("PEAR_WINDOWS_VIDEO_DOM unavailable=result");
            return Ok(());
        };
        println!(
            "PEAR_WINDOWS_VIDEO_DOM youtube_title_suffix={} player_error_visible={} video_present={} ready_state={:?} paused={:?}",
            data.youtube_title_suffix,
            data.player_error_visible,
            data.video_present,
            data.ready_state,
            data.paused,
        );
        Ok(())
    }));
    // Use the native callback to observe asynchronous execution failures.
    let result = unsafe {
        view.webview()
            .ExecuteScript(&HSTRING::from(SCRIPT), &handler)
    };
    if result.is_err() {
        println!("PEAR_WINDOWS_VIDEO_DOM unavailable=evaluate");
    }
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
        let (video_bounds, controls_bounds) = child_bounds(window, queue_visible, true);
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
        let (video_bounds, controls_bounds) = child_bounds(window, queue_visible, player.is_some());
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

#[cfg(test)]
mod tests {
    use super::VideoNavigation;

    #[test]
    fn completes_only_the_first_expected_navigation() {
        let mut navigation = VideoNavigation::default();
        assert!(!navigation.start(10, false));
        assert!(!navigation.complete(10));

        assert!(navigation.start(11, true));
        assert!(navigation.start(11, false)); // A redirect keeps the original ID.
        assert!(!navigation.start(12, true));
        assert!(!navigation.complete(12));
        assert!(navigation.complete(11));

        assert!(!navigation.complete(11));
        assert!(!navigation.start(13, true));
    }
}
