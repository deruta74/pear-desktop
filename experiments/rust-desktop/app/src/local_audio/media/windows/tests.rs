use tao::{
    event_loop::EventLoopBuilder, platform::windows::EventLoopBuilderExtWindows,
    window::WindowBuilder,
};
use windows::Win32::Foundation::{
    E_ACCESSDENIED, E_NOINTERFACE, E_NOTIMPL, ERROR_NOT_LOGGED_ON, ERROR_NOT_SUPPORTED,
    ERROR_REQUIRES_INTERACTIVE_WINDOWSTATION, REGDB_E_CLASSNOTREG,
};

use super::*;

#[test]
#[ignore = "requires Windows desktop SMTC"]
fn windows_smtc_native_smoke() -> Result<()> {
    let event_loop = EventLoopBuilder::new().with_any_thread(true).build();
    let window = WindowBuilder::new()
        .with_title("Pear SMTC Smoke Test")
        .with_visible(false)
        .build(&event_loop)
        .expect("create a Tao window for SMTC");

    // Keep the apartment alive while observing the controls after the backend drops.
    unsafe { RoInitialize(RO_INIT_SINGLETHREADED) }?;
    let _apartment = Apartment;
    let mut backend = match Backend::try_new(&window, |_| {}) {
        Ok(backend) => backend,
        Err(error) => {
            let result = match error.code() {
                E_NOINTERFACE | E_NOTIMPL | REGDB_E_CLASSNOTREG => "skipped_api_unavailable",
                code if code == ERROR_NOT_SUPPORTED.to_hresult() => "skipped_api_unavailable",
                code if code == E_ACCESSDENIED
                    || code == ERROR_NOT_LOGGED_ON.to_hresult()
                    || code == ERROR_REQUIRES_INTERACTIVE_WINDOWSTATION.to_hresult() =>
                {
                    "skipped_desktop_unavailable"
                }
                _ => return Err(error),
            };
            println!("WINDOWS_SMTC_SMOKE={result}");
            return Ok(());
        }
    };
    let controls = backend.controls.clone();
    let display = backend.display.clone();
    assert!(!controls.IsEnabled()?);
    assert_eq!(controls.PlaybackStatus()?, MediaPlaybackStatus::Closed);

    let mut state = State {
        generation: 1,
        title: "Synthetic One.wav".into(),
        duration_ms: 5_000,
        position_ms: 750,
        position_revision: 0,
        speed: 1.0,
        volume: 1.0,
        status: Status::Playing,
        can_previous: false,
        can_next: true,
        can_control: true,
    };
    backend.update(Some(state.clone()));
    assert!(controls.IsEnabled()?);
    assert_eq!(controls.PlaybackStatus()?, MediaPlaybackStatus::Playing);
    assert!(!controls.IsPlayEnabled()?);
    assert!(controls.IsPauseEnabled()?);
    assert!(controls.IsStopEnabled()?);
    assert!(!controls.IsPreviousEnabled()?);
    assert!(controls.IsNextEnabled()?);
    assert_eq!(display.Type()?, MediaPlaybackType::Music);
    let music = display.MusicProperties()?;
    assert_eq!(music.Title()?, HSTRING::from(state.title.as_str()));
    assert!(music.Artist()?.is_empty());
    assert!(music.AlbumTitle()?.is_empty());

    state.generation += 1;
    state.title = "Synthetic Two.wav".into();
    state.status = Status::Paused;
    state.can_previous = true;
    state.can_next = false;
    backend.update(Some(state.clone()));
    assert_eq!(controls.PlaybackStatus()?, MediaPlaybackStatus::Paused);
    assert!(controls.IsPlayEnabled()?);
    assert!(!controls.IsPauseEnabled()?);
    assert!(controls.IsPreviousEnabled()?);
    assert!(!controls.IsNextEnabled()?);
    assert_eq!(
        display.MusicProperties()?.Title()?,
        HSTRING::from(state.title.as_str())
    );

    backend.update(None);
    assert!(!controls.IsEnabled()?);
    assert_eq!(controls.PlaybackStatus()?, MediaPlaybackStatus::Closed);
    assert_eq!(display.Type()?, MediaPlaybackType::Unknown);

    state.status = Status::Stopped;
    backend.update(Some(state));
    assert!(controls.IsEnabled()?);
    assert_eq!(controls.PlaybackStatus()?, MediaPlaybackStatus::Stopped);
    assert!(controls.IsPlayEnabled()?);
    assert!(!controls.IsStopEnabled()?);

    drop(backend);
    assert!(!controls.IsEnabled()?);
    assert_eq!(controls.PlaybackStatus()?, MediaPlaybackStatus::Closed);
    assert_eq!(display.Type()?, MediaPlaybackType::Unknown);
    println!("WINDOWS_SMTC_SMOKE=passed");
    Ok(())
}
