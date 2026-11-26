//! The desktop queue separates its local controls from the remote video.
pub(crate) mod account;
mod account_catalog;
mod account_oauth;
mod advance;
mod catalog;
mod consent;
mod credential_setup;
mod iframe;
mod lyrics;
mod lyrics_lookup;
mod metadata;
mod metadata_lookup;
mod platform;
#[cfg(target_os = "linux")]
pub(crate) use platform::DeadlineTimer;
pub(crate) use platform::data_root;
mod playlists;
mod preferences;
mod speed_menu;
mod transport;
use std::{
    borrow::Cow,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

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
const IFRAME_MENU_LABEL: &str = "Experimental Playback Controls";
const AUTO_ADVANCE_LABEL: &str = "Play Next Automatically";

enum PlayerEvent {
    Menu(MenuEvent),
    Command(ControlMessage),
    TitleChanged(u64, String),
    VideoProblem(u64, &'static str),
    Metadata(String, metadata_lookup::Response),
    SearchResults(u64, catalog::Response),
    TransportCommitted(u64),
    TransportSample(u64, u64, String),
    LyricsResult(u64, lyrics_lookup::Response),
    Account(u32, account::Outcome),
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
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    public_playlist: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<&'a metadata::Metadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata_problem: Option<&'static str>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    browser_search: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    catalog: Option<&'a catalog::View>,
    #[serde(skip_serializing_if = "Option::is_none")]
    catalog_key_problem: Option<&'static str>,
    saved_playlists: playlists::View<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    account: Option<account::View<'a>>,
    legal: LegalView<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preferences_problem: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lyrics: Option<&'a lyrics_lookup::View>,
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
    iframe_player: bool,
    audio_output: iframe::AudioOutput,
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
                audio_output: iframe::AudioOutput::default(),
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
        audio_output: iframe::AudioOutput::default(),
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
            "pear-queue://app.local/history-swipes.js" => Some((
                "text/javascript; charset=utf-8",
                include_bytes!("../ui/history-swipes.js"),
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

pub(crate) fn isolated_builder(builder: WebViewBuilder<'_>) -> WebViewBuilder<'_> {
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

fn music_search_url(query: &str) -> Result<url::Url> {
    let (endpoint, parameter, value) = match catalog::Query::parse(query)? {
        catalog::Query::Search(query) => ("search", "q", query),
        catalog::Query::Playlist(id) => ("playlist", "list", id),
    };
    let mut url = url::Url::parse("https://music.youtube.com/")?;
    url.set_path(endpoint);
    url.query_pairs_mut().append_pair(parameter, &value);
    Ok(url)
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PlaybackTarget<'a> {
    Queue(&'a str),
    PublicPlaylist(&'a iframe::PublicPlaylist),
}

fn playback_target<'a>(
    queue: &'a QueueState,
    playlist: Option<&'a iframe::PublicPlaylist>,
) -> Option<PlaybackTarget<'a>> {
    match playlist {
        Some(playlist) => Some(PlaybackTarget::PublicPlaylist(playlist)),
        None => queue.current.as_deref().map(PlaybackTarget::Queue),
    }
}

fn queue_video<'a>(
    queue: &'a QueueState,
    playlist: Option<&iframe::PublicPlaylist>,
) -> Option<&'a str> {
    if playlist.is_some() {
        None
    } else {
        queue.current.as_deref()
    }
}

fn queue_edit_requires_reload(
    playlist: &mut Option<iframe::PublicPlaylist>,
    selecting: bool,
    queue_requires_reload: bool,
) -> bool {
    let leaving_playlist = selecting && playlist.take().is_some();
    leaving_playlist || (playlist.is_none() && queue_requires_reload)
}

fn show_video(
    layout: &Layout,
    window: &Window,
    queue_visible: bool,
    target: PlaybackTarget<'_>,
    generation: u64,
    events: tao::event_loop::EventLoopProxy<PlayerEvent>,
    mode: LaunchMode,
) -> Result<WebView> {
    let problem_events = events.clone();
    let report_problem = move |message| {
        let _ = problem_events.send_event(PlayerEvent::VideoProblem(generation, message));
    };
    let page = match target {
        PlaybackTarget::PublicPlaylist(playlist) => Some(iframe::Page::playlist(playlist)?),
        PlaybackTarget::Queue(id) if mode.iframe_player => Some(iframe::Page::new(id)?),
        PlaybackTarget::Queue(_) => None,
    };
    if let Some(page) = page {
        let page = Arc::new(page);
        #[cfg(not(target_os = "windows"))]
        let navigation = page.clone();
        #[cfg(target_os = "windows")]
        let html = page.html(&iframe::wrapper_url(), mode.audio_output)?;
        let view = layout.build(
            window,
            move |builder| {
                let builder =
                    isolated_builder(builder).with_on_page_load_handler(move |event, url| {
                        if matches!(event, PageLoadEvent::Started)
                            && iframe::Page::is_wrapper_url(&url)
                        {
                            let _ = events.send_event(PlayerEvent::TransportCommitted(generation));
                        }
                    });
                #[cfg(not(target_os = "windows"))]
                let builder = builder
                    .with_navigation_handler(move |candidate| navigation.permits(&candidate));
                #[cfg(target_os = "windows")]
                let builder = {
                    use wry::WebViewBuilderExtWindows;

                    builder
                        .with_https_scheme(true)
                        .with_browser_accelerator_keys(false)
                        .with_default_context_menus(false)
                        .with_custom_protocol(
                            iframe::WINDOWS_WRAPPER_SCHEME.into(),
                            move |_, request| {
                                iframe::Page::windows_wrapper_response(&request, &html)
                            },
                        )
                        .with_navigation_handler(iframe::Page::windows_top_level_navigation())
                };
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
        #[cfg(target_os = "windows")]
        {
            let navigation = page.clone();
            platform::restrict_video_frames(&view, move |url| navigation.permits_frame(url))?;
            let url = iframe::wrapper_url();
            platform::observe_video(&view, &url, false, Some(page), report_problem)?;
            view.load_url(&url)?;
        }
        #[cfg(not(target_os = "windows"))]
        page.load(&view, mode.audio_output)?;
        return Ok(view);
    }
    let PlaybackTarget::Queue(id) = target else {
        unreachable!("public playlists use the local IFrame wrapper");
    };
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
        let observer = platform::observe_video(&view, &url, mode.smoke, None, report_problem);
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

fn launch_local_audio() -> Option<&'static str> {
    match crate::local_audio::launch() {
        Ok(()) => None,
        Err(reason) => {
            eprintln!("Could not open the local audio window: {reason}");
            Some("Could not open the local audio window.")
        }
    }
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
        // A platform error must not expose the script or the account rows it carries.
        controls
            .evaluate_script(&script)
            .map_err(|_| "Could not evaluate the queue update.")?;
    }
    Ok(())
}

fn player_flow(
    load: Option<Instant>,
    metadata: Option<Instant>,
    catalog: Option<Instant>,
    transport: Option<&transport::Transport>,
    lyrics: Option<Instant>,
    local_deadlines: [Option<Instant>; 2],
    #[cfg(target_os = "linux")] timer: &mut platform::DeadlineTimer,
) -> ControlFlow {
    let deadlines = load.into_iter().chain(metadata).chain(catalog);
    let deadlines = deadlines
        .chain(transport.and_then(transport::Transport::deadline))
        .chain(lyrics)
        .chain(local_deadlines.into_iter().flatten());
    deadline_flow(
        deadlines.min(),
        #[cfg(target_os = "linux")]
        timer,
    )
}

fn deadline_flow(
    deadline: Option<Instant>,
    #[cfg(target_os = "linux")] timer: &mut platform::DeadlineTimer,
) -> ControlFlow {
    #[cfg(target_os = "linux")]
    let deadline = timer.schedule(deadline);
    deadline.map_or(ControlFlow::Wait, ControlFlow::WaitUntil)
}

fn receive_account_outcome(
    panel: &mut account::Panel,
    stamp: u32,
    outcome: account::Outcome,
    events: &EventLoopProxy<PlayerEvent>,
) -> bool {
    let (follow_up, changed) = panel.receive(stamp, outcome);
    if let Some(job) = follow_up {
        job.spawn(events);
    }
    changed
}

fn start_youtube_clients(
    events: &EventLoopProxy<PlayerEvent>,
    current: Option<&str>,
    override_path: Option<&Path>,
    saved_path: Option<&Path>,
) -> (
    Option<catalog::Catalog>,
    Option<metadata_lookup::Lookup>,
    Option<&'static str>,
) {
    let (keyed, key_problem) = match metadata::Client::configured(override_path, saved_path) {
        Ok(client) => (client, None),
        Err(problem) => (None, Some(problem)),
    };
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
    (catalog, lookup, key_problem)
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
    let mut mode = mode;
    let mut preferences =
        (!mode.smoke).then(|| preferences::Preferences::load(data_dir.join("preferences.json")));
    let catalog_key_override = std::env::var_os("PEAR_YOUTUBE_API_KEY_FILE").map(PathBuf::from);
    let oauth_client_override = std::env::var_os(account_oauth::CLIENT_FILE_ENV).map(PathBuf::from);
    let mut preferences_problem = preferences
        .as_ref()
        .and_then(preferences::Preferences::problem);
    let mut automatic = preferences
        .as_ref()
        .is_some_and(preferences::Preferences::auto_advance);
    let mut preferred_iframe = preferences
        .as_ref()
        .is_some_and(preferences::Preferences::iframe_player);
    {
        mode.iframe_player |= preferred_iframe;
        mode.audio_output = preferences.as_ref().map_or_else(
            iframe::AudioOutput::default,
            preferences::Preferences::audio_output,
        );
        if let Some(problem) = preferences_problem {
            eprintln!("{problem}");
        }
    }
    let mut library = Library::load(queue_path)?;
    let mut playlists = playlists::Panel::load(data_dir.join("playlists.json"));
    let mut account = if approved && !mode.smoke {
        account::Panel::from_client_file(
            oauth_client_override.as_deref(),
            preferences
                .as_ref()
                .and_then(preferences::Preferences::youtube_oauth_client_file),
        )
    } else {
        None
    };
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
        false,
        accelerator(CMD_OR_CTRL | Modifiers::SHIFT, Code::KeyL),
    );
    let add_video = MenuItem::new("Add Video", approved, accelerator(CMD_OR_CTRL, Code::KeyL));
    let open_music = MenuItem::new(
        "Open in YouTube Music",
        approved && library.state().current.is_some(),
        None,
    );
    let legal = MenuItem::new("Terms and Privacy", true, None);
    let app_menu = Submenu::with_items("Pear Desktop", true, &[&quit])?;
    let local_audio = MenuItem::new("Open Local Audio Window", true, None);
    let setup_preferences = preferences.as_ref().filter(|_| approved);
    let catalog_key_menu =
        credential_setup::SetupMenu::new(credential_setup::FileKind::ApiKey, setup_preferences);
    let oauth_client_menu = credential_setup::SetupMenu::new(
        credential_setup::FileKind::OAuthClient,
        setup_preferences,
    );
    let file_menu = Submenu::with_items(
        "File",
        true,
        &[
            &add_video,
            &open_music,
            &PredefinedMenuItem::separator(),
            &catalog_key_menu.choose,
            &catalog_key_menu.forget,
            &oauth_client_menu.choose,
            &oauth_client_menu.forget,
            &PredefinedMenuItem::separator(),
            &local_audio,
        ],
    )?;
    let view_menu = Submenu::with_items("View", true, &[&toggle_queue, &reload])?;
    let toggle_iframe = CheckMenuItem::new(
        IFRAME_MENU_LABEL,
        approved && preferences.is_some(),
        mode.iframe_player,
        None,
    );
    view_menu.append(&toggle_iframe)?;
    let toggle_advance = CheckMenuItem::new(
        AUTO_ADVANCE_LABEL,
        approved && preferences.is_some() && mode.iframe_player,
        automatic,
        None,
    );
    view_menu.append(&toggle_advance)?;
    let mut speed_menu = speed_menu::SpeedMenu::new();
    view_menu.append(speed_menu.submenu())?;
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
    let experimental_panel_swipe = cfg!(target_os = "macos")
        && std::env::var_os("PEAR_PREVIEW_EXPERIMENTAL_PANEL_SWIPE")
            .is_some_and(|value| value == "1");
    let controls = layout.build(
        &window,
        move |builder| {
            let builder = isolated_builder(builder);
            let builder = if experimental_panel_swipe {
                builder.with_initialization_script("window.pearExperimentalPanelSwipe = true;")
            } else {
                builder
            };
            builder
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
                     playlist: Option<&iframe::PublicPlaylist>,
                     generation,
                     queue_visible,
                     mode| {
        playback_target(library.state(), playlist)
            .map(|target| {
                show_video(
                    layout,
                    window,
                    queue_visible,
                    target,
                    generation,
                    loader.clone(),
                    mode,
                )
            })
            .transpose()
    };
    let mut queue_visible = true;
    let mut generation = 0;
    let mut public_playlist = None;
    let (mut current_player, mut player_error) = if approved {
        match load(
            &layout,
            &window,
            &library,
            None,
            generation,
            queue_visible,
            mode,
        ) {
            Ok(video) => (video, None),
            Err(error) => (None, Some(format!("Could not open the player: {error}"))),
        }
    } else {
        (None, None)
    };
    toggle_queue.set_enabled(current_player.is_some());
    layout.arrange(&window, current_player.as_ref(), &controls, queue_visible)?;
    let mut load_deadline = current_player
        .as_ref()
        .map(|_| Instant::now() + LOAD_TIMEOUT);
    let mut loading_slow = false;
    let mut titled_generation = None;
    let mut controls_ready = false;
    let service_events = event_loop.create_proxy();
    let (mut catalog, mut lookup, mut catalog_key_problem) = if approved && !mode.smoke {
        start_youtube_clients(
            &service_events,
            library.state().current.as_deref(),
            catalog_key_override.as_deref(),
            preferences
                .as_ref()
                .and_then(preferences::Preferences::youtube_key_file),
        )
    } else {
        (None, None, None)
    };
    let mut transport = mode.iframe_player.then(transport::Transport::default);
    let mut auto_advance = advance::Advance::default();
    let make_lyrics_lookup = {
        let events = event_loop.create_proxy();
        move || lyrics_lookup::Lookup::new(events.clone())
    };
    let mut lyrics = if approved && mode.iframe_player && !mode.smoke {
        Some(make_lyrics_lookup())
    } else {
        None
    };
    let results = event_loop.create_proxy();
    let mut account_shutdown_deadline = None;
    #[cfg(target_os = "linux")]
    let mut timer = platform::DeadlineTimer::default();

    event_loop.run(move |event, _, flow| {
        let _keep_alive = (&menu, &queue_lock);
        if let (Some(deadline), Some(panel)) = (account_shutdown_deadline, &mut account) {
            if let Event::UserEvent(PlayerEvent::Account(stamp, outcome)) = event {
                receive_account_outcome(panel, stamp, outcome, &service_events);
            }
            use account::ShutdownStatus;
            *flow = match panel.shutdown_status(deadline, Instant::now()) {
                ShutdownStatus::Waiting => deadline_flow(
                    Some(deadline),
                    #[cfg(target_os = "linux")]
                    &mut timer,
                ),
                ShutdownStatus::Finished => ControlFlow::Exit,
                ShutdownStatus::RevocationFailed => {
                    eprintln!("{}", account_oauth::Error::Revocation.message());
                    ControlFlow::Exit
                }
                ShutdownStatus::TimedOut => {
                    eprintln!(
                        "YouTube account cleanup timed out. Check access in your Google Account permissions."
                    );
                    ControlFlow::Exit
                }
            };
            return;
        }
        let quit_requested = match &event {
            Event::WindowEvent { window_id, event: WindowEvent::CloseRequested, .. } => {
                *window_id == window.id()
            }
            Event::UserEvent(PlayerEvent::Menu(event)) => event.id == *quit.id(),
            _ => false,
        };
        if quit_requested {
            account_shutdown_deadline = account.as_mut().and_then(|panel| panel.begin_shutdown(Instant::now()));
            *flow = if let Some(deadline) = account_shutdown_deadline {
                window.set_visible(false);
                drop(current_player.take());
                deadline_flow(
                    Some(deadline),
                    #[cfg(target_os = "linux")]
                    &mut timer,
                )
            } else {
                ControlFlow::Exit
            };
            return;
        }
        let account_expired = account.as_mut().is_some_and(|account| account.expire(Instant::now()));
        *flow = player_flow(
            load_deadline,
            lookup.as_ref().and_then(metadata_lookup::Lookup::deadline),
            catalog.as_ref().and_then(catalog::Catalog::deadline),
            transport.as_ref(),
            lyrics.as_ref().and_then(lyrics_lookup::Lookup::deadline),
            [auto_advance.deadline(), account.as_ref().and_then(account::Panel::deadline)],
            #[cfg(target_os = "linux")]
            &mut timer,
        );
        let mut reload_player = false;
        let mut error = None;
        let mut acknowledged_sequence = None;
        let mut focus_add_field = false;
        let mut verify_controls = false;
        let mut advance_resolution = None;
        let mut save_options = false;
        let update_queue = match event {
            Event::WindowEvent {
                window_id, event, ..
            } if window_id == window.id() => {
                match event {
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
                if !account_expired {
                    return;
                }
                true
            }
            Event::UserEvent(PlayerEvent::Menu(event)) if event.id == *local_audio.id() => {
                let problem = launch_local_audio();
                if show_legal {
                    legal_problem = problem;
                } else {
                    error = problem.map(str::to_owned);
                }
                true
            }
            Event::UserEvent(PlayerEvent::Menu(event)) if event.id == *open_music.id() => {
                if approved
                    && public_playlist.is_none()
                    && let Some(id) = library.state().current.as_deref()
                    && let Err(reason) =
                        open::that_detached(format!("https://music.youtube.com/watch?v={id}"))
                {
                    error = Some(format!("Could not open YouTube Music: {reason}"));
                }
                true
            }
            Event::UserEvent(PlayerEvent::Menu(event))
                if catalog_key_menu.matches(&event.id) || oauth_client_menu.matches(&event.id) =>
            {
                let Some(preferences) = preferences.as_mut().filter(|_| approved) else {
                    return;
                };
                let (menu, launch_override) = if catalog_key_menu.matches(&event.id) {
                    (&catalog_key_menu, catalog_key_override.is_some())
                } else {
                    (&oauth_client_menu, oauth_client_override.is_some())
                };
                menu.update(&event.id, &window, preferences, launch_override);
                return;
            }
            Event::UserEvent(PlayerEvent::Menu(event)) if event.id == *reload.id() => {
                if !approved {
                    return;
                }
                reload_player = true;
                true
            }
            Event::UserEvent(PlayerEvent::Menu(event))
                if event.id == *toggle_iframe.id() || event.id == *toggle_advance.id() =>
            {
                if !approved {
                    return;
                }
                if preferences.is_none() {
                    return;
                }
                let enabled = toggle_iframe.is_checked();
                let next_automatically = toggle_advance.is_checked();
                if enabled == mode.iframe_player && next_automatically == automatic {
                    return;
                }
                if event.id == *toggle_iframe.id() {
                    preferred_iframe = enabled;
                }
                save_options = true;
                automatic = next_automatically;
                if !automatic && auto_advance.cancel() {
                    reload_player = true;
                }
                if enabled != mode.iframe_player {
                    mode.iframe_player = enabled;
                    toggle_advance.set_enabled(enabled);
                    transport = (enabled && public_playlist.is_none()).then(transport::Transport::default);
                    if enabled {
                        if lyrics.is_none() {
                            lyrics = Some(make_lyrics_lookup());
                        }
                    } else {
                        if let Some(lyrics) = &mut lyrics {
                            lyrics.select(None, None, None);
                        }
                        if let Err(reason) = controls.evaluate_script("window.renderPearTransport?.(null);") {
                            eprintln!("Could not reset the playback controls: {reason}");
                        }
                    }
                    reload_player = public_playlist.is_none();
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
                if !show && current_player.is_none() {
                    return;
                }
                if show != queue_visible {
                    match layout.arrange(&window, current_player.as_ref(), &controls, show) {
                        Ok(()) => {
                            queue_visible = show;
                            toggle_queue.set_text(if show { "Hide Queue" } else { "Show Queue" });
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
            Event::UserEvent(PlayerEvent::Menu(event)) => {
                let Some(rate) = speed_menu.requested(&event.id) else { return };
                if approved
                    && !auto_advance.pending()
                    && let (Some(transport), Some(player)) = (&mut transport, &current_player)
                    && let Err(reason) = transport.perform(player, iframe::Action::SetRate(rate))
                {
                    error = Some(reason.to_string());
                }
                true
            }
            Event::UserEvent(PlayerEvent::TitleChanged(id, title)) if id == generation && public_playlist.is_none() => {
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
            Event::UserEvent(PlayerEvent::LyricsResult(revision, response)) => lyrics
                .as_mut()
                .is_some_and(|lyrics| lyrics.receive(revision, response, Instant::now())),
            Event::UserEvent(PlayerEvent::TransportCommitted(id)) if id == generation => {
                if public_playlist.is_some() {
                    titled_generation = Some(id);
                    load_deadline = None;
                    loading_slow = false;
                    true
                } else {
                    if let Some(transport) = &mut transport {
                        transport.reset(true);
                    }
                    false
                }
            }
            Event::UserEvent(PlayerEvent::TransportSample(id, sequence, response)) if id == generation => {
                let Some(transport) = &mut transport else { return };
                let previous_status = (transport.ready(), transport.is_stale());
                let now = Instant::now();
                if !transport.receive(sequence, &response, now) { return; }
                let confirmed = transport.confirmed_output(now);
                let output = iframe::AudioOutput {
                    volume: confirmed.volume.or(mode.audio_output.volume),
                    muted: confirmed.muted.or(mode.audio_output.muted),
                };
                if output != mode.audio_output {
                    mode.audio_output = output;
                    save_options = true;
                }
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
                let expired = transport.as_mut().is_some_and(|transport| transport.expire(now));
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
                    if mode.smoke && !mode.iframe_player && let Some(player) = &current_player {
                        platform::diagnose_video(player);
                    }
                }
                let overdue = {
                    let lyrics_changed = lyrics.as_mut().is_some_and(|lyrics| lyrics.tick(now));
                    advance_resolution = auto_advance.resolve(library.state(), None, now);
                    overdue || expired || lyrics_changed || advance_resolution.is_some()
                };
                overdue || metadata_changed || catalog_changed
            }
            Event::UserEvent(PlayerEvent::Account(stamp, outcome)) => {
                account.as_mut().is_some_and(|panel| {
                    receive_account_outcome(panel, stamp, outcome, &service_events)
                })
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
                                add_video.set_enabled(true);
                                toggle_iframe.set_enabled(preferences.is_some());
                                toggle_advance.set_enabled(preferences.is_some() && mode.iframe_player);
                                catalog_key_menu.refresh(preferences.as_ref());
                                oauth_client_menu.refresh(preferences.as_ref());
                                let saved_key = preferences.as_ref().and_then(preferences::Preferences::youtube_key_file);
                                (catalog, lookup, catalog_key_problem) = start_youtube_clients(
                                    &service_events,
                                    library.state().current.as_deref(),
                                    catalog_key_override.as_deref(),
                                    saved_key,
                                );
                                account = account::Panel::from_client_file(
                                    oauth_client_override.as_deref(),
                                    preferences.as_ref().and_then(preferences::Preferences::youtube_oauth_client_file),
                                );
                                if mode.iframe_player {
                                    lyrics = Some(make_lyrics_lookup());
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
                    Command::OpenLocalAudio {} => {
                        if !approved && show_legal {
                            legal_problem = launch_local_audio();
                        }
                    }
                    _ if !approved => {}
                    Command::Account(command) => {
                        if !show_legal
                            && let Some(job) = account.as_mut().and_then(|account| account.apply(command))
                        {
                            job.spawn(&service_events);
                        }
                    }
                    Command::OpenBrowser {} => {
                        let url = playback_target(library.state(), public_playlist.as_ref())
                            .map(|target| match target {
                                PlaybackTarget::Queue(id) => format!("https://www.youtube.com/watch?v={id}"),
                                PlaybackTarget::PublicPlaylist(playlist) => playlist.browser_url(),
                            });
                        if let Some(url) = url && let Err(reason) = open::that_detached(url)
                        {
                            error = Some(format!("Could not open the browser: {reason}"));
                        }
                    }
                    Command::PlayPublicPlaylist { source } => {
                        match iframe::PublicPlaylist::from_link(&source) {
                            Ok(playlist) => {
                                public_playlist = Some(playlist);
                                reload_player = true;
                            }
                            Err(reason) => error = Some(reason.to_string()),
                        }
                    }
                    Command::ReturnToQueue {} => {
                        reload_player = public_playlist.take().is_some();
                    }
                    Command::Next {} | Command::Previous {} if public_playlist.is_some() => {}
                    Command::Search { query } => {
                        if let Some(catalog) = &mut catalog {
                            catalog.submit(&query, Instant::now());
                        }
                    }
                    Command::LoadMorePlaylist { revision } => {
                        if let Some(catalog) = &mut catalog {
                            catalog.load_more(revision, Instant::now());
                        }
                    }
                    Command::QueuePublicPlaylist { revision, loaded_count } => {
                        let ids = catalog.as_ref().and_then(|catalog| {
                            catalog.playlist_queue_ids(revision, loaded_count, Instant::now())
                        });
                        if let Some(ids) = ids {
                            match library.enqueue_public_playlist(ids) {
                                Ok(selection_changed) => reload_player = queue_edit_requires_reload(
                                    &mut public_playlist, false, selection_changed,
                                ),
                                Err(reason) => error = Some(reason.to_string()),
                            }
                        } else {
                            error = Some("These playlist results are no longer available to add to Queue.".into());
                        }
                    }
                    Command::OpenMusicSearch { query } => {
                        match music_search_url(&query) {
                            Ok(url) => {
                                if let Err(reason) = open::that_detached(url.as_str()) {
                                    error = Some(format!("Could not open YouTube Music: {reason}"));
                                }
                            }
                            Err(reason) => error = Some(reason.to_string()),
                        }
                    }
                    Command::OpenPlaylistVideo { id } => {
                        if !catalog.as_ref().is_some_and(|catalog|
                            catalog.can_open_playlist_video(&id, Instant::now())
                        ) {
                            error = Some("That playlist video is no longer available here.".into());
                        } else if let Err(reason) =
                            open::that_detached(format!("https://music.youtube.com/watch?v={id}"))
                        {
                            error = Some(format!("Could not open YouTube Music: {reason}"));
                        }
                    }
                    Command::Playlist(command) => {
                        let select = matches!(&command, crate::library::playlists::Command::SelectPlaylistTrack { .. });
                        let cancel_switch = auto_advance.pending()
                            && matches!(&command, crate::library::playlists::Command::SelectPlaylistTrack { video, .. }
                                if library.state().current.as_ref() == Some(video));
                        match playlists.apply(command, &mut library) {
                            Ok(changed) => reload_player = queue_edit_requires_reload(
                                &mut public_playlist, select, changed || cancel_switch,
                            ),
                            Err(reason) => error = Some(reason.to_string()),
                        }
                    }
                    Command::FindLyrics { title, artist } => {
                        if mode.iframe_player && public_playlist.is_none() && let Some(lyrics) = &mut lyrics {
                            lyrics.submit(&title, &artist, Instant::now());
                        }
                    }
                    command @ (Command::SetPlayback { .. }
                        | Command::Seek { .. }
                        | Command::SetVolume { .. }
                        | Command::SetMuted { .. }) => {
                        if auto_advance.pending() {
                            error = Some("Waiting for the next video to start.".into());
                        } else if let (Some(transport), Some(video)) = (&mut transport, &current_player) {
                            let action = match command {
                                Command::SetPlayback { playing: true } => iframe::Action::Play,
                                Command::SetPlayback { playing: false } => iframe::Action::Pause,
                                Command::Seek { position } => iframe::Action::Seek(position),
                                Command::SetVolume { volume } => iframe::Action::SetVolume(volume),
                                Command::SetMuted { muted } => iframe::Action::SetMuted(muted),
                                _ => unreachable!("only transport commands enter this arm"),
                            };
                            if mode.smoke {
                                let name = match &action {
                                    iframe::Action::Play => "play",
                                    iframe::Action::Pause => "pause",
                                    iframe::Action::Seek(_) => "seek",
                                iframe::Action::Advance { .. } => "advance",
                                    iframe::Action::SetVolume(_) => "volume",
                                    iframe::Action::SetMuted(_) => "mute",
                                    iframe::Action::SetRate(_) => "rate",
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
                    command @ (Command::ShuffleUpcoming {} | Command::PlayNext { .. }) => {
                        let available = match &command {
                            Command::PlayNext { id } => library.state().entries.contains(id)
                                || catalog.as_ref().is_some_and(|catalog|
                                    catalog.can_queue_video(id, Instant::now())
                                ),
                            _ => true,
                        };
                        if auto_advance.pending() {
                            error = Some("Waiting for the next video to start.".into());
                        } else if !available {
                            error = Some("That video is no longer available in Queue or Search.".into());
                        } else {
                            match library.apply(command) {
                                Ok(changed) => {
                                    auto_advance.retarget_after_queue_edit(library.state());
                                    reload_player = queue_edit_requires_reload(
                                        &mut public_playlist, false, changed,
                                    );
                                }
                                Err(reason) => error = Some(reason.to_string()),
                            }
                        }
                    }
                    Command::SelectSearchResult { ref id }
                        if !catalog.as_ref().is_some_and(|catalog|
                            catalog.can_queue_video(id, Instant::now())
                        ) =>
                    {
                        error = Some("That video is no longer available in Search.".into());
                    }
                    command => {
                        let selected = match &command {
                            Command::Select { id } | Command::SelectSearchResult { id } => Some(id),
                            _ => None,
                        };
                        let select = selected.is_some();
                        let cancel_switch = auto_advance.pending() && selected.is_some()
                            && selected == library.state().current.as_ref();
                        match library.apply(command) {
                            Ok(changed) => reload_player = queue_edit_requires_reload(
                                &mut public_playlist, select, changed || cancel_switch,
                            ),
                            Err(reason) => error = Some(reason.to_string()),
                        }
                    }
                }
                true
            }
            _ if account_expired => true,
            _ => return,
        };

        if save_options && let Some(preferences) = &mut preferences {
            if let Err(reason) = preferences.set_playback(preferred_iframe, automatic, mode.audio_output) {
                eprintln!("Could not save playback preferences: {reason}");
                preferences_problem = Some("Playback preferences changed for this session. They could not be saved.");
                toggle_iframe.set_text(format!("{IFRAME_MENU_LABEL} (This Session)"));
                toggle_advance.set_text(format!("{AUTO_ADVANCE_LABEL} (This Session)"));
            } else {
                preferences_problem = None;
                toggle_iframe.set_text(IFRAME_MENU_LABEL);
                toggle_advance.set_text(AUTO_ADVANCE_LABEL);
            }
        }

        let update_queue = {
            let update_queue = update_queue || save_options;
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

        let update_queue = update_queue || account_expired;
        if reload_player {
            generation += 1;
            load_deadline = None;
            loading_slow = false;
            {
                auto_advance.cancel();
                if public_playlist.is_some() {
                    transport = None;
                } else if let Some(transport) = &mut transport {
                    transport.reset(false);
                } else if mode.iframe_player {
                    transport = Some(transport::Transport::default());
                }
            }
            if let Some(lookup) = &mut lookup {
                lookup.select(queue_video(library.state(), public_playlist.as_ref()));
            }
            // Remove the old WebView before creating the next one so its audio stops
            // even if the new WebView fails to initialize.
            drop(current_player.take());
            match load(&layout, &window, &library, public_playlist.as_ref(), generation, queue_visible, mode) {
                Ok(video) => {
                    current_player = video;
                    player_error = None;
                    load_deadline = current_player.as_ref().map(|_| Instant::now() + LOAD_TIMEOUT);
                }
                Err(reason) => player_error = Some(format!("Could not open the player: {reason}")),
            }
            if current_player.is_none() && !queue_visible {
                queue_visible = true;
                toggle_queue.set_text("Hide Queue");
                if let Err(reason) = controls.evaluate_script("window.setPearPanelVisible?.(true);") {
                    eprintln!("Could not restore the queue controls: {reason}");
                }
            }
            toggle_queue.set_enabled(current_player.is_some());
            if let Err(reason) = layout.arrange(&window, current_player.as_ref(), &controls, queue_visible) {
                eprintln!("Could not arrange the player: {reason}");
            }
        }

        let switching = auto_advance.pending();
        let update_queue = {
            let duration_changed = mode.iframe_player && lyrics.as_mut().is_some_and(|lyrics| {
                if update_queue || reload_player {
                    let queue = library.state();
                    let current = queue_video(queue, public_playlist.as_ref());
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
            transport.as_ref(),
            lyrics.as_ref().and_then(lyrics_lookup::Lookup::deadline),
            [auto_advance.deadline(), account.as_ref().and_then(account::Panel::deadline)],
            #[cfg(target_os = "linux")]
            &mut timer,
        );
        if controls_ready && update_queue {
            open_music.set_enabled(approved && queue_video(library.state(), public_playlist.as_ref()).is_some());
            let player_ready = titled_generation == Some(generation);
            let player_ready = player_ready || transport.as_ref().is_some_and(transport::Transport::ready);
            let loading_slow = loading_slow || transport.as_ref().is_some_and(transport::Transport::is_stale);
            let notice = if switching {
                Some("Opening the next video…")
            } else if public_playlist.is_some()
                || library.state().current.is_none()
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
                    public_playlist: public_playlist.is_some(),
                    metadata: lookup.as_ref().and_then(metadata_lookup::Lookup::metadata),
                    metadata_problem: lookup.as_ref().and_then(metadata_lookup::Lookup::problem),
                    browser_search: approved && !mode.smoke && catalog.is_none(),
                    catalog: catalog.as_ref().map(catalog::Catalog::view),
                    catalog_key_problem,
                    saved_playlists: playlists.view(),
                    account: account.as_ref().map(account::Panel::view),
                    legal: LegalView {
                        accepted: approved,
                        show: show_legal,
                        revision: consent::REVISION,
                        problem: legal_problem,
                    },
                    preferences_problem,
                    lyrics: if public_playlist.is_some() { None } else { lyrics.as_ref().and_then(lyrics_lookup::Lookup::view) },
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
        {
            let sample = if approved && !switching {
                transport.as_ref().and_then(transport::Transport::snapshot)
            } else {
                None
            };
            if let Err(reason) = speed_menu.update(sample) {
                eprintln!("Could not update the playback speed menu: {reason}");
            }
        }
        if approved && controls_ready && queue_visible && let Some(transport) = &mut transport
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
    fn public_playlist_temporarily_replaces_playback_without_selecting_a_queue_video() {
        let mut queue = QueueState::default();
        let initial = "M7lc1UVf-VE";
        queue.entries.push(initial.into());
        queue.current = Some(initial.into());
        let before = serde_json::to_value(&queue).unwrap();
        let playlist = iframe::PublicPlaylist::from_link(
            "https://www.youtube.com/playlist?list=PLC77007E23FF423C6",
        )
        .unwrap();

        assert_eq!(
            playback_target(&queue, None),
            Some(PlaybackTarget::Queue(initial))
        );
        assert_eq!(queue_video(&queue, None), Some(initial));
        assert_eq!(
            playback_target(&queue, Some(&playlist)),
            Some(PlaybackTarget::PublicPlaylist(&playlist)),
        );
        assert_eq!(queue_video(&queue, Some(&playlist)), None);
        assert_eq!(serde_json::to_value(&queue).unwrap(), before);
        let mut session = Some(playlist);
        assert!(!queue_edit_requires_reload(&mut session, false, true));
        assert!(session.is_some());
        assert!(queue_edit_requires_reload(&mut session, true, false));
        assert!(session.is_none());
        assert_eq!(
            playback_target(&queue, session.as_ref()),
            Some(PlaybackTarget::Queue(initial))
        );
    }

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
        assert!(matches!(
            command(r#"{"type":"queue_public_playlist","revision":7,"loaded_count":30}"#),
            Some(ControlMessage {
                command: Command::QueuePublicPlaylist {
                    revision: 7,
                    loaded_count: 30
                },
                ..
            })
        ));
        for invalid in [
            r#"{"type":"save_playlist","name":"Evening","id":1}"#,
            r#"{"type":"close_playlist","also_remove":true}"#,
            r#"{"type":"select_playlist_track","id":1}"#,
            r#"{"type":"append_playlist","id":-1}"#,
            r#"{"type":"queue_public_playlist","revision":7}"#,
            r#"{"type":"queue_public_playlist","revision":7,"loaded_count":-1}"#,
            r#"{"type":"queue_public_playlist","revision":7,"loaded_count":30,"source":"https://example.com/"}"#,
        ] {
            assert!(command(invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn accepts_only_the_search_result_id_from_local_controls() {
        let command = |origin, payload: &str| {
            let request = Request::builder()
                .uri(origin)
                .body(format!(r#"{{"sequence":1,"command":{payload}}}"#))
                .unwrap();
            controls_command(&request)
        };
        let selection = r#"{"type":"select_search_result","id":"M7lc1UVf-VE"}"#;
        assert!(command(CONTROLS_URL, selection).is_some());
        assert!(command("https://www.youtube.com/embed/M7lc1UVf-VE", selection).is_none());
        for invalid in [
            r#"{"type":"select_search_result","id":1}"#,
            r#"{"type":"select_search_result","id":"M7lc1UVf-VE","title":"Injected"}"#,
            r#"{"type":"select_search_result","url":"https://youtu.be/M7lc1UVf-VE"}"#,
        ] {
            assert!(command(CONTROLS_URL, invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn account_ipc_accepts_only_scoped_actions_and_bounded_row_selectors() {
        let command = |payload: &str| {
            let request = Request::builder()
                .uri(CONTROLS_URL)
                .body(format!(r#"{{"sequence":1,"command":{payload}}}"#))
                .unwrap();
            controls_command(&request)
        };
        assert!(matches!(
            command(r#"{"type":"open_account_video","page":3,"row":1}"#),
            Some(ControlMessage {
                command: Command::Account(account::Command::OpenAccountVideo { page: 3, row: 1 }),
                ..
            })
        ));
        for invalid in [
            r#"{"type":"connect_account","scope":"youtube.force-ssl"}"#,
            r#"{"type":"open_account_video","url":"https://www.youtube.com"}"#,
            r#"{"type":"open_account_video","page":3,"row":-1}"#,
            r#"{"type":"next_account_page","page":3,"token":"opaque"}"#,
            r#"{"type":"show_account_collection","collection":"subscriptions"}"#,
        ] {
            assert!(command(invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn opens_local_audio_with_a_payload_free_command_from_local_controls_only() {
        let request = |origin, payload| {
            Request::builder()
                .uri(origin)
                .body(format!(r#"{{"sequence":1,"command":{payload}}}"#))
                .unwrap()
        };
        let payload = r#"{"type":"open_local_audio"}"#;
        assert!(matches!(
            controls_command(&request(CONTROLS_URL, payload)),
            Some(ControlMessage {
                sequence,
                command: Command::OpenLocalAudio {},
            }) if sequence.get() == 1
        ));
        assert!(controls_command(&request("https://www.youtube.com/", payload)).is_none());
        let with_path = r#"{"type":"open_local_audio","path":"track.wav"}"#;
        assert!(controls_command(&request(CONTROLS_URL, with_path)).is_none());
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
    fn music_search_opens_a_fixed_origin_with_one_encoded_query() {
        let url = music_search_url("  Björk & Jónsi? # live  ").unwrap();
        assert_eq!(
            url.origin().ascii_serialization(),
            "https://music.youtube.com"
        );
        assert_eq!(url.path(), "/search");
        assert!(url.fragment().is_none());
        assert_eq!(
            url.query_pairs().collect::<Vec<_>>(),
            [(Cow::Borrowed("q"), Cow::Borrowed("Björk & Jónsi? # live"))],
        );
        assert!(music_search_url(" ").is_err());
        assert!(music_search_url("search\nextra").is_err());
        assert!(music_search_url(&"界".repeat(161)).is_err());
        let playlist =
            music_search_url("music.youtube.com/playlist?si=sharing&list=PL_1234567890").unwrap();
        assert_eq!(
            playlist.as_str(),
            "https://music.youtube.com/playlist?list=PL_1234567890"
        );
        assert!(music_search_url("https://example.com/?token=private").is_err());
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
        let swipe_script =
            controls_response(request("pear-queue://app.local/history-swipes.js", "GET"));
        assert_eq!(swipe_script.status(), 200);
        assert_eq!(
            swipe_script.headers()[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
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
