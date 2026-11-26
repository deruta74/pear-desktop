#![cfg_attr(
    all(target_os = "windows", not(feature = "benchmark")),
    windows_subsystem = "windows"
)]

mod page;

mod library;
mod local_audio;
mod media;
mod player;

use std::{error::Error, ffi::OsString, path::PathBuf, sync::Arc};

use muda::{
    Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
    accelerator::{Accelerator, CMD_OR_CTRL, Code},
};
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::{Window, WindowBuilder},
};
use wry::{NewWindowResponse, PageLoadEvent, PermissionResponse, WebView, WebViewBuilder};

use page::{PreviewPage, YOUTUBE_MUSIC};

const TITLE: &str = "Pear Desktop Rust Preview";
type Result<T> = std::result::Result<T, Box<dyn Error>>;

enum AppEvent {
    Menu(MenuEvent),
    Ready,
}

fn build_webview(window: &Window, builder: WebViewBuilder<'_>) -> wry::Result<WebView> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        builder.build(window)
    }
    #[cfg(target_os = "linux")]
    {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;

        builder.build_gtk(
            window
                .default_vbox()
                .expect("Tao creates a default GTK box"),
        )
    }
}

fn attach_menu(window: &Window, menu: &Menu) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let _ = window;
        menu.init_for_nsapp();
    }
    #[cfg(target_os = "windows")]
    {
        use tao::platform::windows::WindowExtWindows;

        // The Tao window owns this HWND for the lifetime of the attached menu.
        unsafe { menu.init_for_hwnd(window.hwnd()) }?;
    }
    #[cfg(target_os = "linux")]
    {
        use tao::platform::unix::WindowExtUnix;

        menu.init_for_gtk_window(window.gtk_window(), window.default_vbox())?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn verify_private_session(webview: &WebView) -> Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_13;
    use windows_core::{BOOL, Interface};
    use wry::WebViewExtWindows;

    let is_private = (|| -> windows_core::Result<bool> {
        let core = webview.webview().cast::<ICoreWebView2_13>()?;
        // Both COM interfaces belong to the already initialized UI-thread WebView.
        let profile = unsafe { core.Profile() }?;
        let mut enabled = BOOL::default();
        unsafe { profile.IsInPrivateModeEnabled(&mut enabled) }?;
        Ok(enabled.as_bool())
    })()
    .map_err(|error| format!("Could not confirm WebView2 InPrivate mode. Update the Evergreen WebView2 Runtime: {error}"))?;
    if !is_private {
        return Err(
            "WebView2 did not start in InPrivate mode. Update the Evergreen WebView2 Runtime."
                .into(),
        );
    }
    Ok(())
}

fn run() -> Result<()> {
    let page = PreviewPage::parse(std::env::args().skip(1))?;
    let event_loop = EventLoopBuilder::<AppEvent>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title(TITLE)
        .with_inner_size(LogicalSize::new(1200, 800))
        .with_min_inner_size(LogicalSize::new(420, 320))
        .build(&event_loop)?;

    let open_browser = MenuItem::new("Open YouTube Music in Browser", true, None);
    let shortcut = |key| (!cfg!(target_os = "windows")).then(|| Accelerator::new(CMD_OR_CTRL, key));
    let reload = MenuItem::new("Reload", true, shortcut(Code::KeyR));
    let quit = MenuItem::new("Quit Pear Desktop Rust Preview", true, shortcut(Code::KeyQ));
    let menu = Menu::with_items(&[&Submenu::with_items(
        "Pear Desktop",
        true,
        &[
            &open_browser,
            &reload,
            &PredefinedMenuItem::separator(),
            &quit,
        ],
    )?])?;
    attach_menu(&window, &menu)?;

    let menu_proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(Arc::new(move |event| {
        let _ = menu_proxy.send_event(AppEvent::Menu(event));
    })));

    let navigation_page = page.clone();
    let loaded_page = page.clone();
    let load_proxy = event_loop.create_proxy();
    let webview = build_webview(
        &window,
        WebViewBuilder::new()
            .with_incognito(true)
            .with_autoplay(false)
            .with_devtools(false)
            .with_navigation_handler(move |url| navigation_page.permits(&url))
            .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
            .with_download_started_handler(|_, _| false)
            .with_permission_handler(|_| PermissionResponse::Deny)
            .with_on_page_load_handler(move |event, url| {
                if matches!(event, PageLoadEvent::Finished) && loaded_page.permits(&url) {
                    let _ = load_proxy.send_event(AppEvent::Ready);
                }
            }),
    )?;

    #[cfg(target_os = "windows")]
    verify_private_session(&webview)?;
    webview.load_url(page.start_url())?;

    let mut ready = false;
    event_loop.run(move |event, _, control_flow| {
        let _keep_menu_alive = &menu;
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent {
                window_id,
                event: WindowEvent::CloseRequested,
                ..
            } if window_id == window.id() => *control_flow = ControlFlow::Exit,
            Event::UserEvent(AppEvent::Menu(event)) if event.id == *quit.id() => {
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(AppEvent::Menu(event)) if event.id == *reload.id() => {
                let result = match webview.url() {
                    Ok(url) if page.permits(&url) => webview.reload(),
                    _ => webview.load_url(page.start_url()),
                };
                if let Err(error) = result {
                    eprintln!("Could not reload the preview: {error}");
                }
            }
            Event::UserEvent(AppEvent::Menu(event)) if event.id == *open_browser.id() => {
                if let Err(error) = open::that_detached(YOUTUBE_MUSIC) {
                    eprintln!("Could not open YouTube Music in the default browser: {error}");
                }
            }
            Event::UserEvent(AppEvent::Ready) if !ready => {
                ready = true;
                #[cfg(feature = "benchmark")]
                if matches!(page, PreviewPage::Fixture(_)) {
                    println!("PEAR_READY");
                }
            }
            _ => {}
        }
    });
}

fn startup_failed(error: impl std::fmt::Display, guidance: &'static str) -> ! {
    #[cfg(all(target_os = "windows", not(feature = "benchmark")))]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};

        // Only these fixed strings reach the native dialog. Startup errors may contain
        // local paths or dependency messages that are unsuitable for display here.
        let _ = error;
        let title: Vec<u16> = TITLE.encode_utf16().chain([0]).collect();
        let message: Vec<u16> = guidance.encode_utf16().chain([0]).collect();
        // Both strings are NUL-terminated and live until the unowned dialog closes.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                message.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
    #[cfg(not(all(target_os = "windows", not(feature = "benchmark"))))]
    {
        let _ = guidance;
        eprintln!("{TITLE}: {error}");
    }
    std::process::exit(1)
}

fn local_audio_files(mut arguments: impl Iterator<Item = OsString>) -> Option<Vec<PathBuf>> {
    (arguments.next()? == "--local-audio").then(|| arguments.map(PathBuf::from).collect())
}

fn main() {
    let result = if let Some(files) = local_audio_files(std::env::args_os().skip(1)) {
        local_audio::run(files)
    } else {
        match player::launch_mode() {
            Ok(Some(mode)) => player::run(mode),
            Ok(None) if cfg!(feature = "benchmark") => run(),
            Ok(None) => startup_failed(
                "Unexpected argument",
                "Unexpected argument. Launch Pear Desktop Rust Preview without arguments, or use --queue, --iframe-player, or --local-audio.",
            ),
            Err(error) => Err(error),
        }
    };

    if let Err(error) = result {
        startup_failed(
            error,
            "Pear Desktop Rust Preview could not start. Close any other preview window and try again. If the problem continues, make sure Microsoft Edge WebView2 Runtime is installed and up to date.",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::PreviewPage;
    use std::{ffi::OsString, path::PathBuf};

    #[test]
    fn local_audio_launch_keeps_file_order_and_does_not_claim_other_modes() {
        let parse = |args: &[&str]| super::local_audio_files(args.iter().map(OsString::from));
        assert_eq!(parse(&[]), None);
        assert_eq!(parse(&["--queue"]), None);
        assert_eq!(parse(&["--local-audio"]), Some(Vec::new()));
        assert_eq!(
            parse(&["--local-audio", "Folder/first track.flac", "second.opus"]),
            Some(vec![
                PathBuf::from("Folder/first track.flac"),
                PathBuf::from("second.opus"),
            ])
        );
    }

    #[cfg(unix)]
    #[test]
    fn local_audio_launch_preserves_non_utf8_file_paths() {
        use std::os::unix::ffi::OsStringExt;

        let name = OsString::from_vec(b"track-\xff.wav".to_vec());
        assert_eq!(
            super::local_audio_files([OsString::from("--local-audio"), name.clone()].into_iter()),
            Some(vec![PathBuf::from(name)])
        );
    }

    #[test]
    fn permits_only_the_exact_youtube_music_origin() {
        let page = PreviewPage::parse(std::iter::empty()).unwrap();
        for url in [
            "https://music.youtube.com/",
            "https://music.youtube.com:443/watch?v=example",
        ] {
            assert!(page.permits(url), "{url}");
        }
        for url in [
            "http://music.youtube.com/",
            "https://music.youtube.com:8443/",
            "https://music.youtube.com.example.org/",
            "https://music.youtube.com@example.org/",
            "https://user:password@music.youtube.com/",
            "https://accounts.google.com/",
            "file:///tmp/preview.html",
            "javascript:alert(1)",
            "https://www.youtube.com/",
            "https://music.youtube.com./",
        ] {
            assert!(!page.permits(url), "{url}");
        }
    }

    #[cfg(feature = "benchmark")]
    #[test]
    fn benchmark_page_stays_on_the_selected_loopback_port() {
        let page = PreviewPage::parse(
            ["--benchmark-url", "http://127.0.0.1:53142/"]
                .into_iter()
                .map(str::to_owned),
        )
        .unwrap();
        assert!(page.permits("http://127.0.0.1:53142/"));
        for url in [
            "http://127.0.0.1:53143/",
            "http://127.0.0.2:53142/",
            "http://127.0.0.1:53142/private",
            "http://127.0.0.1:53142/?query=extra",
            "http://127.0.0.1:53142/#fragment",
            "https://music.youtube.com/",
        ] {
            assert!(!page.permits(url), "{url}");
        }
    }

    #[cfg(feature = "benchmark")]
    #[test]
    fn benchmark_rejects_urls_outside_its_fixture() {
        for url in [
            "http://localhost:53142/",
            "http://127.1:53142/",
            "http://127.0.0.1/",
            "http://127.0.0.1:443/",
            "http://127.0.0.1:53142/extra",
            "http://127.0.0.1:53142/?extra",
            "http://127.0.0.1:53142/#extra",
            "http://guest@127.0.0.1:53142/",
            "https://128.0.0.1:53142/",
        ] {
            assert!(
                PreviewPage::parse(["--benchmark-url", url].into_iter().map(str::to_owned))
                    .is_err(),
                "{url}"
            );
        }
    }

    #[test]
    fn rejects_unexpected_arguments() {
        assert!(PreviewPage::parse(["https://example.org/".into()].into_iter()).is_err());
        assert!(PreviewPage::parse(["--site-probe".into(), "--queue".into()].into_iter()).is_err());
    }

    #[cfg(feature = "benchmark")]
    #[test]
    fn accepts_the_explicit_site_probe() {
        assert!(matches!(
            PreviewPage::parse(["--site-probe".into()].into_iter()),
            Ok(PreviewPage::Music)
        ));
    }

    #[cfg(not(feature = "benchmark"))]
    #[test]
    fn rejects_the_development_probe_in_a_normal_build() {
        assert!(PreviewPage::parse(["--site-probe".into()].into_iter()).is_err());
    }
}
