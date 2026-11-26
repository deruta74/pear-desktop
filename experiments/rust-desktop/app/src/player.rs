//! The desktop queue separates its local controls from the remote video.
#[cfg(target_os = "macos")]
mod iframe;
mod metadata;
mod metadata_lookup;
mod platform;
#[cfg(target_os = "macos")]
mod transport;
use std::{
    borrow::Cow,
    fs::{self, File, OpenOptions},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

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
    event_loop::{ControlFlow, EventLoopBuilder},
    window::{Window, WindowBuilder},
};
use wry::{
    NewWindowResponse, PermissionResponse, WebView, WebViewBuilder,
    http::{HeaderMap, HeaderValue, Request, Response, header},
};

#[cfg(target_os = "macos")]
use wry::{PageLoadEvent, WebViewBuilderExtDarwin};

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
const CONTROLS_CSP: &str = "default-src 'none'; script-src pear-queue:; style-src pear-queue:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
#[cfg(target_os = "windows")]
const CONTROLS_CSP: &str = "default-src 'none'; script-src https://pear-queue.app.local; style-src https://pear-queue.app.local; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MAX_IPC_BYTES: usize = 4096;
const LOAD_TIMEOUT: Duration = Duration::from_secs(15);

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
    #[cfg(target_os = "macos")]
    TransportCommitted(u64),
    #[cfg(target_os = "macos")]
    TransportSample(u64, u64, String),
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
}

pub struct LaunchMode {
    smoke: bool,
    iframe_player: bool,
}

pub fn launch_mode() -> Result<Option<LaunchMode>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let queue = args.len() == 1 && args[0] == "--queue";
    let smoke = cfg!(feature = "benchmark") && args.len() == 1 && args[0] == "--queue-smoke";
    let iframe_player = args.len() == 1 && args[0] == "--iframe-player";
    #[cfg(not(target_os = "macos"))]
    if iframe_player {
        return Err("The IFrame API player preview currently requires macOS.".into());
    }
    #[cfg(target_os = "macos")]
    {
        let bundled = NSBundle::mainBundle()
            .bundleIdentifier()
            .is_some_and(|id| id.to_string() == APP_ID);
        if (queue || smoke || iframe_player) && !bundled {
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
    iframe_player: bool,
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
    #[cfg(target_os = "macos")]
    if iframe_player {
        let page = Arc::new(iframe::Page::new(id)?);
        let navigation = page.clone();
        let view = layout.build(
            window,
            move |builder| {
                isolated_builder(builder)
                    .with_allow_link_preview(false)
                    .with_navigation_handler(move |candidate| navigation.permits(&candidate))
                    .with_on_page_load_handler(move |event, url| {
                        if matches!(event, PageLoadEvent::Started)
                            && iframe::Page::is_wrapper_url(&url)
                        {
                            let _ = events.send_event(PlayerEvent::TransportCommitted(generation));
                        }
                    })
                    .with_on_web_content_process_terminate_handler(move || {
                        report_problem(
                            "The video player stopped. Use Reload Player or Open in browser.",
                        );
                    })
            },
            Pane::Video,
            queue_visible,
        )?;
        page.load(&view)?;
        return Ok(view);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = iframe_player;
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
    )?;
    #[cfg(target_os = "linux")]
    platform::observe_video(&view, &url, report_problem);
    #[cfg(target_os = "windows")]
    platform::observe_video(&view, report_problem)?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::REFERER,
        HeaderValue::from_str(&format!("https://{APP_ID}"))?,
    );
    view.load_url_with_headers(&url, headers)?;
    Ok(view)
}

fn focus_add(controls: &WebView) -> wry::Result<()> {
    controls.focus()?;
    controls.evaluate_script("document.getElementById('video-source')?.focus();")
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
    #[cfg(target_os = "macos")] transport: Option<&transport::Transport>,
) -> ControlFlow {
    let deadlines = load.into_iter().chain(metadata);
    #[cfg(target_os = "macos")]
    let deadlines = deadlines.chain(transport.and_then(transport::Transport::deadline));
    deadlines
        .min()
        .map_or(ControlFlow::Wait, ControlFlow::WaitUntil)
}

pub fn run(mode: LaunchMode) -> Result<()> {
    let (queue_path, queue_lock) = queue_path_and_lock()?;
    let data_dir = queue_path
        .parent()
        .ok_or("Queue directory is unavailable")?
        .to_owned();
    let mut library = Library::load(queue_path)?;
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
    let reload = MenuItem::new("Reload Player", true, accelerator(CMD_OR_CTRL, Code::KeyR));
    let toggle_queue = MenuItem::new(
        "Hide Queue",
        true,
        accelerator(CMD_OR_CTRL | Modifiers::SHIFT, Code::KeyL),
    );
    let add_video = MenuItem::new("Add Video", true, accelerator(CMD_OR_CTRL, Code::KeyL));
    let app_menu = Submenu::with_items("Pear Desktop", true, &[&quit])?;
    let file_menu = Submenu::with_items("File", true, &[&add_video])?;
    let view_menu = Submenu::with_items("View", true, &[&toggle_queue, &reload])?;
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
    let menu = Menu::with_items(&[&app_menu, &file_menu, &edit_menu, &view_menu])?;
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
    let iframe_player = mode.iframe_player;
    let load =
        move |layout: &Layout, window: &Window, library: &Library, generation, queue_visible| {
            show_video(
                layout,
                window,
                queue_visible,
                library.state().current.as_deref(),
                generation,
                loader.clone(),
                iframe_player,
            )
        };
    let mut queue_visible = true;
    let mut generation = 0;
    let (mut current_player, mut player_error) =
        match load(&layout, &window, &library, generation, queue_visible) {
            Ok(video) => (Some(video), None),
            Err(error) => (None, Some(format!("Could not open the player: {error}"))),
        };
    let mut load_deadline = (current_player.is_some() && library.state().current.is_some())
        .then(|| Instant::now() + LOAD_TIMEOUT);
    let mut loading_slow = false;
    let mut titled_generation = None;
    let mut controls_ready = false;
    let mut lookup = (!mode.smoke)
        .then(metadata::Client::from_env)
        .flatten()
        .and_then(
            |client| match metadata_lookup::Lookup::new(client, event_loop.create_proxy()) {
                Ok(mut lookup) => {
                    lookup.select(library.state().current.as_deref());
                    Some(lookup)
                }
                Err(_) => {
                    eprintln!("Could not start YouTube video details lookup.");
                    None
                }
            },
        );
    #[cfg(target_os = "macos")]
    let mut transport = iframe_player.then(transport::Transport::default);
    #[cfg(target_os = "macos")]
    let results = event_loop.create_proxy();

    event_loop.run(move |event, _, flow| {
        let _keep_alive = (&menu, &queue_lock);
        *flow = player_flow(
            load_deadline,
            lookup.as_ref().and_then(metadata_lookup::Lookup::deadline),
            #[cfg(target_os = "macos")]
            transport.as_ref(),
        );
        let mut reload_player = false;
        let mut error = None;
        let mut acknowledged_sequence = None;
        let mut verify_controls = false;
        let update_queue = match event {
            Event::WindowEvent {
                window_id, event, ..
            } if window_id == window.id() => {
                match event {
                    WindowEvent::CloseRequested => *flow = ControlFlow::Exit,
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
                reload_player = true;
                true
            }
            Event::UserEvent(PlayerEvent::Menu(event))
                if event.id == *toggle_queue.id() || event.id == *add_video.id() =>
            {
                let adding = event.id == *add_video.id();
                let show = adding || !queue_visible;
                if show != queue_visible {
                    match layout.arrange(&window, current_player.as_ref(), &controls, show) {
                        Ok(()) => {
                            queue_visible = show;
                            toggle_queue.set_text(if show { "Hide Queue" } else { "Show Queue" });
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
                if adding && let Err(reason) = focus_add(&controls) {
                    error = Some(format!("Could not focus the video field: {reason}"));
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
                #[cfg(target_os = "macos")]
                if let Some(transport) = &mut transport {
                    transport.reset(false);
                }
                true
            }
            Event::UserEvent(PlayerEvent::Metadata(id, response)) => lookup
                .as_mut()
                .is_some_and(|lookup| lookup.receive(&id, response, Instant::now())),
            #[cfg(target_os = "macos")]
            Event::UserEvent(PlayerEvent::TransportCommitted(id)) if id == generation => {
                if let Some(transport) = &mut transport {
                    transport.reset(true);
                }
                false
            }
            #[cfg(target_os = "macos")]
            Event::UserEvent(PlayerEvent::TransportSample(id, sequence, response)) if id == generation => {
                let Some(transport) = &mut transport else { return };
                let previous_status = (transport.ready(), transport.is_stale());
                if !transport.receive(sequence, &response, Instant::now()) { return; }
                if let Some(problem) = transport.problem() {
                    player_error = Some(problem.into());
                    load_deadline = None;
                    transport.reset(false);
                    true
                } else if previous_status != (transport.ready(), transport.is_stale()) {
                    if transport.ready() {
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
                #[cfg(target_os = "macos")]
                let expired = transport.as_mut().is_some_and(|transport| transport.expire(now));
                #[cfg(target_os = "macos")]
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
                }
                #[cfg(target_os = "macos")]
                let overdue = overdue || expired;
                overdue || metadata_changed
            }
            Event::UserEvent(PlayerEvent::Command(message)) => {
                acknowledged_sequence = Some(message.sequence);
                match message.command {
                    Command::Ready {} => {
                        verify_controls = mode.smoke && !controls_ready;
                        controls_ready = true;
                    }
                    Command::OpenBrowser {} => {
                        if let Some(id) = &library.state().current
                            && let Err(reason) =
                                open::that_detached(format!("https://www.youtube.com/watch?v={id}"))
                        {
                            error = Some(format!("Could not open the browser: {reason}"));
                        }
                    }
                    #[cfg(target_os = "macos")]
                    command @ (Command::SetPlayback { .. } | Command::Seek { .. }) => {
                        if let (Some(transport), Some(video)) = (&mut transport, &current_player) {
                            let action = match command {
                                Command::SetPlayback { playing: true } => iframe::Action::Play,
                                Command::SetPlayback { playing: false } => iframe::Action::Pause,
                                Command::Seek { position } => iframe::Action::Seek(position),
                                _ => unreachable!("only transport commands enter this arm"),
                            };
                            if let Err(reason) = transport.perform(video, action) {
                                transport.resend_controls();
                                error = Some(reason.to_string());
                            }
                        } else {
                            error = Some("Playback controls are unavailable for this video.".into());
                        }
                    }
                    command => match library.apply(command) {
                        Ok(changed) => reload_player = changed,
                        Err(reason) => error = Some(reason.to_string()),
                    },
                }
                true
            }
            _ => return,
        };

        if reload_player {
            generation += 1;
            load_deadline = None;
            loading_slow = false;
            #[cfg(target_os = "macos")]
            if let Some(transport) = &mut transport {
                transport.reset(false);
            }
            if let Some(lookup) = &mut lookup {
                lookup.select(library.state().current.as_deref());
            }
            // Remove the old WebView before creating the next one so its audio stops
            // even if the new WebView fails to initialize.
            drop(current_player.take());
            match load(&layout, &window, &library, generation, queue_visible) {
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

        *flow = player_flow(
            load_deadline,
            lookup.as_ref().and_then(metadata_lookup::Lookup::deadline),
            #[cfg(target_os = "macos")]
            transport.as_ref(),
        );
        if controls_ready && update_queue {
            let player_ready = titled_generation == Some(generation);
            #[cfg(target_os = "macos")]
            let player_ready = player_ready || transport.as_ref().is_some_and(transport::Transport::ready);
            #[cfg(target_os = "macos")]
            let loading_slow = loading_slow || transport.as_ref().is_some_and(transport::Transport::is_stale);
            let notice = if library.state().current.is_none()
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
        #[cfg(target_os = "macos")]
        if controls_ready && let Some(transport) = &mut transport
            && let Err(reason) = transport.render(&controls, library.state().current.is_some())
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
