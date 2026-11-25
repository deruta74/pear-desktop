#[cfg(target_os = "macos")]
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
#[cfg(target_os = "macos")]
use wry::{
    NewWindowResponse, PermissionResponse, WebViewBuilder,
    http::{HeaderMap, HeaderValue, header::REFERER},
};

const VIDEO_URL: &str = "https://www.youtube.com/embed/M7lc1UVf-VE";

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("The official embed probe for {VIDEO_URL} is available on macOS.");
    std::process::exit(1);
}

#[cfg(target_os = "macos")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bundle_id = objc2_foundation::NSBundle::mainBundle()
        .bundleIdentifier()
        .ok_or("Run the probe from the .app created by tools/bundle-macos.sh")?;
    if bundle_id.to_string() != "com.pear-desktop.rust-preview.embed-probe" {
        return Err("The probe must use its original app bundle identifier".into());
    }

    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Pear Official Embed Probe")
        .with_inner_size(LogicalSize::new(1000, 630))
        .build(&event_loop)?;
    // The documented WKWebView identity is the app bundle ID as an HTTPS Referer.
    let mut headers = HeaderMap::new();
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://com.pear-desktop.rust-preview.embed-probe"),
    );
    let webview = WebViewBuilder::new()
        .with_incognito(true)
        .with_autoplay(false)
        .with_devtools(false)
        .with_permission_handler(|_| PermissionResponse::Deny)
        .with_download_started_handler(|_, _| false)
        .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
        .with_navigation_handler(|url| url == VIDEO_URL)
        .with_url_and_headers(VIDEO_URL, headers)
        .build(&window)?;
    event_loop.run(move |event, _, control_flow| {
        let _keep_alive = (&window, &webview);
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            *control_flow = ControlFlow::Exit;
        }
    });
}
