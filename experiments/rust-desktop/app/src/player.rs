//! The bundled macOS player separates its local controls from the remote video.
use std::{
    borrow::Cow,
    fs::{self, File, OpenOptions},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use muda::{
    Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
    accelerator::{Accelerator, CMD_OR_CTRL, Code},
};
use objc2_foundation::NSBundle;
use serde::Deserialize;
use tao::{
    dpi::{LogicalPosition, LogicalSize},
    event::{Event, StartCause, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::{Window, WindowBuilder},
};
use wry::{
    NewWindowResponse, PageLoadEvent, PermissionResponse, Rect, WebView, WebViewBuilder,
    http::{HeaderMap, HeaderValue, Request, Response, header},
};

use crate::{
    Result, TITLE, attach_menu,
    library::{Command, Library},
};

const BUNDLE_ID: &str = "com.pear-desktop.rust-preview";
const CONTROLS_URL: &str = "pear-queue://app.local/";
const CONTROLS_CSP: &str = "default-src 'none'; script-src pear-queue:; style-src pear-queue:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PANEL_WIDTH: f64 = 360.0;
const MAX_IPC_BYTES: usize = 4096;
const LOAD_TIMEOUT: Duration = Duration::from_secs(15);

const EMPTY_PLAYER: &str = r#"<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>Player</title><style>
:root{color-scheme:dark;background:#121714;color:#e5ebe0;font:17px system-ui}
body{min-height:100vh;display:grid;place-content:center;text-align:center;margin:0}
h1{font-size:34px;letter-spacing:-.04em;margin:0 0 8px}p{color:#aebcaf;margin:0}
</style><main><h1>Ready when you are</h1><p>Add a video to start listening.</p></main></html>"#;

enum PlayerEvent {
    Menu(MenuEvent),
    Command(ControlMessage),
    Loaded(u64),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlMessage {
    sequence: std::num::NonZeroU32,
    command: Command,
}

pub fn is_bundle_launch() -> bool {
    std::env::args_os().len() == 1
        && NSBundle::mainBundle()
            .bundleIdentifier()
            .is_some_and(|id| id.to_string() == BUNDLE_ID)
}

fn queue_path_and_lock() -> Result<(PathBuf, File)> {
    let data_dir = PathBuf::from(std::env::var_os("HOME").ok_or("Home directory is unavailable")?)
        .join("Library/Application Support")
        .join(BUNDLE_ID);
    fs::create_dir_all(&data_dir)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(data_dir.join("queue.lock"))?;
    lock.try_lock().map_err(|error| {
        format!("Could not lock the player queue. Close the other preview if it is open: {error}")
    })?;
    Ok((data_dir.join("queue.json"), lock))
}

fn controls_response(request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let asset: Option<(&str, &[u8])> = if request.method() == "GET" {
        match request.uri().to_string().as_str() {
            CONTROLS_URL => Some((
                "text/html; charset=utf-8",
                include_bytes!("../ui/index.html"),
            )),
            "pear-queue://app.local/style.css" => {
                Some(("text/css; charset=utf-8", include_bytes!("../ui/style.css")))
            }
            "pear-queue://app.local/controls.js" => Some((
                "text/javascript; charset=utf-8",
                include_bytes!("../ui/controls.js"),
            )),
            _ => None,
        }
    } else {
        None
    };

    let Some((content_type, body)) = asset else {
        return Response::builder()
            .status(404)
            .body(Cow::Borrowed(&[][..]))
            .expect("fixed error response");
    };
    Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_SECURITY_POLICY, CONTROLS_CSP)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(Cow::Borrowed(body))
        .expect("fixed controls response")
}

fn controls_command(request: &Request<String>) -> Option<ControlMessage> {
    if request.uri() != CONTROLS_URL || request.body().len() > MAX_IPC_BYTES {
        return None;
    }
    serde_json::from_str(request.body()).ok()
}

fn pane_bounds(window: &Window) -> (Rect, Rect) {
    let size = window.inner_size().to_logical::<f64>(window.scale_factor());
    let player_width = (size.width - PANEL_WIDTH).max(0.0);
    let player = Rect {
        position: LogicalPosition::new(0.0, 0.0).into(),
        size: LogicalSize::new(player_width, size.height).into(),
    };
    let controls = Rect {
        position: LogicalPosition::new(player_width, 0.0).into(),
        size: LogicalSize::new(size.width - player_width, size.height).into(),
    };
    (player, controls)
}

fn isolated_builder(bounds: Rect) -> WebViewBuilder<'static> {
    WebViewBuilder::new()
        .with_bounds(bounds)
        .with_incognito(true)
        .with_autoplay(false)
        .with_devtools(false)
        .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
        .with_download_started_handler(|_, _| false)
        .with_permission_handler(|_| PermissionResponse::Deny)
}

fn embed_url(id: &str) -> String {
    format!("https://www.youtube.com/embed/{id}")
}

fn show_video(
    window: &Window,
    id: Option<&str>,
    loaded: impl Fn() + 'static,
) -> wry::Result<WebView> {
    let builder = isolated_builder(pane_bounds(window).0);
    let Some(id) = id else {
        return builder
            .with_html(EMPTY_PLAYER)
            .with_navigation_handler(|url| url == "about:blank")
            .build_as_child(window);
    };

    let url = embed_url(id);
    let permitted_url = url.clone();
    let ready_url = url.clone();
    let mut headers = HeaderMap::new();
    headers.insert(
        header::REFERER,
        HeaderValue::from_static("https://com.pear-desktop.rust-preview"),
    );
    builder
        .with_navigation_handler(move |candidate| candidate == permitted_url)
        .with_on_page_load_handler(move |event, candidate| {
            if matches!(event, PageLoadEvent::Finished) && candidate == ready_url {
                loaded();
            }
        })
        .with_url_and_headers(url, headers)
        .build_as_child(window)
}

fn render(
    controls: &WebView,
    library: &Library,
    error: Option<&str>,
    notice: Option<&str>,
    acknowledged_sequence: Option<std::num::NonZeroU32>,
) -> Result<()> {
    // JSON encodes every argument as data. This script only runs in the local view.
    let state = serde_json::to_string(library.state())?;
    let error = serde_json::to_string(&error)?;
    let notice = serde_json::to_string(&notice)?;
    let ack = serde_json::to_string(&acknowledged_sequence)?;
    controls.evaluate_script(&format!(
        "window.renderPearState({state},{error},{notice},{ack});"
    ))?;
    Ok(())
}

pub fn run() -> Result<()> {
    let (queue_path, queue_lock) = queue_path_and_lock()?;
    let mut library = Library::load(queue_path)?;
    let event_loop = EventLoopBuilder::<PlayerEvent>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title(TITLE)
        .with_inner_size(LogicalSize::new(1180, 700))
        .with_min_inner_size(LogicalSize::new(850, 520))
        .build(&event_loop)?;

    let quit = MenuItem::new(
        "Quit Pear Desktop Rust Preview",
        true,
        Some(Accelerator::new(CMD_OR_CTRL, Code::KeyQ)),
    );
    let reload = MenuItem::new(
        "Reload Player",
        true,
        Some(Accelerator::new(CMD_OR_CTRL, Code::KeyR)),
    );
    let app_menu = Submenu::with_items(
        "Pear Desktop",
        true,
        &[&reload, &PredefinedMenuItem::separator(), &quit],
    )?;
    let edit_menu = Submenu::with_items(
        "Edit",
        true,
        &[
            &PredefinedMenuItem::cut(None),
            &PredefinedMenuItem::copy(None),
            &PredefinedMenuItem::paste(None),
            &PredefinedMenuItem::select_all(None),
        ],
    )?;
    let menu = Menu::with_items(&[&app_menu, &edit_menu])?;
    attach_menu(&window, &menu)?;
    let menu_proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(Arc::new(move |event| {
        let _ = menu_proxy.send_event(PlayerEvent::Menu(event));
    })));

    let controls_proxy = event_loop.create_proxy();
    let controls = isolated_builder(pane_bounds(&window).1)
        .with_custom_protocol("pear-queue".into(), |_, request| controls_response(request))
        .with_navigation_handler(|url| url == CONTROLS_URL)
        .with_ipc_handler(move |request| {
            if let Some(command) = controls_command(&request) {
                let _ = controls_proxy.send_event(PlayerEvent::Command(command));
            }
        })
        .with_url(CONTROLS_URL)
        .build_as_child(&window)?;

    let loader = event_loop.create_proxy();
    let load = move |window: &Window, library: &Library, generation| {
        let loader = loader.clone();
        show_video(window, library.state().current.as_deref(), move || {
            let _ = loader.send_event(PlayerEvent::Loaded(generation));
        })
    };
    let mut generation = 0;
    let (mut current_player, mut player_error) = match load(&window, &library, generation) {
        Ok(video) => (Some(video), None),
        Err(error) => (None, Some(format!("Could not open the player: {error}"))),
    };
    let mut load_deadline = (current_player.is_some() && library.state().current.is_some())
        .then(|| Instant::now() + LOAD_TIMEOUT);
    let mut loading_slow = false;
    let mut loaded_generation = None;
    let mut controls_ready = false;

    event_loop.run(move |event, _, flow| {
        let _keep_alive = (&menu, &queue_lock);
        *flow = load_deadline.map_or(ControlFlow::Wait, ControlFlow::WaitUntil);
        let mut reload_player = false;
        let mut error = None;
        let mut acknowledged_sequence = None;

        match event {
            Event::WindowEvent {
                window_id, event, ..
            } if window_id == window.id() => {
                match event {
                    WindowEvent::CloseRequested => *flow = ControlFlow::Exit,
                    WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                        let (video_bounds, control_bounds) = pane_bounds(&window);
                        let video_result = current_player
                            .as_ref()
                            .map_or(Ok(()), |player| player.set_bounds(video_bounds));
                        let controls_result = controls.set_bounds(control_bounds);
                        if let Err(error) = video_result.and(controls_result) {
                            eprintln!("Could not resize the player: {error}");
                        }
                    }
                    _ => {}
                }
                return;
            }
            Event::UserEvent(PlayerEvent::Menu(event)) if event.id == *quit.id() => {
                *flow = ControlFlow::Exit;
                return;
            }
            Event::UserEvent(PlayerEvent::Menu(event)) if event.id == *reload.id() => {
                reload_player = true;
            }
            Event::UserEvent(PlayerEvent::Loaded(id)) if id == generation => {
                loaded_generation = Some(id);
                load_deadline = None;
                loading_slow = false;
            }
            Event::NewEvents(StartCause::ResumeTimeReached { .. })
                if load_deadline.is_some_and(|deadline| Instant::now() >= deadline) =>
            {
                load_deadline = None;
                loading_slow = true;
            }
            Event::UserEvent(PlayerEvent::Command(message)) => {
                acknowledged_sequence = Some(message.sequence);
                match message.command {
                    Command::Ready {} => controls_ready = true,
                    Command::OpenBrowser {} => {
                        if let Some(id) = &library.state().current
                            && let Err(reason) =
                                open::that_detached(format!("https://www.youtube.com/watch?v={id}"))
                        {
                            error = Some(format!("Could not open the browser: {reason}"));
                        }
                    }
                    command => match library.apply(command) {
                        Ok(changed) => reload_player = changed,
                        Err(reason) => error = Some(reason.to_string()),
                    },
                }
            }
            _ => return,
        }

        if reload_player {
            generation += 1;
            load_deadline = None;
            loading_slow = false;
            // Remove the old WebView before creating the next one so its audio stops
            // even if the new WebView fails to initialize.
            drop(current_player.take());
            match load(&window, &library, generation) {
                Ok(video) => {
                    current_player = Some(video);
                    player_error = None;
                    if library.state().current.is_some() {
                        load_deadline = Some(Instant::now() + LOAD_TIMEOUT);
                    }
                }
                Err(reason) => player_error = Some(format!("Could not open the player: {reason}")),
            }
        }

        *flow = load_deadline.map_or(ControlFlow::Wait, ControlFlow::WaitUntil);
        if controls_ready {
            let error = error.as_deref().or(player_error.as_deref());
            let notice = if library.state().current.is_none() || error.is_some() {
                None
            } else if loaded_generation == Some(generation) {
                Some("Use the video player’s Play button when you’re ready.")
            } else if loading_slow {
                Some("This video is taking longer to open. Use Reload Player or Open in browser.")
            } else {
                Some("Opening the YouTube player…")
            };
            if let Err(error) = render(&controls, &library, error, notice, acknowledged_sequence) {
                eprintln!("Could not update the queue controls: {error}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_bounded_commands_from_the_local_controls_document() {
        let command = |origin, body| Request::builder().uri(origin).body(body).unwrap();
        let payload = r#"{"sequence":1,"command":{"type":"ready"}}"#.to_owned();
        assert!(matches!(
            controls_command(&command(CONTROLS_URL, payload.clone())),
            Some(ControlMessage {
                command: Command::Ready {},
                ..
            })
        ));
        let unknown_field = r#"{"sequence":1,"command":{"type":"next","id":"stale"}}"#;
        assert!(controls_command(&command(CONTROLS_URL, unknown_field.into())).is_none());
        for rejected in [
            "https://www.youtube.com/embed/M7lc1UVf-VE",
            "pear-queue://app.local/controls.js",
            "pear-queue://app.local/?other",
            "pear-queue://other.local/",
        ] {
            assert!(controls_command(&command(rejected, payload.clone())).is_none());
        }
        assert!(controls_command(&command(CONTROLS_URL, " ".repeat(MAX_IPC_BYTES + 1))).is_none());
    }

    #[test]
    fn controls_protocol_serves_only_the_packaged_assets() {
        let request = |uri, method| {
            Request::builder()
                .uri(uri)
                .method(method)
                .body(vec![])
                .unwrap()
        };
        let response = controls_response(request(CONTROLS_URL, "GET"));
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()[header::CONTENT_SECURITY_POLICY],
            CONTROLS_CSP
        );
        assert_eq!(
            controls_response(request(CONTROLS_URL, "POST")).status(),
            404
        );
        assert_eq!(
            controls_response(request("pear-queue://app.local/other.html", "GET")).status(),
            404
        );
    }
}
