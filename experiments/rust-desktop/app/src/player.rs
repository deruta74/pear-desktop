//! The desktop queue separates its local controls from the remote video.
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod advance;
mod catalog;
mod consent;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod iframe;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod lyrics;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod lyrics_lookup;
mod metadata;
mod metadata_lookup;
mod platform;
mod playlists;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod preferences;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod transport;
use std::{
    borrow::Cow,
    fs::{self, File, OpenOptions},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use muda::CheckMenuItem;
use muda::{
    Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
    accelerator::{Accelerator, CMD_OR_CTRL, Code, Modifiers},
};
#[cfg(target_os = "macos")]
use objc2_foundation::NSBundle;
use serde::{Deserialize, Serialize};
use tao::{
    dpi::LogicalSize,
    event::{Event, StartCause, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    window::{Window, WindowBuilder},
};
use wry::{
    NewWindowResponse, PermissionResponse, WebView, WebViewBuilder,
    http::{Request, Response, header},
};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use wry::PageLoadEvent;
#[cfg(target_os = "macos")]
use wry::WebViewBuilderExtDarwin;
#[cfg(not(target_os = "windows"))]
use wry::http::{HeaderMap, HeaderValue};

use crate::{
    Result, TITLE, attach_menu,
    library::{Command, Library, QueueState},
};

use platform::{APP_ID, Layout, Pane};

const CONTROLS_ASSET_URL: &str = "pear-queue://app.local/";
#[cfg(not(target_os = "windows"))]
const CONTROLS_URL: &str = CONTROLS_ASSET_URL;
#[cfg(target_os = "windows")]
const CONTROLS_URL: &str = "https://pear-queue.app.local/";
#[cfg(not(target_os = "windows"))]
const CONTROLS_CSP: &str = "default-src 'none'; script-src pear-queue:; style-src pear-queue:; img-src https://i.ytimg.com/vi/; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
#[cfg(target_os = "windows")]
const CONTROLS_CSP: &str = "default-src 'none'; script-src https://pear-queue.app.local; style-src https://pear-queue.app.local; img-src https://i.ytimg.com/vi/; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MAX_IPC_BYTES: usize = 4096;
const LOAD_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(any(target_os = "macos", target_os = "linux"))]
const IFRAME_MENU_LABEL: &str = "Experimental Playback Controls";
#[cfg(any(target_os = "macos", target_os = "linux"))]
const AUTO_ADVANCE_LABEL: &str = "Play Next Automatically";

const EMPTY_PLAYER: &str = r#"<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>Player</title><style>
:root{color-scheme:dark;background:#121714;color:#e5ebe0;font:17px system-ui}
body{min-height:100vh;display:grid;place-content:center;text-align:center;margin:0}
h1{font-size:30px;letter-spacing:-.04em;margin:0}
</style><main><h1>Add a video to start listening</h1></main></html>"#;

enum PlayerEvent {
    Menu(MenuEvent),
    Command(ControlMessage),
    TitleChanged(u64, String),
    VideoProblem(u64, &'static str),
    Metadata(String, metadata_lookup::Response),
    SearchResults(u64, catalog::Response),
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    TransportCommitted(u64),
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    TransportSample(u64, u64, String),
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    LyricsResult(u64, lyrics_lookup::Response),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlMessage {
    sequence: std::num::NonZeroU32,
    command: Command,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueueView<'a> {
    #[serde(flatten)]
    queue: &'a QueueState,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<&'a metadata::Metadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata_problem: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    catalog: Option<&'a catalog::View>,
    saved_playlists: playlists::View<'a>,
    legal: LegalView<'a>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[serde(skip_serializing_if = "Option::is_none")]
    preferences_problem: Option<&'static str>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[serde(skip_serializing_if = "Option::is_none")]
    lyrics: Option<&'a lyrics_lookup::View>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    lyrics_switching: bool,
}

#[derive(Serialize)]
struct LegalView<'a> {
    accepted: bool,
    show: bool,
    revision: u32,
    problem: Option<&'a str>,
}

#[derive(Clone, Copy)]
pub struct LaunchMode {
    smoke: bool,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    iframe_player: bool,
}

pub fn launch_mode() -> Result<Option<LaunchMode>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let queue = (args.is_empty() && !cfg!(target_os = "macos"))
        || (args.len() == 1 && args[0] == "--queue");
    let iframe_smoke =
        cfg!(feature = "benchmark") && args.len() == 1 && args[0] == "--iframe-player-smoke";
    let smoke = iframe_smoke
        || (cfg!(feature = "benchmark") && args.len() == 1 && args[0] == "--queue-smoke");
    let iframe_player = iframe_smoke || (args.len() == 1 && args[0] == "--iframe-player");
    #[cfg(target_os = "windows")]
    if iframe_player {
        return Err("The IFrame API player preview currently requires macOS or Linux.".into());
    }
    #[cfg(target_os = "macos")]
    {
        let bundled = NSBundle::mainBundle()
            .bundleIdentifier()
            .is_some_and(|id| id.to_string() == APP_ID);
        if (args.is_empty() || queue || smoke || iframe_player) && !bundled {
            return Err("The native queue requires the Pear Desktop macOS app bundle.".into());
        }
        if bundled && args.is_empty() {
            return Ok(Some(LaunchMode {
                smoke: false,
                iframe_player: false,
            }));
        }
    }
    if smoke && std::env::var_os("PEAR_PREVIEW_QUEUE_DIR").is_none() {
        return Err(
            "Set PEAR_PREVIEW_QUEUE_DIR to a disposable directory for smoke testing.".into(),
        );
    }
    Ok((queue || smoke || iframe_player).then_some(LaunchMode {
        smoke,
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        iframe_player,
    }))
}

fn queue_path_and_lock() -> Result<(PathBuf, File)> {
    let data_dir = platform::queue_directory()?;
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
            CONTROLS_ASSET_URL => Some((
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

fn isolated_builder(builder: WebViewBuilder<'_>) -> WebViewBuilder<'_> {
    builder
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

fn video_title(document_title: &str) -> Option<&str> {
    let title = document_title.trim().strip_suffix(" - YouTube")?.trim();
    if title.is_empty()
        || ["YouTube", "YouTube Video Player", "Video unavailable"]
            .iter()
            .any(|placeholder| title.eq_ignore_ascii_case(placeholder))
    {
        return None;
    }
    Some(title)
}

fn show_video(
    layout: &Layout,
    window: &Window,
    queue_visible: bool,
    id: Option<&str>,
    generation: u64,
    events: tao::event_loop::EventLoopProxy<PlayerEvent>,
    mode: LaunchMode,
) -> Result<WebView> {
    let Some(id) = id else {
        let view = layout.build(
            window,
            |builder| isolated_builder(builder).with_navigation_handler(|url| url == "about:blank"),
            Pane::Video,
            queue_visible,
        )?;
        view.load_html(EMPTY_PLAYER)?;
        return Ok(view);
    };

    let problem_events = events.clone();
    let report_problem = move |message| {
        let _ = problem_events.send_event(PlayerEvent::VideoProblem(generation, message));
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if mode.iframe_player {
        let page = Arc::new(iframe::Page::new(id)?);
        let navigation = page.clone();
        let view = layout.build(
            window,
            move |builder| {
                let builder = isolated_builder(builder)
                    .with_navigation_handler(move |candidate| navigation.permits(&candidate))
                    .with_on_page_load_handler(move |event, url| {
                        if matches!(event, PageLoadEvent::Started)
                            && iframe::Page::is_wrapper_url(&url)
                        {
                            let _ = events.send_event(PlayerEvent::TransportCommitted(generation));
                        }
                    });
                #[cfg(target_os = "macos")]
                let builder = builder
                    .with_allow_link_preview(false)
                    .with_on_web_content_process_terminate_handler(move || {
                        report_problem(
                            "The video player stopped. Use Reload Player or Open in browser.",
                        );
                    });
                builder
            },
            Pane::Video,
            queue_visible,
        )?;
        #[cfg(target_os = "linux")]
        platform::observe_video(&view, &iframe::wrapper_url(), report_problem);
        page.load(&view)?;
        return Ok(view);
    }
    let url = embed_url(id);
    let permitted_url = url.clone();
    let title_events = events.clone();
    #[cfg(target_os = "macos")]
    let on_stopped = report_problem.clone();
    let view = layout.build(
        window,
        move |builder| {
            let builder = isolated_builder(builder)
                .with_navigation_handler(move |candidate| candidate == permitted_url)
                .with_document_title_changed_handler(move |title| {
                    if let Some(title) = video_title(&title) {
                        let _ = title_events
                            .send_event(PlayerEvent::TitleChanged(generation, title.into()));
                    }
                });
            #[cfg(target_os = "macos")]
            let builder = builder.with_on_web_content_process_terminate_handler(move || {
                on_stopped("The video player stopped. Use Reload Player or Open in browser.");
            });
            builder
        },
        Pane::Video,
        queue_visible,
    );
    #[cfg(target_os = "windows")]
    if mode.smoke && view.is_err() {
        println!("PEAR_WINDOWS_VIDEO_SETUP_ERROR stage=controller");
    }
    let view = view?;
    #[cfg(target_os = "linux")]
    platform::observe_video(&view, &url, report_problem);
    let referer = format!("https://{APP_ID}");
    #[cfg(target_os = "windows")]
    {
        let observer = platform::observe_video(&view, &url, mode.smoke, report_problem);
        if mode.smoke && observer.is_err() {
            println!("PEAR_WINDOWS_VIDEO_SETUP_ERROR stage=observer");
        }
        observer?;
        let navigation = platform::load_video_with_referer(&view, &url, &referer);
        if mode.smoke {
            match &navigation {
                Ok(()) => println!("PEAR_WINDOWS_VIDEO_REQUEST_SUBMITTED"),
                Err(reason) => println!("PEAR_WINDOWS_VIDEO_SETUP_ERROR stage=navigation {reason}"),
            }
        }
        navigation?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut headers = HeaderMap::new();
        headers.insert(header::REFERER, HeaderValue::from_str(&referer)?);
        view.load_url_with_headers(&url, headers)?;
    }
    Ok(view)
}

fn focus_add(controls: &WebView) -> wry::Result<()> {
    controls.focus()?;
    controls.evaluate_script("window.focusPearAdd?.();")
}

fn render(
    controls: &WebView,
    queue: QueueView<'_>,
    error: Option<&str>,
    notice: Option<&str>,
    acknowledged_sequence: Option<std::num::NonZeroU32>,
    player_problem: Option<&str>,
    verify_controls: bool,
) -> Result<()> {
    // JSON encodes every argument as data. This script only runs in the local view.
    let state = serde_json::to_string(&queue)?;
    let error = serde_json::to_string(&error)?;
    let notice = serde_json::to_string(&notice)?;
    let ack = serde_json::to_string(&acknowledged_sequence)?;
    let player_problem = serde_json::to_string(&player_problem)?;
    let mut script =
        format!("window.renderPearState({state},{error},{notice},{ack},{player_problem});");
    if verify_controls {
        script.push_str("document.getElementById('video-source').disabled === false;");
        controls.evaluate_script_with_callback(&script, |result| {
            if result == "true" {
                println!("PEAR_QUEUE_READY");
            } else {
                eprintln!("Queue smoke check failed: the link field is disabled.");
            }
        })?;
    } else {
        controls.evaluate_script(&script)?;
    }
    Ok(())
}

fn player_flow(
    load: Option<Instant>,
    metadata: Option<Instant>,
    catalog: Option<Instant>,
    #[cfg(any(target_os = "macos", target_os = "linux"))] transport: Option<&transport::Transport>,
    #[cfg(any(target_os = "macos", target_os = "linux"))] lyrics: Option<Instant>,
    #[cfg(any(target_os = "macos", target_os = "linux"))] advance: Option<Instant>,
    #[cfg(target_os = "linux")] timer: &mut platform::DeadlineTimer,
) -> ControlFlow {
    let deadlines = load.into_iter().chain(metadata).chain(catalog);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let deadlines = deadlines
        .chain(transport.and_then(transport::Transport::deadline))
        .chain(lyrics)
        .chain(advance);
    let deadline = deadlines.min();
    #[cfg(target_os = "linux")]
    let deadline = timer.schedule(deadline);
    deadline.map_or(ControlFlow::Wait, ControlFlow::WaitUntil)
}

fn start_youtube_clients(
    events: &EventLoopProxy<PlayerEvent>,
    current: Option<&str>,
) -> (Option<catalog::Catalog>, Option<metadata_lookup::Lookup>) {
    let keyed = metadata::Client::from_env();
    let catalog = keyed.as_ref().and_then(|client| {
        match catalog::Catalog::new(client.clone(), events.clone()) {
            Ok(catalog) => Some(catalog),
            Err(_) => {
                eprintln!("Could not start YouTube search.");
                None
            }
        }
    });
    let details = keyed.unwrap_or_else(metadata::Client::public_embed);
    let lookup = match metadata_lookup::Lookup::new(details, events.clone()) {
        Ok(mut lookup) => {
            lookup.select(current);
            Some(lookup)
        }
        Err(_) => {
            eprintln!("Could not start YouTube video details lookup.");
            None
        }
    };
    (catalog, lookup)
}

pub fn run(mode: LaunchMode) -> Result<()> {
    let (queue_path, queue_lock) = queue_path_and_lock()?;
    let data_dir = queue_path
        .parent()
        .ok_or("Queue directory is unavailable")?
        .to_owned();
    let mut consent = consent::Consent::load(data_dir.join("consent.json"));
    // Benchmark builds use a disposable profile and never record agreement.
    let mut approved = mode.smoke || consent.accepted();
    let mut show_legal = !approved;
    let mut legal_problem = None;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let mut mode = mode;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let mut preferences =
        (!mode.smoke).then(|| preferences::Preferences::load(data_dir.join("preferences.json")));
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let mut preferences_problem = preferences
        .as_ref()
        .and_then(preferences::Preferences::problem);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let mut automatic = preferences
        .as_ref()
        .is_some_and(preferences::Preferences::auto_advance);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let mut preferred_iframe = preferences
        .as_ref()
        .is_some_and(preferences::Preferences::iframe_player);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        mode.iframe_player |= preferred_iframe;
        if let Some(problem) = preferences_problem {
            eprintln!("{problem}");
        }
    }
    let mut library = Library::load(queue_path)?;
    let mut playlists = playlists::Panel::load(data_dir.join("playlists.json"));
    let mut event_loop_builder = EventLoopBuilder::<PlayerEvent>::with_user_event();
    platform::configure_event_loop(&mut event_loop_builder)?;
    let event_loop = event_loop_builder.build();
    let window = WindowBuilder::new()
        .with_title(TITLE)
        .with_inner_size(LogicalSize::new(1180, 700))
        .with_min_inner_size(LogicalSize::new(850, 520))
        .build(&event_loop)?;

    let accelerator =
        |mods, key| (!cfg!(target_os = "windows")).then(|| Accelerator::new(mods, key));
    let quit = MenuItem::new(
        "Quit Pear Desktop Rust Preview",
        true,
        accelerator(CMD_OR_CTRL, Code::KeyQ),
    );
    let reload = MenuItem::new(
        "Reload Player",
        approved,
        accelerator(CMD_OR_CTRL, Code::KeyR),
    );
    let toggle_queue = MenuItem::new(
        "Hide Queue",
        approved,
        accelerator(CMD_OR_CTRL | Modifiers::SHIFT, Code::KeyL),
    );
    let add_video = MenuItem::new("Add Video", approved, accelerator(CMD_OR_CTRL, Code::KeyL));
    let legal = MenuItem::new("Terms and Privacy", true, None);
    let app_menu = Submenu::with_items("Pear Desktop", true, &[&quit])?;
    let file_menu = Submenu::with_items("File", true, &[&add_video])?;
    let view_menu = Submenu::with_items("View", true, &[&toggle_queue, &reload])?;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let toggle_iframe = CheckMenuItem::new(
        IFRAME_MENU_LABEL,
        approved && preferences.is_some(),
        mode.iframe_player,
        None,
    );
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    view_menu.append(&toggle_iframe)?;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let toggle_advance = CheckMenuItem::new(
        AUTO_ADVANCE_LABEL,
        approved && preferences.is_some() && mode.iframe_player,
        automatic,
        None,
    );
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    view_menu.append(&toggle_advance)?;
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
    let help_menu = Submenu::with_items("Help", true, &[&legal])?;
    let menu = Menu::with_items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &help_menu])?;
    attach_menu(&window, &menu)?;
    let menu_proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(Arc::new(move |event| {
        let _ = menu_proxy.send_event(PlayerEvent::Menu(event));
    })));

    let layout = Layout::new(&window, &data_dir)?;
    let controls_proxy = event_loop.create_proxy();
    let controls = layout.build(
        &window,
        move |builder| {
            isolated_builder(builder)
                .with_custom_protocol("pear-queue".into(), |_, request| controls_response(request))
                .with_navigation_handler(|url| url == CONTROLS_URL)
                .with_ipc_handler(move |request| {
                    if let Some(command) = controls_command(&request) {
                        let _ = controls_proxy.send_event(PlayerEvent::Command(command));
                    }
                })
        },
        Pane::Controls,
        true,
    )?;
    controls.load_url(CONTROLS_URL)?;
    let loader = event_loop.create_proxy();
    let load = move |layout: &Layout,
                     window: &Window,
                     library: &Library,
                     generation,
                     queue_visible,
                     mode| {
        show_video(
            layout,
            window,
            queue_visible,
            library.state().current.as_deref(),
            generation,
            loader.clone(),
            mode,
        )
    };
    let mut queue_visible = true;
    let mut generation = 0;
    let (mut current_player, mut player_error) = if approved {
        match load(&layout, &window, &library, generation, queue_visible, mode) {
            Ok(video) => (Some(video), None),
            Err(error) => (None, Some(format!("Could not open the player: {error}"))),
        }
    } else {
        (None, None)
    };
    layout.arrange(&window, current_player.as_ref(), &controls, queue_visible)?;
    let mut load_deadline = (current_player.is_some() && library.state().current.is_some())
        .then(|| Instant::now() + LOAD_TIMEOUT);
    let mut loading_slow = false;
    let mut titled_generation = None;
    let mut controls_ready = false;
    let service_events = event_loop.create_proxy();
    let (mut catalog, mut lookup) = if approved && !mode.smoke {
        start_youtube_clients(&service_events, library.state().current.as_deref())
    } else {
        (None, None)
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let mut transport = mode.iframe_player.then(transport::Transport::default);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let mut auto_advance = advance::Advance::default();
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let lyrics_worker = {
        let events = event_loop.create_proxy();
        move || match lyrics_lookup::Lookup::new(events.clone()) {
            Ok(lyrics) => Some(lyrics),
            Err(_) => {
                eprintln!("Could not start LRCLIB lyrics lookup.");
                None
            }
        }
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let mut lyrics = if approved && mode.iframe_player && !mode.smoke {
        lyrics_worker()
    } else {
        None
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let results = event_loop.create_proxy();
    #[cfg(target_os = "linux")]
    let mut timer = platform::DeadlineTimer::default();

    event_loop.run(move |event, _, flow| {
        let _keep_alive = (&menu, &queue_lock);
        *flow = player_flow(
            load_deadline,
            lookup.as_ref().and_then(metadata_lookup::Lookup::deadline),
            catalog.as_ref().and_then(catalog::Catalog::deadline),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            transport.as_ref(),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            lyrics.as_ref().and_then(lyrics_lookup::Lookup::deadline),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            auto_advance.deadline(),
            #[cfg(target_os = "linux")]
            &mut timer,
        );
        let mut reload_player = false;
        let mut error = None;
        let mut acknowledged_sequence = None;
        let mut focus_add_field = false;
        let mut verify_controls = false;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let mut advance_resolution = None;
        let update_queue = match event {
            Event::WindowEvent {
                window_id, event, ..
            } if window_id == window.id() => {
                match event {
                    WindowEvent::CloseRequested => *flow = ControlFlow::Exit,
                    #[cfg(any(target_os = "macos", target_os = "linux"))]
                    WindowEvent::Focused(false) => auto_advance.disarm(),
                    WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                        if let Err(error) = layout.arrange(
                            &window,
                            current_player.as_ref(),
                            &controls,
                            queue_visible,
                        ) {
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
                if !approved {
                    return;
                }
                reload_player = true;
                true
            }
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Event::UserEvent(PlayerEvent::Menu(event))
                if event.id == *toggle_iframe.id() || event.id == *toggle_advance.id() =>
            {
                if !approved {
                    return;
                }
                let Some(preferences) = &mut preferences else { return };
                let enabled = toggle_iframe.is_checked();
                let next_automatically = toggle_advance.is_checked();
                if enabled == mode.iframe_player && next_automatically == automatic {
                    return;
                }
                if event.id == *toggle_iframe.id() {
                    preferred_iframe = enabled;
                }
                if let Err(reason) = preferences.set_playback(preferred_iframe, next_automatically) {
                    eprintln!("Could not save playback preferences: {reason}");
                    preferences_problem = Some("Playback preferences changed for this session. They could not be saved.");
                    toggle_iframe.set_text(format!("{IFRAME_MENU_LABEL} (This Session)"));
                    toggle_advance.set_text(format!("{AUTO_ADVANCE_LABEL} (This Session)"));
                } else {
                    preferences_problem = None;
                    toggle_iframe.set_text(IFRAME_MENU_LABEL);
                    toggle_advance.set_text(AUTO_ADVANCE_LABEL);
                }
                automatic = next_automatically;
                if !automatic && auto_advance.cancel() {
                    reload_player = true;
                }
                if enabled != mode.iframe_player {
                    mode.iframe_player = enabled;
                    toggle_advance.set_enabled(enabled);
                    transport = enabled.then(transport::Transport::default);
                    if enabled {
                        if lyrics.is_none() {
                            lyrics = lyrics_worker();
                        }
                    } else {
                        if let Some(lyrics) = &mut lyrics {
                            lyrics.select(None, None, None);
                        }
                        if let Err(reason) = controls.evaluate_script("window.renderPearTransport?.(null);") {
                            eprintln!("Could not reset the playback controls: {reason}");
                        }
                    }
                    reload_player = true;
                }
                true
            }
            Event::UserEvent(PlayerEvent::Menu(event))
                if event.id == *toggle_queue.id() || event.id == *add_video.id() || event.id == *legal.id() =>
            {
                let opening_legal = event.id == *legal.id();
                if !approved && !opening_legal {
                    return;
                }
                let adding = event.id == *add_video.id();
                let show = opening_legal || adding || !queue_visible;
                if show != queue_visible {
                    match layout.arrange(&window, current_player.as_ref(), &controls, show) {
                        Ok(()) => {
                            queue_visible = show;
                            toggle_queue.set_text(if show { "Hide Queue" } else { "Show Queue" });
                            #[cfg(any(target_os = "macos", target_os = "linux"))]
                            if let Err(reason) = controls.evaluate_script(&format!(
                                    "window.setPearPanelVisible?.({show});"
                                ))
                            {
                                eprintln!("Could not update sidebar visibility: {reason}");
                            }
                            if !show && let Some(player) = current_player.as_ref() {
                                let _ = player.focus();
                            }
                        }
                        Err(reason) => {
                            let _ = layout.arrange(
                                &window, current_player.as_ref(), &controls, queue_visible,
                            );
                            error = Some(format!("Could not change the queue view: {reason}"));
                        }
                    }
                }
                if opening_legal {
                    show_legal = true;
                    if let Err(reason) = controls.focus() {
                        eprintln!("Could not focus Terms and Privacy: {reason}");
                    }
                } else if adding {
                    show_legal = false;
                    legal_problem = None;
                    focus_add_field = true;
                }
                true
            }
            Event::UserEvent(PlayerEvent::TitleChanged(id, title)) if id == generation => {
                let first_title = titled_generation != Some(id);
                if first_title {
                    if mode.smoke {
                        println!("PEAR_QUEUE_VIDEO_TITLE");
                    }
                    titled_generation = Some(id);
                    load_deadline = None;
                    loading_slow = false;
                }
                if let Some(current) = library.state().current.clone() {
                    match library.remember_title(&current, &title) {
                        Ok(false) if !first_title => return,
                        Ok(_) => {}
                        Err(reason) => error = Some(reason.to_string()),
                    }
                }
                true
            }
            Event::UserEvent(PlayerEvent::VideoProblem(id, message)) if id == generation => {
                load_deadline = None;
                player_error = Some(message.into());
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                if let Some(transport) = &mut transport {
                    transport.reset(false);
                }
                true
            }
            Event::UserEvent(PlayerEvent::Metadata(id, response)) => lookup
                .as_mut()
                .is_some_and(|lookup| lookup.receive(&id, response, Instant::now())),
            Event::UserEvent(PlayerEvent::SearchResults(revision, response)) => catalog
                .as_mut()
                .is_some_and(|catalog| catalog.receive(revision, response, Instant::now())),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Event::UserEvent(PlayerEvent::LyricsResult(revision, response)) => lyrics
                .as_mut()
                .is_some_and(|lyrics| lyrics.receive(revision, response, Instant::now())),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Event::UserEvent(PlayerEvent::TransportCommitted(id)) if id == generation => {
                if let Some(transport) = &mut transport {
                    transport.reset(true);
                }
                false
            }
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Event::UserEvent(PlayerEvent::TransportSample(id, sequence, response)) if id == generation => {
                let Some(transport) = &mut transport else { return };
                let previous_status = (transport.ready(), transport.is_stale());
                let now = Instant::now();
                if !transport.receive(sequence, &response, now) { return; }
                let sample = transport.observed_at(now);
                advance_resolution = auto_advance.resolve(library.state(), sample, now);
                let foreground_automatic = automatic
                    && window.is_visible()
                    && window.is_focused()
                    && !window.is_minimized();
                let starting = if advance_resolution.is_none() {
                    current_player.as_ref().and_then(|video| {
                        let action = auto_advance.observe(library.state(), sample?, foreground_automatic, now)?;
                        Some((video, action))
                    })
                } else {
                    None
                };
                if let Some((video, action)) = starting {
                    if let Err(reason) = transport.perform(video, action) {
                        eprintln!("Could not start the next video automatically: {reason}");
                        advance_resolution = auto_advance.manual();
                    }
                    true
                } else if advance_resolution.is_some() {
                    true
                } else if auto_advance.pending() {
                    false
                } else if let Some(problem) = transport.problem() {
                    player_error = Some(problem.into());
                    load_deadline = None;
                    transport.reset(false);
                    true
                } else if previous_status != (transport.ready(), transport.is_stale()) {
                    if transport.ready() {
                        if mode.smoke {
                            println!("PEAR_QUEUE_TRANSPORT_READY");
                        }
                        load_deadline = None;
                        loading_slow = false;
                    }
                    true
                } else {
                    false
                }
            }
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => {
                let now = Instant::now();
                let metadata_changed = lookup.as_mut().is_some_and(|lookup| lookup.tick(now));
                let catalog_changed = catalog.as_mut().is_some_and(|catalog| catalog.tick(now));
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                let expired = transport.as_mut().is_some_and(|transport| transport.expire(now));
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                if let (Some(transport), Some(video)) = (&mut transport, &current_player)
                    && let Some(sequence) = transport.begin(now)
                {
                    let results = results.clone();
                    if let Err(reason) = iframe::Page::observe(video, move |snapshot| {
                        let _ = results.send_event(PlayerEvent::TransportSample(generation, sequence, snapshot));
                    }) {
                        eprintln!("Could not read player state: {reason}");
                        transport.receive(sequence, "null", now);
                    }
                }
                let overdue = load_deadline.is_some_and(|deadline| now >= deadline);
                if overdue {
                    load_deadline = None;
                    loading_slow = true;
                    #[cfg(target_os = "windows")]
                    if mode.smoke && let Some(player) = &current_player {
                        platform::diagnose_video(player);
                    }
                }
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                let overdue = {
                    let lyrics_changed = lyrics.as_mut().is_some_and(|lyrics| lyrics.tick(now));
                    advance_resolution = auto_advance.resolve(library.state(), None, now);
                    overdue || expired || lyrics_changed || advance_resolution.is_some()
                };
                overdue || metadata_changed || catalog_changed
            }
            Event::UserEvent(PlayerEvent::Command(message)) => {
                acknowledged_sequence = Some(message.sequence);
                match message.command {
                    Command::Ready {} => {
                        verify_controls = mode.smoke && !controls_ready;
                        controls_ready = true;
                    }
                    Command::OpenLegalLink { link } => {
                        legal_problem = match open::that_detached(link.url()) {
                            Ok(()) => None,
                            Err(reason) => {
                                eprintln!("Could not open the policy link: {reason}");
                                Some("Could not open the policy link in your browser.")
                            }
                        };
                    }
                    Command::AcceptLegal { revision } => {
                        if !approved {
                            if let Err(reason) = consent.accept(revision) {
                                eprintln!("Could not save privacy agreement: {reason}");
                                legal_problem = Some("Could not save your agreement. Try again.");
                            } else {
                                approved = true;
                                show_legal = false;
                                legal_problem = None;
                                reload.set_enabled(true);
                                toggle_queue.set_enabled(true);
                                add_video.set_enabled(true);
                                #[cfg(any(target_os = "macos", target_os = "linux"))]
                                toggle_iframe.set_enabled(preferences.is_some());
                                #[cfg(any(target_os = "macos", target_os = "linux"))]
                                toggle_advance.set_enabled(preferences.is_some() && mode.iframe_player);
                                (catalog, lookup) = start_youtube_clients(&service_events, library.state().current.as_deref());
                                #[cfg(any(target_os = "macos", target_os = "linux"))]
                                if mode.iframe_player {
                                    lyrics = lyrics_worker();
                                }
                                reload_player = true;
                            }
                        }
                    }
                    Command::CloseLegal {} => {
                        if approved {
                            show_legal = false;
                            legal_problem = None;
                        }
                    }
                    Command::DeclineLegal {} => {
                        if !approved {
                            *flow = ControlFlow::Exit;
                            return;
                        }
                    }
                    _ if !approved => {}
                    Command::OpenBrowser {} => {
                        if let Some(id) = &library.state().current
                            && let Err(reason) =
                                open::that_detached(format!("https://www.youtube.com/watch?v={id}"))
                        {
                            error = Some(format!("Could not open the browser: {reason}"));
                        }
                    }
                    Command::Search { query } => {
                        if let Some(catalog) = &mut catalog {
                            catalog.submit(&query, Instant::now());
                        }
                    }
                    Command::Playlist(command) => {
                        #[cfg(any(target_os = "macos", target_os = "linux"))]
                        let cancel_switch = auto_advance.pending()
                            && matches!(&command, crate::library::playlists::Command::SelectPlaylistTrack { video, .. }
                                if library.state().current.as_ref() == Some(video));
                        #[cfg(target_os = "windows")]
                        let cancel_switch = false;
                        match playlists.apply(command, &mut library) {
                            Ok(changed) => reload_player = changed || cancel_switch,
                            Err(reason) => error = Some(reason.to_string()),
                        }
                    }
                    #[cfg(any(target_os = "macos", target_os = "linux"))]
                    Command::FindLyrics { title, artist } => {
                        if mode.iframe_player && let Some(lyrics) = &mut lyrics {
                            lyrics.submit(&title, &artist, Instant::now());
                        }
                    }
                    #[cfg(any(target_os = "macos", target_os = "linux"))]
                    command @ (Command::SetPlayback { .. } | Command::Seek { .. }) => {
                        if auto_advance.pending() {
                            error = Some("Waiting for the next video to start.".into());
                        } else if let (Some(transport), Some(video)) = (&mut transport, &current_player) {
                            let action = match command {
                                Command::SetPlayback { playing: true } => iframe::Action::Play,
                                Command::SetPlayback { playing: false } => iframe::Action::Pause,
                                Command::Seek { position } => iframe::Action::Seek(position),
                                _ => unreachable!("only transport commands enter this arm"),
                            };
                            if mode.smoke {
                                let name = match &action {
                                    iframe::Action::Play => "play",
                                    iframe::Action::Pause => "pause",
                                    iframe::Action::Seek(_) => "seek",
                                iframe::Action::Advance { .. } => "advance",
                                };
                                println!("PEAR_QUEUE_TRANSPORT_COMMAND {name}");
                            }
                            if let Err(reason) = transport.perform(video, action) {
                                transport.resend_controls();
                                error = Some(reason.to_string());
                            }
                        } else {
                            error = Some("Playback controls are unavailable for this video.".into());
                        }
                    }
                    command => {
                        #[cfg(any(target_os = "macos", target_os = "linux"))]
                        let cancel_switch = auto_advance.pending()
                            && matches!(&command, Command::Select { id }
                                if library.state().current.as_ref() == Some(id));
                        #[cfg(target_os = "windows")]
                        let cancel_switch = false;
                        match library.apply(command) {
                            Ok(changed) => reload_player = changed || cancel_switch,
                            Err(reason) => error = Some(reason.to_string()),
                        }
                    }
                }
                true
            }
            _ => return,
        };

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let update_queue = {
            if !reload_player && update_queue && advance_resolution.is_none() {
                advance_resolution = auto_advance.resolve(library.state(), None, Instant::now());
            }
            if let Some(resolution) = advance_resolution {
                use advance::Resolution;
                let (selection, reuse_player) = match resolution {
                    Resolution::Playing(id) => (Some(id), true),
                    Resolution::NeedsPlay(id) => (Some(id), false),
                    Resolution::KeepCurrent => (None, true),
                    Resolution::Superseded => (None, false),
                };
                reload_player = !reuse_player;
                if let Some(id) = selection {
                    match library.apply(Command::Select { id }) {
                        Ok(_) if reuse_player => {
                            if let Some(lookup) = &mut lookup {
                                lookup.select(library.state().current.as_deref());
                            }
                            if let Some(transport) = &mut transport {
                                transport.resend_controls();
                            }
                            load_deadline = None;
                            loading_slow = false;
                        }
                        Ok(_) => {}
                        Err(reason) => {
                            reload_player = true;
                            error = Some(reason.to_string());
                        }
                    }
                }
                true
            } else {
                update_queue
            }
        };

        if reload_player {
            generation += 1;
            load_deadline = None;
            loading_slow = false;
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            {
                auto_advance.cancel();
                if let Some(transport) = &mut transport {
                    transport.reset(false);
                }
            }
            if let Some(lookup) = &mut lookup {
                lookup.select(library.state().current.as_deref());
            }
            // Remove the old WebView before creating the next one so its audio stops
            // even if the new WebView fails to initialize.
            drop(current_player.take());
            match load(&layout, &window, &library, generation, queue_visible, mode) {
                Ok(video) => {
                    current_player = Some(video);
                    player_error = None;
                    if library.state().current.is_some() {
                        load_deadline = Some(Instant::now() + LOAD_TIMEOUT);
                    }
                }
                Err(reason) => player_error = Some(format!("Could not open the player: {reason}")),
            }
            if let Err(reason) = layout.arrange(&window, current_player.as_ref(), &controls, queue_visible) {
                eprintln!("Could not arrange the player: {reason}");
            }
        }

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let switching = auto_advance.pending();
        #[cfg(target_os = "windows")]
        let switching = false;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let update_queue = {
            let duration_changed = mode.iframe_player && lyrics.as_mut().is_some_and(|lyrics| {
                if update_queue || reload_player {
                    let queue = library.state();
                    let current = queue.current.as_deref();
                    let metadata = lookup.as_ref().and_then(metadata_lookup::Lookup::metadata);
                    let title = metadata
                        .map(|metadata| metadata.title.as_str())
                        .or_else(|| current.and_then(|id| queue.titles.get(id).map(String::as_str)));
                    let channel = metadata.map(|metadata| metadata.channel.as_str());
                    lyrics.select(current, title, channel);
                }
                lyrics.set_duration(
                    (!switching)
                        .then(|| transport.as_ref().and_then(transport::Transport::duration))
                        .flatten(),
                )
            });
            update_queue || duration_changed
        };
        *flow = player_flow(
            load_deadline,
            lookup.as_ref().and_then(metadata_lookup::Lookup::deadline),
            catalog.as_ref().and_then(catalog::Catalog::deadline),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            transport.as_ref(),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            lyrics.as_ref().and_then(lyrics_lookup::Lookup::deadline),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            auto_advance.deadline(),
            #[cfg(target_os = "linux")]
            &mut timer,
        );
        if controls_ready && update_queue {
            let player_ready = titled_generation == Some(generation);
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            let player_ready = player_ready || transport.as_ref().is_some_and(transport::Transport::ready);
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            let loading_slow = loading_slow || transport.as_ref().is_some_and(transport::Transport::is_stale);
            let notice = if switching {
                Some("Opening the next video…")
            } else if library.state().current.is_none()
                || player_error.is_some()
                || player_ready
            {
                None
            } else if loading_slow {
                Some("Could not confirm the video loaded. Use Reload Player or Open in browser if playback is unavailable.")
            } else {
                Some("Opening the YouTube player…")
            };
            if let Err(error) = render(
                &controls,
                QueueView {
                    queue: library.state(),
                    metadata: lookup.as_ref().and_then(metadata_lookup::Lookup::metadata),
                    metadata_problem: lookup.as_ref().and_then(metadata_lookup::Lookup::problem),
                    catalog: catalog.as_ref().map(catalog::Catalog::view),
                    saved_playlists: playlists.view(),
                    legal: LegalView {
                        accepted: approved,
                        show: show_legal,
                        revision: consent::REVISION,
                        problem: legal_problem,
                    },
                    #[cfg(any(target_os = "macos", target_os = "linux"))]
                    preferences_problem,
                    #[cfg(any(target_os = "macos", target_os = "linux"))]
                    lyrics: lyrics.as_ref().and_then(lyrics_lookup::Lookup::view),
                    #[cfg(any(target_os = "macos", target_os = "linux"))]
                    lyrics_switching: switching,
                },
                error.as_deref(),
                notice,
                acknowledged_sequence,
                player_error.as_deref(),
                verify_controls,
            ) {
                eprintln!("Could not update the queue controls: {error}");
            }
        }
        if focus_add_field && let Err(reason) = focus_add(&controls) {
            eprintln!("Could not focus the video field: {reason}");
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if approved && controls_ready && let Some(transport) = &mut transport
            && let Err(reason) = transport.render(&controls, !switching && library.state().current.is_some())
        {
            eprintln!("Could not update the playback controls: {reason}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_only_embedded_video_titles() {
        assert_eq!(
            video_title("  A song - Live - YouTube "),
            Some("A song - Live")
        );
        for value in [
            "",
            "YouTube",
            "YouTube - YouTube",
            "Video unavailable - YouTube",
            "Player",
        ] {
            assert_eq!(video_title(value), None);
        }
    }

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
    fn accepts_known_playlist_commands_without_extra_fields() {
        let command = |payload: &str| {
            let request = Request::builder()
                .uri(CONTROLS_URL)
                .body(format!(r#"{{"sequence":1,"command":{payload}}}"#))
                .unwrap();
            controls_command(&request)
        };
        assert!(matches!(
            command(r#"{"type":"save_playlist","name":"Evening"}"#),
            Some(ControlMessage {
                command: Command::Playlist(crate::library::playlists::Command::SavePlaylist { name }),
                ..
            }) if name == "Evening"
        ));
        for invalid in [
            r#"{"type":"save_playlist","name":"Evening","id":1}"#,
            r#"{"type":"close_playlist","also_remove":true}"#,
            r#"{"type":"select_playlist_track","id":1}"#,
            r#"{"type":"append_playlist","id":-1}"#,
        ] {
            assert!(command(invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn opens_only_named_policy_links_from_local_controls() {
        let request = |link: &str| {
            Request::builder()
                .uri(CONTROLS_URL)
                .body(format!(
                    r#"{{"sequence":1,"command":{{"type":"open_legal_link","link":"{link}"}}}}"#
                ))
                .unwrap()
        };
        let Some(ControlMessage {
            command: Command::OpenLegalLink { link },
            ..
        }) = controls_command(&request("youtube_terms"))
        else {
            panic!("Expected a YouTube policy link command");
        };
        assert_eq!(link.url(), "https://www.youtube.com/t/terms");
        assert!(controls_command(&request("https://example.invalid")).is_none());
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
        let response = controls_response(request(CONTROLS_ASSET_URL, "GET"));
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()[header::CONTENT_SECURITY_POLICY],
            CONTROLS_CSP
        );
        assert_eq!(
            controls_response(request(CONTROLS_ASSET_URL, "POST")).status(),
            404
        );
        assert_eq!(
            controls_response(request("pear-queue://app.local/other.html", "GET")).status(),
            404
        );
    }
}
