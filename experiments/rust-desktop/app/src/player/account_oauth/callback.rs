use std::{
    io::{self, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    sync::atomic::AtomicBool,
    thread,
    time::{Duration, Instant, SystemTime},
};

use url::form_urlencoded;
use zeroize::Zeroizing;

use super::{Error, check_cancelled, visible_ascii};

const MAX_REQUEST_BYTES: usize = 8192;
const POLL_INTERVAL: Duration = Duration::from_millis(25);
const READ_INTERVAL: Duration = Duration::from_millis(100);
const CLIENT_TIMEOUT: Duration = Duration::from_secs(1);

pub(super) enum Callback {
    Code(Zeroizing<String>),
    Denied,
}

pub(super) struct Pending {
    listener: TcpListener,
    authority: String,
    deadline: Deadline,
}

struct Deadline {
    monotonic: Instant,
    wall: SystemTime,
}

impl Deadline {
    fn new(timeout: Duration) -> Self {
        Self {
            monotonic: Instant::now() + timeout,
            wall: SystemTime::now() + timeout,
        }
    }

    fn elapsed(&self) -> bool {
        Instant::now() >= self.monotonic || SystemTime::now() >= self.wall
    }
}

impl Pending {
    pub(super) fn listen(timeout: Duration) -> Result<Self, Error> {
        let listener =
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|_| Error::Unavailable)?;
        listener
            .set_nonblocking(true)
            .map_err(|_| Error::Unavailable)?;
        let authority = listener
            .local_addr()
            .map_err(|_| Error::Unavailable)?
            .to_string();
        Ok(Self {
            listener,
            authority,
            deadline: Deadline::new(timeout),
        })
    }

    pub(super) fn redirect(&self) -> String {
        format!("http://{}/", self.authority)
    }

    /// Consume the listener on the first matching response. Unrelated requests cannot consume it.
    pub(super) fn receive(
        self,
        state: &str,
        cancelled: &AtomicBool,
    ) -> Result<Zeroizing<String>, Error> {
        loop {
            check_cancelled(cancelled)?;
            if self.deadline.elapsed() {
                return Err(Error::Timeout);
            }
            match self.listener.accept() {
                Ok((mut stream, _)) => {
                    let result = self.read(&mut stream, state, cancelled);
                    check_cancelled(cancelled)?;
                    if self.deadline.elapsed() {
                        return Err(Error::Timeout);
                    }
                    match result {
                        Some(Callback::Code(code)) => {
                            respond(&mut stream, true);
                            return Ok(code);
                        }
                        Some(Callback::Denied) => {
                            respond(&mut stream, true);
                            return Err(Error::Denied);
                        }
                        None => respond(&mut stream, false),
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(POLL_INTERVAL)
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => (),
                Err(_) => return Err(Error::Unavailable),
            }
        }
    }

    fn read(
        &self,
        stream: &mut TcpStream,
        state: &str,
        cancelled: &AtomicBool,
    ) -> Option<Callback> {
        // An accepted socket may inherit nonblocking mode, depending on the platform.
        stream.set_nonblocking(false).ok()?;
        stream.set_read_timeout(Some(READ_INTERVAL)).ok()?;
        let mut bytes = Zeroizing::new([0u8; MAX_REQUEST_BYTES]);
        let mut end = 0;
        let client = Deadline::new(CLIENT_TIMEOUT);
        while end < bytes.len() && !client.elapsed() && !self.deadline.elapsed() {
            check_cancelled(cancelled).ok()?;
            match stream.read(&mut bytes[end..]) {
                Ok(0) => break,
                Ok(count) => {
                    end += count;
                    if bytes[..end].windows(4).any(|window| window == b"\r\n\r\n") {
                        return callback_payload(&bytes[..end], &self.authority, state);
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock
                            | io::ErrorKind::TimedOut
                            | io::ErrorKind::Interrupted
                    ) => {}
                Err(_) => break,
            }
        }
        None
    }
}

fn respond(stream: &mut TcpStream, matched: bool) {
    if stream.set_write_timeout(Some(READ_INTERVAL)).is_err() {
        return;
    }
    let (status, body) = if matched {
        (
            "200 OK",
            "Return to Pear to check the result. You can close this tab.",
        )
    } else {
        (
            "400 Bad Request",
            "This request does not match Pear sign-in.",
        )
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\n\r\n{body}",
        body.len()
    );
}

pub(super) fn callback_payload(bytes: &[u8], authority: &str, state: &str) -> Option<Callback> {
    let mut headers = [httparse::EMPTY_HEADER; 48];
    let mut request = httparse::Request::new(&mut headers);
    let httparse::Status::Complete(header_len) = request.parse(bytes).ok()? else {
        return None;
    };
    if request.method != Some("GET") || header_len != bytes.len() {
        return None;
    }
    let mut hosts = request
        .headers
        .iter()
        .filter(|header| header.name.eq_ignore_ascii_case("host"));
    if hosts.next()?.value != authority.as_bytes() || hosts.next().is_some() {
        return None;
    }
    let query = request.path?.strip_prefix("/?")?;
    if query.contains('#') {
        return None;
    }

    let (mut requested_state, mut code, mut error) = (None, None, None);
    for (name, value) in form_urlencoded::parse(query.as_bytes()) {
        let field = match name.as_ref() {
            "state" => &mut requested_state,
            "code" => &mut code,
            "error" => &mut error,
            _ => continue,
        };
        if field.is_some() || !visible_ascii(&value) {
            return None;
        }
        *field = Some(Zeroizing::new(value.into_owned()));
    }
    if requested_state.as_deref().map(String::as_str) != Some(state) {
        return None;
    }
    match (code, error) {
        (Some(code), None) => Some(Callback::Code(code)),
        (None, Some(_)) => Some(Callback::Denied),
        _ => None,
    }
}
