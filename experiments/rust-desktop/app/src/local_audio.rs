mod engine;
mod equalizer;
mod media;
mod presets;
mod queue;

use std::{
    borrow::Cow,
    path::{Path, PathBuf},
    process::{Command as Process, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

use muda::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use pear_preview_dsp::ReverbSettings;
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

use crate::{Result, attach_menu, build_webview, player::isolated_builder};

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
    Prepared(std::result::Result<(String, engine::PreparedAudio), engine::EngineOpenError>),
    Opened(std::result::Result<(String, engine::Engine), engine::EngineOpenError>),
}

struct Track {
    name: String,
    engine: engine::Engine,
    generation: u64,
    stopped: bool,
}

#[derive(Serialize)]
struct View<'a> {
    track: Option<&'a str>,
    transport: Option<engine::Snapshot>,
    error: Option<&'a str>,
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

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    volume: f64,
    speed: f64,
    intensity: f32,
    high_pass_hz: f32,
    low_pass_hz: f32,
}

fn command(request: &Request<String>) -> Option<AudioCommand> {
    if request.uri() != DOCUMENT || request.body().len() > 8 * 1024 {
        return None;
    }
    serde_json::from_str(request.body()).ok()
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

fn title(path: &Path) -> String {
    let name: String = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .chars()
        .filter(|character| !character.is_control())
        .take(180)
        .collect();
    let trimmed = name.trim();
    if trimmed.is_empty() {
        "Audio file"
    } else {
        trimmed
    }
    .to_owned()
}

fn pick_files(window: &Window) -> Vec<PathBuf> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        rfd::FileDialog::new()
            .set_parent(window)
            .set_title("Open audio files")
            .add_filter(
                "Audio files",
                &["wav", "wave", "flac", "mp3", "opus", "ogg"],
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

pub(crate) fn run() -> Result<()> {
    let store = presets::Store::from_environment()?;
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
    let media_events = event_loop.create_proxy();
    let dispatch_media = move |request| {
        let _ = media_events.send_event(AudioEvent::Media(request));
    };
    #[cfg(target_os = "windows")]
    let mut media = media::Backend::new(&window, dispatch_media);
    #[cfg(not(target_os = "windows"))]
    let mut media = media::Backend::new(dispatch_media);
    let mut track: Option<Track> = None;
    let mut track_generation = 0_u64;
    let mut volume = 1.0;
    let mut speed = 1.0;
    let mut reverb = ReverbSettings::default();
    let mut equalizer = equalizer::Profile::default();
    let mut queue = queue::Queue::default();
    let mut deadline = None;
    #[cfg(target_os = "linux")]
    let mut timer = crate::player::DeadlineTimer::default();

    event_loop.run(move |event, _, flow| {
        let _keep_menu_alive = &menu;
        let was_opening = queue.opening();
        let mut dropped_files = None;
        let mut requested_path = None;
        let action = match event {
            Event::WindowEvent {
                window_id,
                event: WindowEvent::CloseRequested,
                ..
            } if window_id == window.id() => {
                media.take();
                track.take();
                *flow = ControlFlow::Exit;
                return;
            }
            Event::UserEvent(AudioEvent::Menu(event)) if event.id == *quit.id() => {
                media.take();
                track.take();
                *flow = ControlFlow::Exit;
                return;
            }
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
            Event::UserEvent(AudioEvent::Prepared(Ok((name, audio)))) => {
                // A direct ALSA endpoint can permit only one active stream.
                // Keep the old track while validating the file and release it
                // before asking the current default output for a new stream.
                track.take();
                let result_events = result_events.clone();
                if std::thread::Builder::new()
                    .name("pear-audio-output".into())
                    .spawn(move || {
                        let result =
                            engine::Engine::open_prepared(audio).map(|engine| (name, engine));
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
                    Ok((name, mut engine)) => {
                        let (play, skipped) = queue.finish();
                        engine.set_volume(volume);
                        engine.set_speed(speed);
                        engine.set_reverb(reverb);
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
                            name,
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
                return;
            }
            _ => return,
        };
        let send_settings = matches!(action, Some(AudioCommand::Ready {}));
        let send_queue = send_settings
            || matches!(
                action,
                Some(AudioCommand::ShuffleUpcoming { .. } | AudioCommand::SetRepeat { .. })
            );
        let eq_revision = match &action {
            Some(
                AudioCommand::SetEqualizer { revision, .. }
                | AudioCommand::LoadEqualizerPreset { revision, .. },
            ) => Some(*revision),
            _ => None,
        };
        let send_presets = send_settings
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
            Some(AudioCommand::SetRepeat { revision, mode }) => {
                queue.set_repeat(revision, mode);
            }
            Some(action) => {
                if let Some(Track {
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
                        AudioCommand::SetVolume { volume: value }
                            if (0.0..=1.0).contains(&value) =>
                        {
                            volume = value;
                            engine.set_volume(volume);
                        }
                        AudioCommand::SetSpeed { speed: value } if (0.7..=1.3).contains(&value) => {
                            speed = value;
                            engine.set_speed(speed);
                        }
                        AudioCommand::SetReverb {
                            intensity,
                            high_pass_hz,
                            low_pass_hz,
                        } if (0.0..=1.0).contains(&intensity)
                            && (20.0..=20_000.0).contains(&high_pass_hz)
                            && (20.0..=20_000.0).contains(&low_pass_hz) =>
                        {
                            reverb = ReverbSettings {
                                intensity,
                                high_pass_hz,
                                low_pass_hz,
                            };
                            engine.set_reverb(reverb);
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
            None if !deadline.is_some_and(|when| Instant::now() >= when) => return,
            None => {}
        }
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
                    let result =
                        engine::PreparedAudio::read(&path).map(|audio| (title(&path), audio));
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
                            title: track.name.clone(),
                            duration_ms: snapshot.duration_ms,
                            position_ms: snapshot.position_ms,
                            position_revision: snapshot.position_revision,
                            speed,
                            volume,
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
                Instant::now()
                    + if snapshot.playing {
                        UPDATE_INTERVAL
                    } else {
                        IDLE_UPDATE_INTERVAL
                    }
            });
        #[cfg(target_os = "linux")]
        {
            deadline = timer.schedule(deadline);
        }
        *flow = deadline.map_or(ControlFlow::Wait, ControlFlow::WaitUntil);
        let state = View {
            track: track.as_ref().map(|track| track.name.as_str()),
            transport,
            error: error.as_deref(),
            opening,
            queue: send_queue.then(|| queue.view()),
            settings: send_settings.then_some(Settings {
                volume,
                speed,
                intensity: reverb.intensity,
                high_pass_hz: reverb.high_pass_hz,
                low_pass_hz: reverb.low_pass_hz,
            }),
            equalizer: (send_settings || eq_revision.is_some()).then_some(&equalizer),
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
        assert_eq!(title(Path::new("music/test.wav")), "test.wav");
    }
}
