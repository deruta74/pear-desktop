mod engine;
mod equalizer;
mod metadata;
mod presets;
mod queue;
mod settings;

use std::{
    borrow::Cow,
    path::{Path, PathBuf},
    process::{Command as Process, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

use muda::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use serde::{Deserialize, Serialize};
use tao::{
    dpi::LogicalSize,
    event::{Event, StartCause, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::{Window, WindowBuilder},
};
use wry::{
    DragDropEvent, WebViewBuilder,
    http::{Request, Response, header},
};

use crate::{Result, attach_menu, build_webview, media, player::isolated_builder};

use metadata::Metadata;
use settings::Settings;

const SCHEME: &str = "pear-audio";
const ASSET_ROOT: &str = "pear-audio://app.local/";
#[cfg(not(target_os = "windows"))]
const DOCUMENT: &str = ASSET_ROOT;
#[cfg(target_os = "windows")]
const DOCUMENT: &str = "https://pear-audio.app.local/";
#[cfg(not(target_os = "windows"))]
const ASSET_SOURCE: &str = "pear-audio:";
#[cfg(target_os = "windows")]
const ASSET_SOURCE: &str = "https://pear-audio.app.local";
const UPDATE_INTERVAL: Duration = Duration::from_millis(250);
const IDLE_UPDATE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum AudioCommand {
    Ready {},
    Open {},
    SelectTrack {
        revision: u32,
        index: usize,
    },
    ShuffleUpcoming {
        revision: u32,
    },
    ClearUpcoming {
        revision: u32,
        selected: usize,
    },
    SetRepeat {
        revision: u32,
        mode: queue::RepeatMode,
    },
    SetPlaying {
        playing: bool,
    },
    Seek {
        position_ms: u64,
    },
    SetVolume {
        volume: f64,
    },
    SetSpeed {
        speed: f64,
    },
    SetReverb {
        intensity: f32,
        high_pass_hz: f32,
        low_pass_hz: f32,
    },
    ResetEffects {},
    SetEqualizer {
        profile: equalizer::Profile,
        revision: u32,
    },
    SaveEqualizerPreset {
        name: String,
    },
    LoadEqualizerPreset {
        name: String,
        revision: u32,
    },
    DeleteEqualizerPreset {
        name: String,
    },
}

enum AudioEvent {
    Command(AudioCommand),
    Media(media::Request),
    DropFiles(Vec<PathBuf>),
    Menu(MenuEvent),
    Prepared(std::result::Result<(Arc<Metadata>, engine::PreparedAudio), engine::EngineOpenError>),
    Opened(std::result::Result<(Arc<Metadata>, engine::Engine), engine::EngineOpenError>),
}

struct Track {
    metadata: Arc<Metadata>,
    engine: engine::Engine,
    generation: u64,
    stopped: bool,
}

#[derive(Serialize)]
struct View<'a> {
    track: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    artist: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    album: Option<&'a str>,
    transport: Option<engine::Snapshot>,
    error: Option<&'a str>,
    #[serde(rename = "settingsError", skip_serializing_if = "Option::is_none")]
    settings_error: Option<&'a str>,
    opening: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    queue: Option<queue::View<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    settings: Option<Settings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equalizer: Option<&'a equalizer::Profile>,
    #[serde(rename = "eqRevision", skip_serializing_if = "Option::is_none")]
    eq_revision: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    presets: Option<Vec<&'a str>>,
}

fn command(request: &Request<String>) -> Option<AudioCommand> {
    if request.uri() != DOCUMENT || request.body().len() > 8 * 1024 {
        return None;
    }
    serde_json::from_str(request.body()).ok()
}

fn apply_settings_command(
    command: &AudioCommand,
    preferences: &mut settings::Preferences,
    engine: Option<&mut engine::Engine>,
    now: Instant,
) -> bool {
    let previous = preferences.current();
    match *command {
        AudioCommand::SetVolume { volume } => {
            preferences.update(Settings { volume, ..previous }, now);
        }
        AudioCommand::SetSpeed { speed } => {
            preferences.update(Settings { speed, ..previous }, now);
        }
        AudioCommand::SetReverb {
            intensity,
            high_pass_hz,
            low_pass_hz,
        } => {
            preferences.update(
                Settings {
                    intensity,
                    high_pass_hz,
                    low_pass_hz,
                    ..previous
                },
                now,
            );
        }
        AudioCommand::ResetEffects {} => preferences.reset_effects(now),
        _ => return false,
    }
    if let Some(engine) = engine {
        let latest = preferences.current();
        if latest.volume != previous.volume {
            engine.set_volume(latest.volume);
        }
        if latest.speed != previous.speed {
            engine.set_speed(latest.speed);
        }
        if latest.reverb() != previous.reverb() {
            engine.set_reverb(latest.reverb());
        }
    }
    true
}

fn assets(request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let asset: Option<(&str, &[u8])> = if request.method() == "GET" {
        match request.uri().to_string().as_str() {
            ASSET_ROOT => Some((
                "text/html; charset=utf-8",
                include_bytes!("../ui/local-audio.html"),
            )),
            "pear-audio://app.local/style.css" => {
                Some(("text/css; charset=utf-8", include_bytes!("../ui/style.css")))
            }
            "pear-audio://app.local/local-audio.css" => Some((
                "text/css; charset=utf-8",
                include_bytes!("../ui/local-audio.css"),
            )),
            "pear-audio://app.local/local-audio.js" => Some((
                "text/javascript; charset=utf-8",
                include_bytes!("../ui/local-audio.js"),
            )),
            "pear-audio://app.local/local-eq.js" => Some((
                "text/javascript; charset=utf-8",
                include_bytes!("../ui/local-eq.js"),
            )),
            _ => None,
        }
    } else {
        None
    };
    let Some((content_type, bytes)) = asset else {
        return Response::builder()
            .status(404)
            .body(Cow::Borrowed(&[][..]))
            .expect("valid static response");
    };
    Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CONTENT_SECURITY_POLICY, format!(
            "default-src 'none'; script-src {ASSET_SOURCE}; style-src {ASSET_SOURCE}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        ))
        .body(Cow::Borrowed(bytes))
        .expect("valid bundled audio asset")
}

fn pick_files(window: &Window) -> Vec<PathBuf> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        rfd::FileDialog::new()
            .set_parent(window)
            .set_title("Open audio files")
            .add_filter(
                "Audio files",
                &["wav", "wave", "flac", "mp3", "opus", "ogg", "m4a"],
            )
            .pick_files()
            .unwrap_or_default()
    }
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::{FileChooserExt, NativeDialogExt};
        use tao::platform::unix::WindowExtUnix;

        let dialog = gtk::FileChooserNative::new(
            Some("Open audio files"),
            Some(window.gtk_window()),
            gtk::FileChooserAction::Open,
            Some("Open"),
            Some("Cancel"),
        );
        dialog.set_select_multiple(true);
        let filter = gtk::FileFilter::new();
        filter.set_name(Some("Audio files"));
        for pattern in [
            "*.[wW][aA][vV]",
            "*.[wW][aA][vV][eE]",
            "*.[fF][lL][aA][cC]",
            "*.[mM][pP]3",
            "*.[oO][pP][uU][sS]",
            "*.[oO][gG][gG]",
            "*.[mM]4[aA]",
        ] {
            filter.add_pattern(pattern);
        }
        dialog.add_filter(filter);
        let accepted = dialog.run() == gtk::ResponseType::Accept;
        if accepted {
            dialog.filenames()
        } else {
            Vec::new()
        }
    }
}

pub(crate) fn launch() -> std::io::Result<()> {
    Process::new(std::env::current_exe()?)
        .arg("--local-audio")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|mut child| {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        })
}

fn profile_directory() -> Result<PathBuf> {
    match std::env::var_os("PEAR_LOCAL_AUDIO_DIR") {
        Some(path) if Path::new(&path).is_absolute() => Ok(path.into()),
        Some(_) => Err("PEAR_LOCAL_AUDIO_DIR must be an absolute path.".into()),
        None => Ok(crate::player::data_root()?.join("com.pear-desktop.rust-preview-local-audio")),
    }
}

pub(crate) fn run(initial_files: Vec<PathBuf>) -> Result<()> {
    let directory = profile_directory()?;
    let store = presets::Store::new(directory.clone());
    let mut preferences = settings::Preferences::load(directory);
    let (mut presets, mut error) = match store.read() {
        Ok(presets) => (presets, None),
        Err(reason) => (Vec::new(), Some(reason.to_owned())),
    };
    let event_loop = EventLoopBuilder::<AudioEvent>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title("Pear Local Audio")
        .with_inner_size(LogicalSize::new(560, 580))
        .with_min_inner_size(LogicalSize::new(420, 475))
        .build(&event_loop)?;

    use muda::accelerator::{Accelerator, CMD_OR_CTRL, Code};
    let key = |key| (!cfg!(target_os = "windows")).then(|| Accelerator::new(CMD_OR_CTRL, key));
    let open = MenuItem::new("Open Audio Files…", true, key(Code::KeyO));
    let quit = MenuItem::new("Quit Pear Local Audio", true, key(Code::KeyQ));
    let menu = Menu::with_items(&[
        &Submenu::with_items("Pear Local Audio", true, &[&quit])?,
        &Submenu::with_items("File", true, &[&open])?,
        &Submenu::with_items(
            "Edit",
            true,
            &[
                &PredefinedMenuItem::cut(None),
                &PredefinedMenuItem::copy(None),
                &PredefinedMenuItem::paste(None),
                &PredefinedMenuItem::select_all(None),
            ],
        )?,
    ])?;
    attach_menu(&window, &menu)?;
    let menu_events = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(Arc::new(move |event| {
        let _ = menu_events.send_event(AudioEvent::Menu(event));
    })));
    let events = event_loop.create_proxy();
    let result_events = events.clone();
    let drop_events = events.clone();
    let builder = isolated_builder(WebViewBuilder::new())
        .with_custom_protocol(SCHEME.into(), |_, request| assets(request))
        .with_navigation_handler(|url| url == DOCUMENT)
        .with_drag_drop_handler(move |event| {
            if let DragDropEvent::Drop { paths, .. } = event
                && !paths.is_empty()
            {
                let _ = drop_events.send_event(AudioEvent::DropFiles(paths));
            }
            // Keep dropped files out of WebView navigation and script access.
            true
        })
        .with_ipc_handler(move |request| {
            if let Some(command) = command(&request) {
                let _ = events.send_event(AudioEvent::Command(command));
            }
        });
    #[cfg(target_os = "windows")]
    let builder = {
        use wry::WebViewBuilderExtWindows;
        builder
            .with_https_scheme(true)
            .with_browser_accelerator_keys(false)
            .with_default_context_menus(false)
    };
    let view = build_webview(&window, builder)?;
    #[cfg(target_os = "windows")]
    crate::verify_private_session(&view)?;
    view.load_url(DOCUMENT)?;
    if !initial_files.is_empty() {
        let _ = result_events.send_event(AudioEvent::DropFiles(initial_files));
    }
    let media_events = event_loop.create_proxy();
    let dispatch_media = move |request| {
        let _ = media_events.send_event(AudioEvent::Media(request));
    };
    #[cfg(target_os = "windows")]
    let mut media = media::Backend::new(&window, dispatch_media);
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut media = media::Backend::new(dispatch_media);
    #[cfg(target_os = "macos")]
    let mut media: Option<media::Backend> = None;
    let mut track: Option<Track> = None;
    let mut track_generation = 0_u64;
    let mut equalizer = equalizer::Profile::default();
    let mut queue = queue::Queue::default();
    let mut deadline = None;
    #[cfg(target_os = "linux")]
    let mut timer = crate::player::DeadlineTimer::default();

    event_loop.run(move |event, _, flow| {
        let _keep_menu_alive = &menu;
        let quit_requested = match &event {
            Event::WindowEvent {
                window_id,
                event: WindowEvent::CloseRequested,
                ..
            } => *window_id == window.id(),
            Event::UserEvent(AudioEvent::Menu(event)) => event.id == *quit.id(),
            _ => false,
        };
        let was_opening = queue.opening();
        let mut dropped_files = None;
        let mut requested_path = None;
        let action = match event {
            _ if quit_requested => None,
            Event::UserEvent(AudioEvent::Menu(event)) if event.id == *open.id() => {
                Some(AudioCommand::Open {})
            }
            Event::UserEvent(AudioEvent::Command(command)) => Some(command),
            Event::UserEvent(AudioEvent::Media(request)) => {
                let Some(current) = track
                    .as_mut()
                    .filter(|track| track.generation == request.generation && !queue.opening())
                else {
                    return;
                };
                use media::Command::*;
                match request.command {
                    Play => {
                        current.stopped = false;
                        current.engine.set_playing(true);
                    }
                    Pause => current.engine.set_playing(false),
                    Toggle => {
                        current.stopped = false;
                        current.engine.set_playing(!current.engine.is_playing());
                    }
                    Stop => {
                        current.stopped = true;
                        current.engine.set_playing(false);
                        current.engine.seek_ms(0);
                    }
                    Previous | Next => {
                        requested_path =
                            queue.step(request.command == Next, current.engine.is_playing());
                    }
                }
                Some(AudioCommand::Ready {})
            }
            Event::UserEvent(AudioEvent::DropFiles(paths)) if !queue.opening() => {
                dropped_files = Some(paths);
                Some(AudioCommand::Open {})
            }
            Event::UserEvent(AudioEvent::Prepared(Ok((metadata, audio)))) => {
                // A direct ALSA endpoint can permit only one active stream.
                // Keep the old track while validating the file and release it
                // before asking the current default output for a new stream.
                track.take();
                let result_events = result_events.clone();
                if std::thread::Builder::new()
                    .name("pear-audio-output".into())
                    .spawn(move || {
                        let result =
                            engine::Engine::open_prepared(audio).map(|engine| (metadata, engine));
                        let _ = result_events.send_event(AudioEvent::Opened(result));
                    })
                    .is_err()
                {
                    queue.output_failed();
                    error = Some("Could not start the default audio output.".into());
                }
                Some(AudioCommand::Ready {})
            }
            Event::UserEvent(AudioEvent::Prepared(Err(problem))) => {
                requested_path = queue.retry_after_read_error();
                if requested_path.is_none() {
                    error = Some(problem.to_string());
                }
                Some(AudioCommand::Ready {})
            }
            Event::UserEvent(AudioEvent::Opened(result)) => {
                match result {
                    Ok((metadata, mut engine)) => {
                        #[cfg(target_os = "macos")]
                        if media.is_none() {
                            // Let the first AppKit file picker finish before registering MediaPlayer.
                            media = media::Backend::new(dispatch_media.clone());
                        }
                        let (play, skipped) = queue.finish();
                        let settings = preferences.current();
                        engine.set_volume(settings.volume);
                        engine.set_speed(settings.speed);
                        engine.set_reverb(settings.reverb());
                        error = equalizer.apply(&mut engine).err().map(str::to_owned);
                        if error.is_some() {
                            equalizer.disable();
                        } else if skipped > 0 {
                            error = Some(if skipped == 1 {
                                "Skipped one unreadable audio file.".into()
                            } else {
                                format!("Skipped {skipped} unreadable audio files.")
                            });
                        }
                        engine.set_playing(play);
                        track_generation += 1;
                        track = Some(Track {
                            metadata,
                            engine,
                            generation: track_generation,
                            stopped: false,
                        });
                    }
                    Err(problem) => {
                        queue.output_failed();
                        error = Some(problem.to_string());
                    }
                }
                Some(AudioCommand::Ready {})
            }
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => None,
            Event::LoopDestroyed => {
                media.take();
                if let Err(problem) = preferences.flush_on_termination() {
                    eprintln!("{problem}");
                }
                return;
            }
            _ => return,
        };
        let ready = matches!(action, Some(AudioCommand::Ready {}));
        let send_settings = ready || matches!(action, Some(AudioCommand::ResetEffects {}));
        let send_queue = ready
            || matches!(
                action,
                Some(
                    AudioCommand::ShuffleUpcoming { .. }
                        | AudioCommand::ClearUpcoming { .. }
                        | AudioCommand::SetRepeat { .. }
                )
            );
        let eq_revision = match &action {
            Some(
                AudioCommand::SetEqualizer { revision, .. }
                | AudioCommand::LoadEqualizerPreset { revision, .. },
            ) => Some(*revision),
            _ => None,
        };
        let send_presets = ready
            || matches!(
                action,
                Some(
                    AudioCommand::SaveEqualizerPreset { .. }
                        | AudioCommand::DeleteEqualizerPreset { .. }
                        | AudioCommand::LoadEqualizerPreset { .. }
                )
            );
        match action {
            Some(AudioCommand::Open {}) => {
                if !queue.opening() {
                    let paths = dropped_files.unwrap_or_else(|| pick_files(&window));
                    match queue.replace(paths) {
                        Ok(path) => requested_path = path,
                        Err(problem) => error = Some(problem.into()),
                    }
                }
            }
            Some(AudioCommand::SelectTrack { revision, index }) => {
                let play = track
                    .as_ref()
                    .is_some_and(|track| track.engine.is_playing());
                requested_path = queue.select(revision, index, play);
            }
            Some(AudioCommand::ShuffleUpcoming { revision }) => {
                queue.shuffle_upcoming(revision);
            }
            Some(AudioCommand::ClearUpcoming { revision, selected }) => {
                queue.clear_upcoming(revision, selected);
            }
            Some(AudioCommand::SetRepeat { revision, mode }) => {
                queue.set_repeat(revision, mode);
            }
            Some(action) => {
                if !apply_settings_command(
                    &action,
                    &mut preferences,
                    track.as_mut().map(|track| &mut track.engine),
                    Instant::now(),
                ) && let Some(Track {
                    engine, stopped, ..
                }) = &mut track
                {
                    match action {
                        AudioCommand::SetPlaying { playing } if !queue.opening() => {
                            if playing {
                                *stopped = false;
                            }
                            engine.set_playing(playing);
                        }
                        AudioCommand::Seek { position_ms } if !queue.opening() => {
                            *stopped = false;
                            engine.seek_ms(position_ms);
                        }
                        AudioCommand::SetEqualizer { profile, .. } => match profile.normalize() {
                            Some(profile) => match profile.apply(engine) {
                                Ok(()) => {
                                    equalizer = profile;
                                    error = None;
                                }
                                Err(problem) => error = Some(problem.into()),
                            },
                            None => error = Some("Check the equalizer band values.".into()),
                        },
                        AudioCommand::SaveEqualizerPreset { name } => {
                            match store.save(&name, &equalizer) {
                                Ok(saved) => {
                                    presets = saved;
                                    error = None;
                                }
                                Err(reason) => error = Some(reason.into()),
                            }
                        }
                        AudioCommand::LoadEqualizerPreset { name, .. } => {
                            error = store
                                .read()
                                .and_then(|current| {
                                    presets = current;
                                    let preset = presets
                                        .iter()
                                        .find(|preset| preset.name == name)
                                        .ok_or("That equalizer preset no longer exists.")?;
                                    preset.profile.apply(engine)?;
                                    equalizer = preset.profile.clone();
                                    Ok(())
                                })
                                .err()
                                .map(str::to_owned);
                        }
                        AudioCommand::DeleteEqualizerPreset { name } => match store.remove(&name) {
                            Ok(saved) => {
                                presets = saved;
                                error = None;
                            }
                            Err(reason) => error = Some(reason.into()),
                        },
                        _ => {}
                    }
                }
            }
            None if !quit_requested && !deadline.is_some_and(|when| Instant::now() >= when) => {
                return;
            }
            None => {}
        }
        let now = Instant::now();
        let quit = if quit_requested {
            preferences.request_quit(now)
        } else {
            preferences.save_if_due(now)
        };
        if let settings::Quit::Exit(problem) = quit {
            media.take();
            track.take();
            if let Some(problem) = problem {
                eprintln!("{problem}");
            }
            *flow = ControlFlow::Exit;
            return;
        }
        let settings = preferences.current();
        let transport = track.as_mut().map(|track| {
            let snapshot = track.engine.snapshot(queue.opening());
            if !snapshot.finished || requested_path.is_some() {
                return snapshot;
            }
            let end = if snapshot.error.is_some() {
                queue::End::DecodeError
            } else {
                queue::End::Natural
            };
            match queue.advance(end) {
                Some(queue::Advance::Open(path)) => requested_path = Some(path),
                Some(queue::Advance::Replay) => {
                    track.engine.set_playing(true);
                    // Poll for the next end on the next event, even for very short files.
                    return track.engine.snapshot(true);
                }
                None => {}
            }
            snapshot
        });
        if let Some(path) = requested_path {
            let result_events = result_events.clone();
            match std::thread::Builder::new()
                .name("pear-audio-open".into())
                .spawn(move || {
                    let result = engine::PreparedAudio::read(&path).map(|audio| {
                        let metadata = audio.metadata().clone().with_filename(&path);
                        (Arc::new(metadata), audio)
                    });
                    let _ = result_events.send_event(AudioEvent::Prepared(result));
                }) {
                Ok(_) => error = None,
                Err(_) => {
                    queue.cancel();
                    error = Some("Could not open the selected audio file.".into());
                }
            }
        }
        let opening = queue.opening();
        if opening != was_opening {
            open.set_enabled(!opening);
        }
        if let Some(media) = &mut media {
            media.update(
                track
                    .as_ref()
                    .zip(transport.as_ref())
                    .map(|(track, snapshot)| {
                        let (previous, next) = queue.neighbors();
                        let status = if snapshot.playing {
                            media::Status::Playing
                        } else if track.stopped
                            || snapshot.error.is_some()
                            || snapshot.position_ms >= snapshot.duration_ms
                        {
                            media::Status::Stopped
                        } else {
                            media::Status::Paused
                        };
                        media::State {
                            generation: track.generation,
                            metadata: Arc::clone(&track.metadata),
                            duration_ms: snapshot.duration_ms,
                            position_ms: snapshot.position_ms,
                            position_revision: snapshot.position_revision,
                            speed: settings.speed,
                            volume: settings.volume,
                            status,
                            can_previous: previous.is_some(),
                            can_next: next.is_some(),
                            can_control: !opening && snapshot.error.is_none(),
                        }
                    }),
            );
        }
        deadline = transport
            .as_ref()
            .filter(|snapshot| snapshot.error.is_none())
            .map(|snapshot| {
                now + if snapshot.playing {
                    UPDATE_INTERVAL
                } else {
                    IDLE_UPDATE_INTERVAL
                }
            })
            .into_iter()
            .chain(preferences.deadline())
            .min();
        #[cfg(target_os = "linux")]
        {
            deadline = timer.schedule(deadline);
        }
        *flow = deadline.map_or(ControlFlow::Wait, ControlFlow::WaitUntil);
        let metadata = track.as_ref().map(|track| &track.metadata);
        let state = View {
            track: metadata.map(|metadata| metadata.title.as_str()),
            artist: metadata.and_then(|metadata| metadata.artist.as_deref()),
            album: metadata.and_then(|metadata| metadata.album.as_deref()),
            transport,
            error: error.as_deref(),
            settings_error: preferences.problem(),
            opening,
            queue: send_queue.then(|| queue.view()),
            settings: send_settings.then_some(settings),
            equalizer: (ready || eq_revision.is_some()).then_some(&equalizer),
            eq_revision,
            presets: send_presets
                .then(|| presets.iter().map(|preset| preset.name.as_str()).collect()),
        };
        if let Ok(state) = serde_json::to_string(&state)
            && let Err(problem) =
                view.evaluate_script(&format!("window.renderPearLocal?.({state});"))
        {
            eprintln!("Could not update local playback controls: {problem}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_queue_keeps_the_old_selection_until_a_batch_opens() {
        let mut queue = queue::Queue::default();
        assert_eq!(
            queue.replace(vec!["old.wav".into()]).unwrap().unwrap(),
            Path::new("old.wav")
        );
        assert_eq!(queue.finish(), (false, 0));
        let old_revision = queue.view().revision;

        assert_eq!(
            queue
                .replace(vec!["bad.mp3".into(), "new.flac".into()])
                .unwrap()
                .unwrap(),
            Path::new("bad.mp3")
        );
        assert_eq!(queue.view().tracks, ["old.wav"]);
        assert_eq!(
            queue.retry_after_read_error().unwrap(),
            Path::new("new.flac")
        );
        assert_eq!(queue.finish(), (false, 1));
        assert_eq!(queue.view().tracks, ["bad.mp3", "new.flac"]);
        assert_eq!(queue.view().selected, Some(1));
        assert!(queue.select(old_revision, 0, true).is_none());
    }

    #[test]
    fn local_queue_advances_and_skips_only_during_automatic_playback() {
        let mut queue = queue::Queue::default();
        queue
            .replace(vec![
                "one.wav".into(),
                "bad.mp3".into(),
                "three.flac".into(),
            ])
            .unwrap();
        queue.finish();
        let revision = queue.view().revision;
        assert_eq!(
            queue.select(revision, 1, false).unwrap(),
            Path::new("bad.mp3")
        );
        assert!(queue.retry_after_read_error().is_none());
        assert!(!queue.opening());
        assert_eq!(queue.view().selected, Some(0));

        assert_eq!(
            queue.advance(queue::End::Natural),
            Some(queue::Advance::Open("bad.mp3".into()))
        );
        assert!(queue.select(revision, 2, true).is_none());
        assert_eq!(
            queue.retry_after_read_error().unwrap(),
            Path::new("three.flac")
        );
        assert_eq!(queue.finish(), (true, 1));
        assert_eq!(queue.view().selected, Some(2));
        assert!(queue.advance(queue::End::Natural).is_none());
    }

    #[test]
    fn rejects_unbundled_navigation_and_ipc_payloads() {
        let request = |uri, method| {
            Request::builder()
                .uri(uri)
                .method(method)
                .body(Vec::new())
                .unwrap()
        };
        assert_eq!(assets(request(ASSET_ROOT, "GET")).status(), 200);
        assert_eq!(
            assets(request("pear-audio://app.local/local-audio.js", "GET")).status(),
            200
        );
        for uri in [
            "pear-audio://app.local/?file=track.wav",
            "pear-audio://app.local.example/local-audio.js",
            "pear-audio://app.local/../local-audio.js",
            "https://example.com/track.wav",
        ] {
            assert_eq!(assets(request(uri, "GET")).status(), 404);
        }
        assert_eq!(assets(request(ASSET_ROOT, "POST")).status(), 404);

        let message = |uri, body: &str| Request::builder().uri(uri).body(body.to_owned()).unwrap();
        assert!(matches!(
            command(&message(DOCUMENT, r#"{"type":"open"}"#)),
            Some(AudioCommand::Open {})
        ));
        let reset = r#"{"type":"reset_effects"}"#;
        assert!(matches!(
            command(&message(DOCUMENT, reset)),
            Some(AudioCommand::ResetEffects {})
        ));
        assert!(command(&message("https://example.com", reset)).is_none());
        assert!(matches!(
            command(&message(
                DOCUMENT,
                r#"{"type":"clear_upcoming","revision":1,"selected":0}"#
            )),
            Some(AudioCommand::ClearUpcoming {
                revision: 1,
                selected: 0,
            })
        ));
        assert!(
            command(&message(
                DOCUMENT,
                r#"{"type":"clear_upcoming","revision":1}"#
            ))
            .is_none()
        );
        assert!(
            command(&message(
                DOCUMENT,
                r#"{"type":"reset_effects","volume":0.2}"#
            ))
            .is_none()
        );
        assert!(matches!(
            command(&message(
                DOCUMENT,
                r#"{"type":"set_repeat","revision":1,"mode":"track"}"#
            )),
            Some(AudioCommand::SetRepeat {
                revision: 1,
                mode: queue::RepeatMode::Track,
            })
        ));
        assert!(
            command(&message(
                DOCUMENT,
                r#"{"type":"set_repeat","revision":1,"mode":"invalid"}"#
            ))
            .is_none()
        );
        assert!(
            command(&message(
                DOCUMENT,
                r#"{"type":"open","path":"/tmp/track.wav"}"#
            ))
            .is_none()
        );
        assert!(command(&message("https://example.com/", r#"{"type":"open"}"#)).is_none());
        assert!(command(&message(DOCUMENT, &" ".repeat(8193))).is_none());
        assert_eq!(metadata::filename(Path::new("music/test.wav")), "test.wav");
    }
}
