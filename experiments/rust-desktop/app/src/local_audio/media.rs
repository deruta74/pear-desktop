#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(test)]
mod tests;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub(super) use linux::Backend;
#[cfg(target_os = "macos")]
pub(super) use macos::Backend;
#[cfg(target_os = "windows")]
pub(super) use windows::Backend;

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
    pub(super) position_revision: u32,
    pub(super) speed: f64,
    pub(super) volume: f64,
    pub(super) status: Status,
    pub(super) can_previous: bool,
    pub(super) can_next: bool,
    pub(super) can_control: bool,
}

#[cfg(any(target_os = "linux", target_os = "windows", test))]
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

#[cfg(any(target_os = "windows", test))]
fn windows_request(state: Option<&State>, command: Command) -> Option<Request> {
    let state = state?;
    let request = Request {
        command,
        generation: state.generation,
    };
    let available = match command {
        Command::Play => state.status != Status::Playing,
        Command::Pause => state.status == Status::Playing,
        Command::Stop => state.status != Status::Stopped,
        Command::Next | Command::Previous => true,
        Command::Toggle => false,
    };
    (available && state.allows(request)).then_some(request)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub(super) struct Backend;

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
impl Backend {
    pub(super) fn new(_dispatch: impl Fn(Request) + 'static) -> Option<Self> {
        None
    }

    pub(super) fn update(&mut self, _state: Option<State>) {}
}
