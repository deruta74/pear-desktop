use std::sync::{Arc, Mutex};

use tao::{platform::windows::WindowExtWindows, window::Window};
use windows::{
    Foundation::TypedEventHandler,
    Media::{
        MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls,
        SystemMediaTransportControlsButton as Button,
        SystemMediaTransportControlsButtonPressedEventArgs,
        SystemMediaTransportControlsDisplayUpdater,
    },
    Win32::{
        Foundation::HWND,
        System::WinRT::{
            ISystemMediaTransportControlsInterop, RO_INIT_SINGLETHREADED, RoInitialize,
            RoUninitialize,
        },
    },
    core::{HSTRING, Result, factory},
};

use super::{Command, Request, State, Status, windows_request};

#[cfg(test)]
mod tests;

pub(crate) struct Backend {
    controls: SystemMediaTransportControls,
    display: SystemMediaTransportControlsDisplayUpdater,
    state: Arc<Mutex<Option<State>>>,
    token: Option<i64>,
    // Release the WinRT objects before uninitializing the apartment.
    _apartment: Apartment,
}

impl Backend {
    pub(crate) fn new(
        window: &Window,
        dispatch: impl Fn(Request) + Send + Sync + 'static,
    ) -> Option<Self> {
        Self::try_new(window, dispatch).ok()
    }

    fn try_new(
        window: &Window,
        dispatch: impl Fn(Request) + Send + Sync + 'static,
    ) -> Result<Self> {
        // Tao and WebView2 use an STA on the window thread.
        unsafe { RoInitialize(RO_INIT_SINGLETHREADED) }?;
        let apartment = Apartment;
        let interop =
            factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>()?;
        // The HWND belongs to the live Tao window on this thread.
        let controls: SystemMediaTransportControls =
            unsafe { interop.GetForWindow(HWND(window.hwnd() as _)) }?;
        controls.SetIsEnabled(false)?;
        controls.SetPlaybackStatus(MediaPlaybackStatus::Closed)?;
        let display = controls.DisplayUpdater()?;

        let state = Arc::new(Mutex::new(None));
        let callback_state = Arc::clone(&state);
        let handler =
            TypedEventHandler::<_, SystemMediaTransportControlsButtonPressedEventArgs>::new(
                move |_, args| {
                    let Some(args) = args.as_ref() else {
                        return Ok(());
                    };
                    let command = match args.Button()? {
                        Button::Play => Command::Play,
                        Button::Pause => Command::Pause,
                        Button::Stop => Command::Stop,
                        Button::Previous => Command::Previous,
                        Button::Next => Command::Next,
                        _ => return Ok(()),
                    };
                    let request = callback_state
                        .lock()
                        .ok()
                        .and_then(|state| windows_request(state.as_ref(), command));
                    if let Some(request) = request {
                        dispatch(request);
                    }
                    Ok(())
                },
            );
        let token = controls.ButtonPressed(&handler)?;
        Ok(Self {
            controls,
            display,
            state,
            token: Some(token),
            _apartment: apartment,
        })
    }

    pub(crate) fn update(&mut self, state: Option<State>) {
        if self.token.is_none() {
            return;
        }
        let Ok(previous) = self
            .state
            .lock()
            .map(|mut current| std::mem::replace(&mut *current, state.clone()))
        else {
            self.disable();
            return;
        };
        if self.publish(previous.as_ref(), state.as_ref()).is_err() {
            self.disable();
        }
    }

    fn publish(&self, previous: Option<&State>, state: Option<&State>) -> Result<()> {
        let opened = state.is_some() && previous.is_none();
        if state.is_none() && previous.is_some() {
            self.controls.SetIsEnabled(false)?;
        }
        let status = state.map(|state| state.status);
        if previous.map(|state| state.status) != status {
            self.controls.SetPlaybackStatus(match status {
                Some(Status::Playing) => MediaPlaybackStatus::Playing,
                Some(Status::Paused) => MediaPlaybackStatus::Paused,
                Some(Status::Stopped) => MediaPlaybackStatus::Stopped,
                None => MediaPlaybackStatus::Closed,
            })?;
        }
        // The snapshot also updates for position changes. Publish only changed controls.
        type SetEnabled = fn(&SystemMediaTransportControls, bool) -> Result<()>;
        let buttons: [(Command, SetEnabled); 5] = [
            (
                Command::Play,
                SystemMediaTransportControls::SetIsPlayEnabled,
            ),
            (
                Command::Pause,
                SystemMediaTransportControls::SetIsPauseEnabled,
            ),
            (
                Command::Stop,
                SystemMediaTransportControls::SetIsStopEnabled,
            ),
            (
                Command::Previous,
                SystemMediaTransportControls::SetIsPreviousEnabled,
            ),
            (
                Command::Next,
                SystemMediaTransportControls::SetIsNextEnabled,
            ),
        ];
        for (command, set_enabled) in buttons {
            let enabled = windows_request(state, command).is_some();
            if opened || enabled != windows_request(previous, command).is_some() {
                set_enabled(&self.controls, enabled)?;
            }
        }
        if previous.map(|state| &state.metadata) != state.map(|state| &state.metadata) {
            if let Some(state) = state {
                self.display.SetType(MediaPlaybackType::Music)?;
                let music = self.display.MusicProperties()?;
                music.SetTitle(&HSTRING::from(state.metadata.title.as_str()))?;
                music.SetArtist(&HSTRING::from(
                    state.metadata.artist.as_deref().unwrap_or_default(),
                ))?;
                music.SetAlbumTitle(&HSTRING::from(
                    state.metadata.album.as_deref().unwrap_or_default(),
                ))?;
            } else {
                self.display.ClearAll()?;
            }
            self.display.Update()?;
        }
        if opened {
            self.controls.SetIsEnabled(true)?;
        }
        Ok(())
    }

    fn disable(&mut self) {
        if let Some(token) = self.token.take() {
            if let Ok(mut state) = self.state.lock() {
                *state = None;
            }
            let _ = self.controls.RemoveButtonPressed(token);
            let _ = self.controls.SetIsEnabled(false);
            let _ = self.controls.SetPlaybackStatus(MediaPlaybackStatus::Closed);
            let _ = self.display.ClearAll();
            let _ = self.display.Update();
        }
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.disable();
    }
}

struct Apartment;

impl Drop for Apartment {
    fn drop(&mut self) {
        // Balance this backend's successful RoInitialize call on the window thread.
        unsafe { RoUninitialize() };
    }
}
