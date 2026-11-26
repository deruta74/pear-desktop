use super::*;

#[test]
fn native_commands_follow_the_current_generation_and_capabilities() {
    let mut state = State {
        generation: 7,
        metadata: Arc::new(Metadata {
            title: "Track.wav".into(),
            ..Metadata::default()
        }),
        duration_ms: 9_000,
        position_ms: 1_000,
        position_revision: 0,
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

#[test]
fn windows_controls_only_dispatch_available_buttons_for_the_current_track() {
    let mut state = State {
        generation: 12,
        metadata: Arc::new(Metadata {
            title: "Track.wav".into(),
            ..Metadata::default()
        }),
        duration_ms: 9_000,
        position_ms: 1_000,
        position_revision: 0,
        speed: 1.0,
        volume: 1.0,
        status: Status::Paused,
        can_previous: false,
        can_next: true,
        can_control: true,
    };
    let request = |state: &State, command| windows_request(Some(state), command);
    assert_eq!(
        request(&state, Command::Play),
        Some(Request {
            command: Command::Play,
            generation: 12,
        })
    );
    assert_eq!(request(&state, Command::Pause), None);
    assert_eq!(request(&state, Command::Previous), None);
    assert!(request(&state, Command::Next).is_some());
    assert!(request(&state, Command::Stop).is_some());

    state.status = Status::Playing;
    assert_eq!(request(&state, Command::Play), None);
    assert!(request(&state, Command::Pause).is_some());
    assert_eq!(request(&state, Command::Toggle), None);

    state.status = Status::Stopped;
    assert!(request(&state, Command::Play).is_some());
    assert_eq!(request(&state, Command::Stop), None);

    state.can_control = false;
    assert_eq!(request(&state, Command::Play), None);
    assert_eq!(request(&state, Command::Next), None);
    assert_eq!(windows_request(None, Command::Play), None);
}
