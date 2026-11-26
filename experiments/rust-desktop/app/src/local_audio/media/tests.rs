use super::*;

#[test]
fn native_commands_follow_the_current_generation_and_capabilities() {
    let mut state = State {
        generation: 7,
        title: "Track.wav".into(),
        duration_ms: 9_000,
        position_ms: 1_000,
        speed: 1.0,
        volume: 1.0,
        status: Status::Paused,
        can_previous: false,
        can_next: true,
        can_control: true,
    };
    let play = Request {
        generation: 7,
        command: Command::Play,
    };

    assert!(state.allows(play));
    assert!(state.allows(Request {
        command: Command::Next,
        ..play
    }));
    assert!(!state.allows(Request {
        command: Command::Previous,
        ..play
    }));
    state.can_control = false;
    assert!(!state.allows(play));
    state.can_control = true;
    state.generation = 8;
    assert!(!state.allows(play));
}
