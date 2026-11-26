#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(test)]
mod tests;

#[cfg(target_os = "linux")]
pub(super) use linux::Backend;
#[cfg(target_os = "macos")]
pub(super) use macos::Backend;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
pub(super) enum Command {
    Play,
    Pause,
    Toggle,
    Stop,
    Previous,
    Next,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Request {
    pub(super) generation: u64,
    pub(super) command: Command,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Status {
    Playing,
    Paused,
    Stopped,
}

#[derive(Clone)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(super) struct State {
    pub(super) generation: u64,
    pub(super) title: String,
    pub(super) duration_ms: u64,
    pub(super) position_ms: u64,
    pub(super) speed: f64,
    pub(super) volume: f64,
    pub(super) status: Status,
    pub(super) can_previous: bool,
    pub(super) can_next: bool,
    pub(super) can_control: bool,
}

#[cfg(any(target_os = "linux", test))]
impl State {
    fn allows(&self, request: Request) -> bool {
        self.generation == request.generation
            && self.can_control
            && match request.command {
                Command::Previous => self.can_previous,
                Command::Next => self.can_next,
                _ => true,
            }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(super) struct Backend;

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
impl Backend {
    pub(super) fn new(_dispatch: impl Fn(Request) + 'static) -> Option<Self> {
        None
    }

    pub(super) fn update(&mut self, _state: Option<State>) {}
}
