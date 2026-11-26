use std::sync::Arc;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(test)]
mod tests;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub(crate) use linux::Backend;
#[cfg(target_os = "macos")]
pub(crate) use macos::Backend;
#[cfg(target_os = "windows")]
pub(crate) use windows::Backend;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Metadata {
    pub(crate) title: String,
    pub(crate) artist: Option<String>,
    pub(crate) album: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
pub(crate) enum Command {
    Play,
    Pause,
    Toggle,
    Stop,
    Previous,
    Next,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Request {
    pub(crate) generation: u64,
    pub(crate) command: Command,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Status {
    Playing,
    Paused,
    Stopped,
}

#[derive(Clone)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) struct State {
    pub(crate) generation: u64,
    pub(crate) metadata: Arc<Metadata>,
    pub(crate) duration_ms: u64,
    pub(crate) position_ms: u64,
    pub(crate) position_revision: u32,
    pub(crate) speed: f64,
    pub(crate) volume: f64,
    pub(crate) status: Status,
    pub(crate) can_previous: bool,
    pub(crate) can_next: bool,
    pub(crate) can_control: bool,
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
pub(crate) struct Backend;

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
impl Backend {
    pub(crate) fn new(_dispatch: impl Fn(Request) + 'static) -> Option<Self> {
        None
    }

    pub(crate) fn update(&mut self, _state: Option<State>) {}
}
