use std::{
    ptr::NonNull,
    sync::{Arc, Mutex},
    time::Instant,
};

use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject};
use objc2_foundation::{NSDictionary, NSNumber, NSString};
use objc2_media_player::{
    MPMediaItemPropertyPlaybackDuration, MPMediaItemPropertyTitle, MPNowPlayingInfoCenter,
    MPNowPlayingInfoPropertyElapsedPlaybackTime, MPNowPlayingInfoPropertyPlaybackRate,
    MPNowPlayingPlaybackState, MPRemoteCommand, MPRemoteCommandCenter, MPRemoteCommandEvent,
    MPRemoteCommandHandlerStatus,
};

use super::{Command, Request, State, Status};

const POSITION_DRIFT_MS: u64 = 500;
const COMMANDS: [Command; 6] = [
    Command::Play,
    Command::Pause,
    Command::Toggle,
    Command::Stop,
    Command::Previous,
    Command::Next,
];

#[derive(Clone, Copy, PartialEq, Eq)]
struct Route {
    generation: u64,
    available: [bool; COMMANDS.len()],
}

impl From<&State> for Route {
    fn from(state: &State) -> Self {
        let control = state.can_control;
        let playing = state.status == Status::Playing;
        Self {
            generation: state.generation,
            available: [
                control && !playing,
                control && playing,
                control,
                control,
                control && state.can_previous,
                control && state.can_next,
            ],
        }
    }
}

struct Anchor {
    generation: u64,
    duration_ms: u64,
    position_ms: u64,
    position_revision: u32,
    speed: f64,
    status: Status,
    time: Instant,
}

impl Anchor {
    fn capture(state: &State, time: Instant) -> Self {
        Self {
            generation: state.generation,
            duration_ms: state.duration_ms,
            position_ms: state.position_ms,
            position_revision: state.position_revision,
            speed: state.speed,
            status: state.status,
            time,
        }
    }

    fn needs_update(&self, state: &State, time: Instant) -> bool {
        if self.generation != state.generation
            || self.position_revision != state.position_revision
            || self.duration_ms != state.duration_ms
            || self.speed != state.speed
            || self.status != state.status
        {
            return true;
        }
        if state.status != Status::Playing {
            return self.position_ms != state.position_ms;
        }

        let elapsed = time.saturating_duration_since(self.time).as_secs_f64();
        let position = (self
            .position_ms
            .saturating_add((elapsed * self.speed * 1_000.0) as u64))
        .min(self.duration_ms);
        position.abs_diff(state.position_ms) >= POSITION_DRIFT_MS
    }
}

struct Target {
    command: Retained<MPRemoteCommand>,
    registration: Retained<AnyObject>,
}

pub(in crate::local_audio) struct Backend {
    center: Retained<MPNowPlayingInfoCenter>,
    targets: Vec<Target>,
    route: Arc<Mutex<Option<Route>>>,
    anchor: Option<Anchor>,
}

impl Backend {
    pub(in crate::local_audio) fn new(
        dispatch: impl Fn(Request) + Send + Sync + 'static,
    ) -> Option<Self> {
        let route = Arc::new(Mutex::new(None::<Route>));
        let dispatch = Arc::new(dispatch);
        // Tao constructs and updates the native player on the macOS main thread.
        let (center, commands) = unsafe {
            let commands = MPRemoteCommandCenter::sharedCommandCenter();
            (
                MPNowPlayingInfoCenter::defaultCenter(),
                [
                    commands.playCommand(),
                    commands.pauseCommand(),
                    commands.togglePlayPauseCommand(),
                    commands.stopCommand(),
                    commands.previousTrackCommand(),
                    commands.nextTrackCommand(),
                ],
            )
        };
        let targets = commands
            .into_iter()
            .zip(COMMANDS)
            .enumerate()
            .map(|(index, (command, action))| {
                let route = Arc::clone(&route);
                let dispatch = Arc::clone(&dispatch);
                let handler = RcBlock::new(move |_: NonNull<MPRemoteCommandEvent>| {
                    let current = route.lock().ok().and_then(|guard| *guard);
                    let Some(route) = current.filter(|route| route.available[index]) else {
                        return MPRemoteCommandHandlerStatus::NoActionableNowPlayingItem;
                    };
                    dispatch(Request {
                        generation: route.generation,
                        command: action,
                    });
                    MPRemoteCommandHandlerStatus::Success
                });
                // The framework copies the block and returns its removable registration token.
                let registration = unsafe {
                    command.setEnabled(false);
                    command.addTargetWithHandler(&handler)
                };
                Target {
                    command,
                    registration,
                }
            })
            .collect();
        Some(Self {
            center,
            targets,
            route,
            anchor: None,
        })
    }

    pub(in crate::local_audio) fn update(&mut self, state: Option<State>) {
        let route = state.as_ref().map(Route::from);
        let previous = match self.route.lock() {
            Ok(mut active) => std::mem::replace(&mut *active, route),
            Err(_) => return,
        };
        for (index, target) in self.targets.iter().enumerate() {
            let enabled = |route: Option<Route>| route.is_some_and(|route| route.available[index]);
            if enabled(previous) != enabled(route) {
                unsafe { target.command.setEnabled(enabled(route)) };
            }
        }

        let Some(state) = state else {
            if self.anchor.take().is_some() {
                self.clear();
            }
            return;
        };
        let current = Instant::now();
        if self
            .anchor
            .as_ref()
            .is_none_or(|anchor| anchor.needs_update(&state, current))
        {
            self.publish(&state);
            self.anchor = Some(Anchor::capture(&state, current));
        }
    }

    fn publish(&self, state: &State) {
        let title = NSString::from_str(&state.title);
        let duration = NSNumber::new_f64(state.duration_ms as f64 / 1_000.0);
        let elapsed = NSNumber::new_f64(state.position_ms as f64 / 1_000.0);
        let rate = NSNumber::new_f64(if state.status == Status::Playing {
            state.speed
        } else {
            0.0
        });
        let status = match state.status {
            Status::Playing => MPNowPlayingPlaybackState::Playing,
            Status::Paused => MPNowPlayingPlaybackState::Paused,
            Status::Stopped => MPNowPlayingPlaybackState::Stopped,
        };
        // MediaPlayer expects string/number objects at these named Now Playing keys.
        unsafe {
            let info = NSDictionary::<NSString, AnyObject>::from_slices(
                &[
                    MPMediaItemPropertyTitle,
                    MPMediaItemPropertyPlaybackDuration,
                    MPNowPlayingInfoPropertyElapsedPlaybackTime,
                    MPNowPlayingInfoPropertyPlaybackRate,
                ],
                &[&title, &duration, &elapsed, &rate],
            );
            self.center.setNowPlayingInfo(Some(&info));
            self.center.setPlaybackState(status);
        }
    }

    fn clear(&self) {
        unsafe {
            self.center
                .setPlaybackState(MPNowPlayingPlaybackState::Stopped);
            self.center.setNowPlayingInfo(None);
        }
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        if let Ok(mut route) = self.route.lock() {
            *route = None;
        }
        for target in &self.targets {
            unsafe {
                target.command.setEnabled(false);
                target.command.removeTarget(Some(&target.registration));
            }
        }
        if self.anchor.is_some() {
            self.clear();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::super::Status;
    use super::*;
    use std::time::Duration;

    fn state(status: Status) -> State {
        State {
            generation: 1,
            title: "Test tone".into(),
            duration_ms: 10_000,
            position_ms: 2_000,
            position_revision: 0,
            speed: 1.0,
            volume: 0.5,
            status,
            can_previous: false,
            can_next: true,
            can_control: true,
        }
    }

    #[test]
    fn refreshes_the_playback_anchor_on_discontinuities() {
        let now = Instant::now();
        let mut playing = state(Status::Playing);
        let anchor = Anchor::capture(&playing, now);
        let next = now + Duration::from_millis(250);
        playing.position_ms += 250;
        assert!(!anchor.needs_update(&playing, next));
        playing.position_revision += 1;
        assert!(anchor.needs_update(&playing, next));
        playing.position_revision -= 1;
        playing.position_ms += 2_000;
        assert!(anchor.needs_update(&playing, next));
        playing.position_ms -= 2_000;
        playing.speed = 0.8;
        assert!(anchor.needs_update(&playing, next));
        playing.speed = 1.0;
        playing.status = Status::Paused;
        assert!(anchor.needs_update(&playing, next));
        playing.status = Status::Playing;
        playing.generation += 1;
        assert!(anchor.needs_update(&playing, next));
    }

    #[test]
    fn paused_seek_updates_and_natural_end_is_capped() {
        let now = Instant::now();
        let mut paused = state(Status::Paused);
        let anchor = Anchor::capture(&paused, now);
        assert!(!anchor.needs_update(&paused, now + Duration::from_secs(10)));
        paused.position_ms += 1;
        assert!(anchor.needs_update(&paused, now));

        let mut tail = state(Status::Playing);
        tail.position_ms = tail.duration_ms;
        let anchor = Anchor::capture(&tail, now);
        assert!(!anchor.needs_update(&tail, now + Duration::from_secs(5)));
    }

    #[test]
    fn enables_only_the_available_commands() {
        let mut item = state(Status::Playing);
        assert_eq!(
            Route::from(&item).available,
            [false, true, true, true, false, true]
        );
        item.status = Status::Paused;
        item.can_previous = true;
        item.can_next = false;
        assert_eq!(
            Route::from(&item).available,
            [true, false, true, true, true, false]
        );
        item.can_control = false;
        assert_eq!(Route::from(&item).available, [false; COMMANDS.len()]);
    }
}
