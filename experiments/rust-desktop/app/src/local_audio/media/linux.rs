use std::{cell::RefCell, collections::HashMap, rc::Rc};

use gtk::{
    gio::{self, Cancellable, DBusConnection, RegistrationId},
    glib::{
        Variant,
        variant::{ObjectPath, ToVariant},
    },
};

use super::{Command, Request, State, Status};

const PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER: &str = "org.mpris.MediaPlayer2.Player";
const ROOT: &str = "org.mpris.MediaPlayer2";
const DBUS: &str = "org.freedesktop.DBus";
const DO_NOT_QUEUE: u32 = 4;
const PRIMARY_OWNER: u32 = 1;
const CHANGING_PROPERTIES: &[&str] = &[
    "PlaybackStatus",
    "Rate",
    "Metadata",
    "Volume",
    "CanGoNext",
    "CanGoPrevious",
    "CanPlay",
    "CanPause",
];

const INTERFACES: &str = r#"
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek"><arg name="Offset" type="x" direction="in"/></method>
    <method name="SetPosition">
      <arg name="TrackId" type="o" direction="in"/>
      <arg name="Position" type="x" direction="in"/>
    </method>
    <method name="OpenUri"><arg name="Uri" type="s" direction="in"/></method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Rate" type="d" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="read"/>
    <property name="Position" type="x" access="read">
      <annotation name="org.freedesktop.DBus.Property.EmitsChangedSignal" value="false"/>
    </property>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read">
      <annotation name="org.freedesktop.DBus.Property.EmitsChangedSignal" value="false"/>
    </property>
  </interface>
</node>
"#;

pub(in crate::local_audio) struct Backend {
    connection: DBusConnection,
    registrations: Vec<RegistrationId>,
    name: Option<String>,
    state: Rc<RefCell<Option<State>>>,
}

impl Backend {
    pub(in crate::local_audio) fn new(dispatch: impl Fn(Request) + 'static) -> Option<Self> {
        // Keep session bus loss from terminating the app or changing GTK's shared connection.
        let address =
            gio::dbus_address_get_for_bus_sync(gio::BusType::Session, Cancellable::NONE).ok()?;
        let connection = DBusConnection::for_address_sync(
            &address,
            gio::DBusConnectionFlags::AUTHENTICATION_CLIENT
                | gio::DBusConnectionFlags::MESSAGE_BUS_CONNECTION,
            None,
            Cancellable::NONE,
        )
        .ok()?;
        connection.set_exit_on_close(false);

        let mut backend = Self {
            connection,
            registrations: Vec::new(),
            name: None,
            state: Rc::new(RefCell::new(None)),
        };
        let interfaces = gio::DBusNodeInfo::for_xml(INTERFACES).ok()?;
        let root = interfaces.lookup_interface(ROOT)?;
        let player = interfaces.lookup_interface(PLAYER)?;
        backend.registrations.push(
            backend
                .connection
                .register_object(PATH, &root)
                .method_call(|_, _, _, _, _, _, invocation| {
                    invocation.return_dbus_error(
                        "org.freedesktop.DBus.Error.NotSupported",
                        "This media player cannot be raised or closed over D-Bus.",
                    );
                })
                .property(|_, _, _, _, property| root_property(property))
                .build()
                .ok()?,
        );
        let commands = Rc::clone(&backend.state);
        let properties = Rc::clone(&backend.state);
        backend.registrations.push(
            backend
                .connection
                .register_object(PATH, &player)
                .method_call(move |_, _, _, _, method, _, invocation| {
                    let command = match method {
                        "Play" => Command::Play,
                        "Pause" => Command::Pause,
                        "PlayPause" => Command::Toggle,
                        "Stop" => Command::Stop,
                        "Previous" => Command::Previous,
                        "Next" => Command::Next,
                        _ => {
                            invocation.return_dbus_error(
                                "org.freedesktop.DBus.Error.NotSupported",
                                "This media player does not support the requested operation.",
                            );
                            return;
                        }
                    };
                    let request = commands.borrow().as_ref().and_then(|state| {
                        let request = Request {
                            command,
                            generation: state.generation,
                        };
                        state.allows(request).then_some(request)
                    });
                    if let Some(request) = request {
                        dispatch(request);
                    }
                    invocation.return_value(None);
                })
                .property(move |_, _, _, _, property| {
                    player_property(properties.borrow().as_ref(), property)
                })
                .build()
                .ok()?,
        );
        let name = format!("org.mpris.MediaPlayer2.pear.instance{}", std::process::id());
        if bus_call(
            &backend.connection,
            "RequestName",
            (&name, DO_NOT_QUEUE).to_variant(),
        )
        .and_then(|reply| reply.get::<(u32,)>())
            != Some((PRIMARY_OWNER,))
        {
            return None;
        }
        backend.name = Some(name);
        Some(backend)
    }

    pub(in crate::local_audio) fn update(&mut self, next: Option<State>) {
        let previous = self.state.replace(next);
        let next = self.state.borrow();
        let changed: HashMap<_, _> = CHANGING_PROPERTIES
            .iter()
            .filter_map(|&property| {
                let value = player_property(next.as_ref(), property);
                (value != player_property(previous.as_ref(), property)).then_some((property, value))
            })
            .collect();
        if !changed.is_empty() {
            let _ = self.connection.emit_signal(
                None,
                PATH,
                "org.freedesktop.DBus.Properties",
                "PropertiesChanged",
                Some(&(PLAYER, changed, Vec::<&str>::new()).to_variant()),
            );
        }
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        for registration in self.registrations.drain(..) {
            let _ = self.connection.unregister_object(registration);
        }
        if let Some(name) = self.name.take() {
            let _ = bus_call(&self.connection, "ReleaseName", (name,).to_variant());
        }
    }
}

fn bus_call(connection: &DBusConnection, method: &str, arguments: Variant) -> Option<Variant> {
    connection
        .call_sync(
            Some(DBUS),
            "/org/freedesktop/DBus",
            DBUS,
            method,
            Some(&arguments),
            None,
            gio::DBusCallFlags::NONE,
            1_000,
            Cancellable::NONE,
        )
        .ok()
}

fn root_property(property: &str) -> Variant {
    match property {
        "CanQuit" | "CanRaise" | "HasTrackList" => false.to_variant(),
        "Identity" => "Pear Local Audio".to_variant(),
        "SupportedUriSchemes" | "SupportedMimeTypes" => Vec::<&str>::new().to_variant(),
        _ => unreachable!("GDBus validates the property against the registered interface"),
    }
}

fn player_property(state: Option<&State>, property: &str) -> Variant {
    let can_control = state.is_some_and(|state| state.can_control);
    match property {
        "PlaybackStatus" => match state.map(|state| state.status) {
            Some(Status::Playing) => "Playing",
            Some(Status::Paused) => "Paused",
            Some(Status::Stopped) | None => "Stopped",
        }
        .to_variant(),
        "Rate" => state.map_or(1.0, |state| state.speed).to_variant(),
        "MinimumRate" => 0.7_f64.to_variant(),
        "MaximumRate" => 1.3_f64.to_variant(),
        "Metadata" => metadata(state),
        "Volume" => state.map_or(1.0, |state| state.volume).to_variant(),
        "Position" => micros(state.map_or(0, |state| state.position_ms)).to_variant(),
        "CanGoNext" => state
            .is_some_and(|state| state.can_control && state.can_next)
            .to_variant(),
        "CanGoPrevious" => state
            .is_some_and(|state| state.can_control && state.can_previous)
            .to_variant(),
        "CanPlay" | "CanPause" => can_control.to_variant(),
        "CanSeek" => false.to_variant(),
        // MPRIS requires CanControl to be constant for the lifetime of the service.
        "CanControl" => true.to_variant(),
        _ => unreachable!("GDBus validates the property against the registered interface"),
    }
}

fn metadata(state: Option<&State>) -> Variant {
    let mut fields = HashMap::new();
    if let Some(state) = state {
        let id = ObjectPath::try_from(format!("{PATH}/track/{}", state.generation))
            .expect("a decimal generation forms a valid D-Bus object path");
        fields.insert("mpris:trackid", id.to_variant());
        fields.insert("mpris:length", micros(state.duration_ms).to_variant());
        fields.insert("xesam:title", state.title.to_variant());
    }
    fields.to_variant()
}

fn micros(milliseconds: u64) -> i64 {
    milliseconds.saturating_mul(1_000).min(i64::MAX as u64) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mpris_uses_microseconds_and_object_paths_without_exposing_file_locations() {
        let mut state = State {
            generation: 1,
            title: "Track.wav".into(),
            duration_ms: 5500,
            position_ms: 1234,
            speed: 1.1,
            volume: 0.5,
            status: Status::Playing,
            can_previous: false,
            can_next: true,
            can_control: true,
        };
        let fields = |state: &State| {
            metadata(Some(state))
                .get::<HashMap<String, Variant>>()
                .unwrap()
        };
        let first = fields(&state);
        assert_eq!(first.len(), 3);
        assert_eq!(
            first["xesam:title"].get::<String>().as_deref(),
            Some("Track.wav")
        );
        assert_eq!(first["mpris:length"].get::<i64>(), Some(5_500_000));
        assert!(first["mpris:trackid"].get::<ObjectPath>().is_some());
        assert_eq!(
            player_property(Some(&state), "Position").get::<i64>(),
            Some(1_234_000)
        );
        assert_eq!(
            player_property(Some(&state), "CanSeek").get::<bool>(),
            Some(false)
        );
        assert_eq!(
            player_property(Some(&state), "CanGoNext").get::<bool>(),
            Some(true)
        );
        state.generation += 1;
        state.can_control = false;
        assert_ne!(fields(&state)["mpris:trackid"], first["mpris:trackid"]);
        assert_eq!(
            player_property(Some(&state), "CanGoNext").get::<bool>(),
            Some(false)
        );
        assert_eq!(player_property(None, "CanPlay").get::<bool>(), Some(false));
    }
}
