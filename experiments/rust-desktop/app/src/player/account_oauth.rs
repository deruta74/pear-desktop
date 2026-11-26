use std::{
    fs::{File, OpenOptions},
    io::Read,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant, SystemTime},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
use url::Url;
use zeroize::Zeroizing;

mod callback;
#[cfg(test)]
mod tests;

const CLIENT_FILE: &str = "PEAR_YOUTUBE_OAUTH_CLIENT_FILE";
const AUTHORIZATION_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const REVOCATION_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";
const SCOPE: &str = "https://www.googleapis.com/auth/youtube.readonly";
const AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(120);
const BROWSER_FAILURE_CHECK: Duration = Duration::from_millis(250);
const MAX_CONFIG_BYTES: u64 = 16 * 1024;
const MAX_TOKEN_BYTES: u64 = 32 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Error {
    Config,
    Unavailable,
    Browser,
    Denied,
    Cancelled,
    Timeout,
    Exchange,
    Revocation,
}

impl Error {
    pub(super) const fn message(self) -> &'static str {
        match self {
            Self::Config => "Check the configured Google Desktop OAuth client file.",
            Self::Unavailable => "Pear could not start Google sign-in.",
            Self::Browser => "Pear could not open the system browser.",
            Self::Denied => "Google sign-in was declined or blocked.",
            Self::Cancelled => "Google sign-in was cancelled.",
            Self::Timeout => "Google sign-in timed out. Connect again to retry.",
            Self::Exchange => "Pear could not establish read-only YouTube access.",
            Self::Revocation => {
                "Pear could not revoke access. Remove it in your Google Account permissions."
            }
        }
    }
}

#[derive(Clone)]
pub(super) struct ClientConfig {
    id: String,
    secret: Option<Zeroizing<String>>,
}

#[derive(Deserialize)]
struct DesktopClientFile<'a> {
    #[serde(borrow)]
    installed: &'a RawValue,
}

#[derive(Deserialize)]
struct Installed {
    client_id: String,
    client_secret: Option<String>,
}

impl ClientConfig {
    #[cfg(test)]
    pub(super) fn fixture() -> Self {
        Self {
            id: "example.apps.googleusercontent.com".into(),
            secret: None,
        }
    }

    pub(super) fn from_env() -> Result<Option<Self>, Error> {
        std::env::var_os(CLIENT_FILE)
            .map(|path| Self::read_file(Path::new(&path)))
            .transpose()
    }

    fn open_file(path: &Path) -> Result<File, Error> {
        if !path.is_absolute() || !path.metadata().is_ok_and(|metadata| metadata.is_file()) {
            return Err(Error::Config);
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // A path replaced with a FIFO must not block the desktop event loop.
            options.custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY);
        }
        let file = options.open(path).map_err(|_| Error::Config)?;
        if !file.metadata().is_ok_and(|metadata| metadata.is_file()) {
            return Err(Error::Config);
        }
        Ok(file)
    }

    fn read_file(path: &Path) -> Result<Self, Error> {
        let mut bytes = Zeroizing::new(Vec::new());
        Self::open_file(path)?
            .take(MAX_CONFIG_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::Config)?;
        Self::parse(&bytes).ok_or(Error::Config)
    }

    fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.len() as u64 > MAX_CONFIG_BYTES
            || bytes.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{')
        {
            return None;
        }

        // Decode only the Desktop client fields. Google endpoints are fixed by Pear.
        let file: DesktopClientFile<'_> = serde_json::from_slice(bytes).ok()?;
        if !file.installed.get().starts_with('{') {
            return None;
        }
        let client: Installed = serde_json::from_str(file.installed.get()).ok()?;
        let secret = client.client_secret.map(Zeroizing::new);
        let prefix = client
            .client_id
            .strip_suffix(".apps.googleusercontent.com")?;
        if prefix.is_empty()
            || prefix.len() > 128
            || !prefix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || secret.as_ref().is_some_and(|secret| !visible_ascii(secret))
        {
            return None;
        }
        Some(Self {
            id: client.client_id,
            secret,
        })
    }
}

pub(super) struct Session {
    access_token: Zeroizing<String>,
    revocation_token: Option<Zeroizing<String>>,
    disconnected: AtomicBool,
    expires_at: Instant,
    expires_wall: SystemTime,
}

impl Session {
    #[cfg(test)]
    pub(super) fn fixture() -> Self {
        Self {
            access_token: Zeroizing::new("mock-access".into()),
            revocation_token: None,
            disconnected: AtomicBool::new(false),
            expires_at: Instant::now() + Duration::from_secs(60),
            expires_wall: SystemTime::now() + Duration::from_secs(60),
        }
    }

    pub(super) fn bearer(&self) -> Option<&str> {
        self.bearer_at(Instant::now(), SystemTime::now())
    }

    fn bearer_at(&self, now: Instant, wall: SystemTime) -> Option<&str> {
        (!self.disconnected.load(Ordering::Acquire)
            && now < self.expires_at
            && wall < self.expires_wall)
            .then_some(self.access_token.as_str())
    }

    pub(super) fn expires_at(&self) -> Instant {
        self.expires_at
    }

    pub(super) fn disconnect(&self) {
        self.disconnected.store(true, Ordering::Release);
    }

    pub(super) fn revoke(&self) -> Result<(), Error> {
        self.revoke_with(&post)
    }

    fn revoke_with(&self, transport: &Post<'_>) -> Result<(), Error> {
        let token = self.revocation_token.as_ref().unwrap_or(&self.access_token);
        revoke_token(token, transport)
    }
}

fn revoke_token(token: &str, transport: &Post<'_>) -> Result<(), Error> {
    let response =
        transport(REVOCATION_ENDPOINT, &[("token", token)]).map_err(|_| Error::Revocation)?;
    (response.status == 200)
        .then_some(())
        .ok_or(Error::Revocation)
}

/// Call on a worker in response to Connect. The caller owns the cancellation flag.
pub(super) fn authorize(config: &ClientConfig, cancelled: &AtomicBool) -> Result<Session, Error> {
    authorize_with(
        config,
        cancelled,
        AUTHORIZATION_TIMEOUT,
        |url| {
            // This bounded variant observes quick launcher failures and reaps a slow child
            // in the background. On macOS, that_detached waits for the child to exit.
            open::that_detached_with_timeout(url.as_str(), BROWSER_FAILURE_CHECK)
                .map_err(|_| Error::Browser)
        },
        &post,
    )
}

fn authorize_with(
    config: &ClientConfig,
    cancelled: &AtomicBool,
    timeout: Duration,
    open_browser: impl FnOnce(&Url) -> Result<(), Error>,
    transport: &Post<'_>,
) -> Result<Session, Error> {
    check_cancelled(cancelled)?;
    let state = random_secret()?;
    let verifier = random_secret()?;
    let pending = callback::Pending::listen(timeout)?;
    let redirect = pending.redirect();
    let authorization = authorization_url(config, &redirect, &state, &verifier)?;
    check_cancelled(cancelled)?;
    let launch = open_browser(&authorization);
    check_cancelled(cancelled)?;
    launch?;
    let code = pending.receive(&state, cancelled)?;

    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("client_id", config.id.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("code", code.as_str()),
        ("code_verifier", verifier.as_str()),
    ];
    if let Some(secret) = &config.secret {
        form.push(("client_secret", secret.as_str()));
    }
    check_cancelled(cancelled)?;
    let requested_at = Instant::now();
    let requested_wall = SystemTime::now();
    let grant = transport(TOKEN_ENDPOINT, &form)
        .ok()
        .filter(|response| response.status == 200)
        .and_then(|response| IssuedGrant::parse(&response.body));
    if let Some(mut grant) = grant {
        if let Some(session) = grant.take_session(requested_at, requested_wall) {
            if check_cancelled(cancelled).is_ok() {
                return Ok(session);
            }
            session.revoke_with(transport)?;
        } else {
            // Credentials from the trusted token endpoint may still be revocable when
            // scope, expiry, or other session metadata does not meet Pear's requirements.
            grant.revoke(transport)?;
        }
    }
    check_cancelled(cancelled)?;
    Err(Error::Exchange)
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), Error> {
    if cancelled.load(Ordering::Acquire) {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}

fn random_secret() -> Result<Zeroizing<String>, Error> {
    let mut bytes = Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut *bytes).map_err(|_| Error::Unavailable)?;
    Ok(Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes.as_slice())))
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn authorization_url(
    config: &ClientConfig,
    redirect: &str,
    state: &str,
    verifier: &str,
) -> Result<Url, Error> {
    Url::parse_with_params(
        AUTHORIZATION_ENDPOINT,
        [
            ("response_type", "code"),
            ("client_id", config.id.as_str()),
            ("redirect_uri", redirect),
            ("scope", SCOPE),
            ("state", state),
            ("code_challenge", &pkce_challenge(verifier)),
            ("code_challenge_method", "S256"),
        ],
    )
    .map_err(|_| Error::Unavailable)
}

struct HttpResponse {
    status: u16,
    body: Zeroizing<Vec<u8>>,
}

type Post<'a> = dyn Fn(&str, &[(&str, &str)]) -> Result<HttpResponse, Error> + 'a;

fn post(endpoint: &str, form: &[(&str, &str)]) -> Result<HttpResponse, Error> {
    let agent = ureq::Agent::config_builder()
        .https_only(true)
        .proxy(None)
        .max_redirects(0)
        .timeout_connect(Some(Duration::from_secs(3)))
        .timeout_global(Some(Duration::from_secs(8)))
        .http_status_as_error(false)
        .tls_config(
            TlsConfig::builder()
                .provider(TlsProvider::NativeTls)
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .new_agent();
    let mut response = agent
        .post(endpoint)
        .send_form(form.iter().copied())
        .map_err(|_| Error::Exchange)?;
    let status = response.status().as_u16();
    let mut body = Zeroizing::new(Vec::new());
    if endpoint == TOKEN_ENDPOINT && status == 200 {
        response
            .body_mut()
            .as_reader()
            .take(MAX_TOKEN_BYTES + 1)
            .read_to_end(&mut body)
            .map_err(|_| Error::Exchange)?;
        if body.len() as u64 > MAX_TOKEN_BYTES {
            return Err(Error::Exchange);
        }
    }
    Ok(HttpResponse { status, body })
}

#[derive(Deserialize)]
struct TokenCredentials<'a> {
    #[serde(borrow)]
    access_token: Option<&'a RawValue>,
    #[serde(borrow)]
    refresh_token: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct SessionMetadata {
    scope: String,
    token_type: String,
    expires_in: u64,
}

struct IssuedGrant {
    access_token: Option<Zeroizing<String>>,
    refresh_token: Option<Zeroizing<String>>,
    metadata: Option<SessionMetadata>,
}

impl IssuedGrant {
    fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
            return None;
        }
        let credentials: TokenCredentials<'_> = serde_json::from_slice(bytes).ok()?;
        let read = |value: Option<&RawValue>| {
            serde_json::from_str::<String>(value?.get())
                .ok()
                .map(Zeroizing::new)
        };
        Some(Self {
            access_token: read(credentials.access_token).filter(|token| bearer_ascii(token)),
            refresh_token: read(credentials.refresh_token).filter(|token| visible_ascii(token)),
            metadata: serde_json::from_slice(bytes).ok(),
        })
    }

    fn take_session(&mut self, now: Instant, wall: SystemTime) -> Option<Session> {
        let metadata = self.metadata.as_ref()?;
        let mut scope = metadata.scope.split_ascii_whitespace();
        if scope.next() != Some(SCOPE)
            || scope.next().is_some()
            || !metadata.token_type.eq_ignore_ascii_case("bearer")
            || metadata.expires_in == 0
        {
            return None;
        }
        let duration = Duration::from_secs(metadata.expires_in);
        let expires_at = now.checked_add(duration)?;
        let expires_wall = wall.checked_add(duration)?;
        Some(Session {
            access_token: self.access_token.take()?,
            revocation_token: self.refresh_token.take(),
            disconnected: AtomicBool::new(false),
            expires_at,
            expires_wall,
        })
    }

    fn revoke(&self, transport: &Post<'_>) -> Result<(), Error> {
        if let Some(token) = self.refresh_token.as_ref().or(self.access_token.as_ref()) {
            revoke_token(token, transport)?;
        }
        Ok(())
    }
}

fn bearer_ascii(value: &str) -> bool {
    let token = value.trim_end_matches('=');
    !token.is_empty()
        && token.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'+' | b'/')
        })
}

fn visible_ascii(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_graphic())
}
