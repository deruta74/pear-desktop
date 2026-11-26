use std::path::PathBuf;

#[cfg(any(target_os = "macos", target_os = "windows"))]
use tao::{
    dpi::{LogicalPosition, LogicalSize},
    window::Window,
};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use wry::Rect;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub(super) use linux::{DeadlineTimer, Layout, observe_video};
#[cfg(target_os = "macos")]
pub(super) use macos::Layout;
#[cfg(target_os = "windows")]
pub(super) use windows::{
    Layout, diagnose_video, load_video_with_referer, observe_video, restrict_video_frames,
};

pub(super) const APP_ID: &str = "com.pear-desktop.rust-preview";
pub(super) const PANEL_WIDTH: i32 = 384;

#[derive(Clone, Copy)]
pub(super) enum Pane {
    Video,
    Controls,
}

pub(super) fn queue_directory() -> crate::Result<PathBuf> {
    if let Some(path) = std::env::var_os("PEAR_PREVIEW_QUEUE_DIR") {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err("PEAR_PREVIEW_QUEUE_DIR must be an absolute path.".into());
        }
        return Ok(path);
    }

    let home = || {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or("Home directory is unavailable")
    };
    #[cfg(target_os = "macos")]
    let root = home()?.join("Library/Application Support");
    #[cfg(target_os = "linux")]
    let root = match std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        Some(data) => data,
        None => home()?.join(".local/share"),
    };
    #[cfg(target_os = "windows")]
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("Local application data directory is unavailable")?;

    #[cfg(target_os = "windows")]
    let _ = home;
    Ok(root.join(APP_ID))
}

pub(super) fn configure_event_loop(
    builder: &mut tao::event_loop::EventLoopBuilder<super::PlayerEvent>,
) -> crate::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use tao::platform::unix::EventLoopBuilderExtUnix;
        let id = if std::env::var_os("PEAR_PREVIEW_QUEUE_DIR").is_some() {
            format!("{APP_ID}.isolated-{}", std::process::id())
        } else {
            APP_ID.to_owned()
        };
        builder.with_app_id(id);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = builder;
    #[cfg(target_os = "windows")]
    {
        let app_id: Vec<u16> = APP_ID.encode_utf16().chain([0]).collect();
        // The null-terminated application ID stays alive through the shell call.
        let status = unsafe {
            ::windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(
                app_id.as_ptr(),
            )
        };
        if status < 0 {
            return Err(
                format!("Could not set the player application ID (0x{status:08x}).").into(),
            );
        }
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(super) fn child_bounds(
    window: &Window,
    queue_visible: bool,
    player_present: bool,
) -> (Rect, Rect) {
    let size = window.inner_size().to_logical::<f64>(window.scale_factor());
    let panel_width = if !queue_visible {
        0.0
    } else if player_present {
        f64::from(PANEL_WIDTH)
    } else {
        size.width
    };
    let player_width = (size.width - panel_width).max(0.0);
    (
        Rect {
            position: LogicalPosition::new(0.0, 0.0).into(),
            size: LogicalSize::new(player_width, size.height).into(),
        },
        Rect {
            position: LogicalPosition::new(player_width, 0.0).into(),
            size: LogicalSize::new(size.width - player_width, size.height).into(),
        },
    )
}
