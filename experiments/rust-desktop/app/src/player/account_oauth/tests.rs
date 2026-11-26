use std::{cell::Cell, collections::HashMap, io::Write, net::TcpStream};

use super::callback::{Callback, callback_payload};
use super::*;

fn config() -> ClientConfig {
    ClientConfig::parse(
        br#"{"installed":{
      "client_id":"123-test.apps.googleusercontent.com",
      "client_secret":"synthetic"
    }}"#,
    )
    .expect("synthetic desktop config")
}

#[test]
fn config_requires_the_installed_client_and_ignores_endpoint_overrides() {
    let config = ClientConfig::parse(
        br#"{"installed":{
        "client_id":"123-test.apps.googleusercontent.com",
        "client_secret":"synthetic",
        "auth_uri":"https://somewhere.invalid",
        "token_uri":"https://somewhere.invalid",
        "redirect_uris":["http://localhost"]
    }}"#,
    )
    .expect("synthetic desktop configuration");
    let url = authorization_url(
        &config,
        "http://127.0.0.1:12345/",
        "random-state",
        "test-verifier",
    )
    .unwrap();
    assert_eq!(
        url.origin().ascii_serialization(),
        "https://accounts.google.com"
    );
    assert_eq!(url.path(), "/o/oauth2/v2/auth");
    let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(query["scope"], SCOPE);
    assert_eq!(query["redirect_uri"], "http://127.0.0.1:12345/");
    assert_eq!(query["code_challenge_method"], "S256");
    assert!(!query.contains_key("client_secret"));
    for invalid in [
        r#"{"web":{"client_id":"123-test.apps.googleusercontent.com"}}"#,
        r#"{"installed":{"client_id":"invalid.example"}}"#,
        r#"{"installed":["123-test.apps.googleusercontent.com"]}"#,
        r#"{"installed":{"client_id":"123-test.apps.googleusercontent.com","client_id":"456-test.apps.googleusercontent.com"}}"#,
    ] {
        assert!(ClientConfig::parse(invalid.as_bytes()).is_none());
    }
}

#[test]
fn pkce_uses_unpadded_base64url_sha256() {
    let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    assert_eq!(
        pkce_challenge(verifier),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
}

#[test]
fn only_a_single_matching_state_and_one_callback_result_are_valid() {
    let request = |method: &str, target: &str, host: &str| {
        callback_payload(
            format!("{method} {target} HTTP/1.1\r\nHost: {host}\r\n\r\n").as_bytes(),
            "127.0.0.1:12345",
            "expected",
        )
    };
    let host = "127.0.0.1:12345";
    assert!(matches!(
        request("GET", "/?state=expected&code=synthetic%2Fcode", host),
        Some(Callback::Code(code)) if code.as_str() == "synthetic/code"
    ));
    assert!(matches!(
        request("GET", "/?state=expected&error=access_denied", host),
        Some(Callback::Denied)
    ));
    for target in [
        "/",
        "/elsewhere?state=expected&code=1",
        "//other/?state=expected&code=1",
        "/?state=bad&code=1",
        "/?state=expected&%73tate=expected&code=1",
        "/?state=expected&code=1&code=2",
        "/?state=expected&code=1&error=access_denied",
        "/?state=expected&code=%00",
    ] {
        assert!(request("GET", target, host).is_none(), "{target}");
    }
    assert!(request("POST", "/?state=expected&code=1", host).is_none());
    assert!(request("GET", "/?state=expected&code=1", "localhost:12345").is_none());
}

fn parse_session(bytes: &[u8], now: Instant, wall: SystemTime) -> Option<Session> {
    IssuedGrant::parse(bytes)?.take_session(now, wall)
}

#[test]
fn session_requires_readonly_bearer_scope_and_expires_at_the_service_deadline() {
    let now = Instant::now();
    let wall = SystemTime::now();
    let response = |scope: &str, kind: &str, seconds: u64| {
        format!(
            r#"{{"access_token":"example-token","refresh_token":"example-refresh","scope":"{scope}","token_type":"{kind}","expires_in":{seconds}}}"#
        )
    };
    let bytes = response(SCOPE, "Bearer", 60);
    let session = parse_session(bytes.as_bytes(), now, wall).expect("valid token");
    assert_eq!(session.bearer_at(now, wall), Some("example-token"));
    assert_eq!(session.bearer_at(now + Duration::from_secs(60), wall), None);
    assert_eq!(session.bearer_at(now, wall + Duration::from_secs(60)), None);
    for bytes in [
        response("https://www.googleapis.com/auth/youtube", "Bearer", 60),
        response(SCOPE, "invalid", 60),
        response(SCOPE, "Bearer", 0),
    ] {
        assert!(parse_session(bytes.as_bytes(), now, wall).is_none());
    }
}

fn browser_callback(url: &Url, query: &[(&str, &str)]) -> TcpStream {
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    let mut redirect = Url::parse(&params["redirect_uri"]).unwrap();
    redirect.query_pairs_mut().extend_pairs(query);
    let address = (redirect.host_str().unwrap(), redirect.port().unwrap());
    assert_eq!(address.0, "127.0.0.1");
    let mut connection = TcpStream::connect(address).unwrap();
    write!(
        connection,
        "GET /?{} HTTP/1.1\r\nHost: {}:{}\r\n\r\n",
        redirect.query().unwrap(),
        address.0,
        address.1
    )
    .unwrap();
    connection
}

fn mock_token() -> HttpResponse {
    HttpResponse {
        status: 200,
        body: Zeroizing::new(format!(
            r#"{{"access_token":"mock-access","refresh_token":"mock-revoke","scope":"{SCOPE}","token_type":"Bearer","expires_in":60}}"#
        ).into_bytes()),
    }
}

#[test]
fn synthetic_browser_state_and_exchange_match_and_listener_closes_after_use() {
    let redirect = std::cell::OnceCell::new();
    let challenge = std::cell::OnceCell::new();
    let count = Cell::new(0);
    let transport = |endpoint: &str, form: &[(&str, &str)]| {
        count.set(count.get() + 1);
        assert_eq!(endpoint, TOKEN_ENDPOINT);
        let form: HashMap<_, _> = form.iter().copied().collect();
        assert_eq!(form["grant_type"], "authorization_code");
        assert_eq!(form["client_secret"], "synthetic");
        assert_eq!(form["client_id"], "123-test.apps.googleusercontent.com");
        assert_eq!(form["redirect_uri"], redirect.get().unwrap());
        assert_eq!(form["code"], "synthetic-code");
        assert_eq!(
            pkce_challenge(form["code_verifier"]),
            *challenge.get().unwrap()
        );
        Ok(mock_token())
    };
    let session = authorize_with(
        &config(),
        &AtomicBool::new(false),
        Duration::from_secs(3),
        |url| {
            let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
            redirect.set(params["redirect_uri"].clone()).unwrap();
            challenge.set(params["code_challenge"].clone()).unwrap();
            assert_eq!(params["state"].len(), 43);
            browser_callback(url, &[("state", "wrong"), ("code", "wrong")]);
            browser_callback(
                url,
                &[("state", &params["state"]), ("code", "synthetic-code")],
            );
            Ok(())
        },
        &transport,
    )
    .unwrap();
    assert_eq!(session.bearer(), Some("mock-access"));
    assert!(session.expires_at() > Instant::now());
    assert_eq!(count.get(), 1);
    let url = Url::parse(redirect.get().unwrap()).unwrap();
    assert!(TcpStream::connect(("127.0.0.1", url.port().unwrap())).is_err());
}

#[test]
fn cancellation_and_timeout_do_not_exchange_a_code() {
    let cancelled = AtomicBool::new(false);
    let transport = |_: &str, _: &[(&str, &str)]| panic!("unexpected token exchange");
    let result = authorize_with(
        &config(),
        &cancelled,
        Duration::from_secs(3),
        |url| {
            let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
            browser_callback(
                url,
                &[("state", &params["state"]), ("code", "cancelled-code")],
            );
            cancelled.store(true, Ordering::Release);
            Ok(())
        },
        &transport,
    );
    assert_eq!(result.err(), Some(Error::Cancelled));

    let result = authorize_with(
        &config(),
        &AtomicBool::new(false),
        Duration::from_millis(40),
        |_| Ok(()),
        &transport,
    );
    assert_eq!(result.err(), Some(Error::Timeout));
}

#[test]
fn cancelling_during_exchange_revokes_the_returned_grant_without_reusing_it() {
    let cancelled = AtomicBool::new(false);
    let revoked = Cell::new(false);
    let transport = |endpoint: &str, form: &[(&str, &str)]| {
        if endpoint == TOKEN_ENDPOINT {
            cancelled.store(true, Ordering::Release);
            Ok(mock_token())
        } else {
            assert_eq!(endpoint, REVOCATION_ENDPOINT);
            assert_eq!(form, &[("token", "mock-revoke")]);
            revoked.set(true);
            Ok(HttpResponse {
                status: 200,
                body: Zeroizing::new(Vec::new()),
            })
        }
    };
    let result = authorize_with(
        &config(),
        &cancelled,
        Duration::from_secs(3),
        |url| {
            let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
            browser_callback(url, &[("state", &params["state"]), ("code", "synthetic")]);
            Ok(())
        },
        &transport,
    );
    assert_eq!(result.err(), Some(Error::Cancelled));
    assert!(revoked.get());
}

#[test]
fn disconnect_uses_the_access_token_if_no_refresh_token_was_returned() {
    let mut session = parse_session(&mock_token().body, Instant::now(), SystemTime::now()).unwrap();
    session.revocation_token = None;
    let transport = |endpoint: &str, form: &[(&str, &str)]| {
        assert_eq!(endpoint, REVOCATION_ENDPOINT);
        assert_eq!(form, &[("token", "mock-access")]);
        Ok(HttpResponse {
            status: 503,
            body: Zeroizing::new(b"untrusted error".to_vec()),
        })
    };
    assert_eq!(session.revoke_with(&transport), Err(Error::Revocation));
}

#[test]
fn a_delayed_launcher_error_does_not_override_cancel() {
    let cancelled = AtomicBool::new(false);
    let result = authorize_with(
        &config(),
        &cancelled,
        Duration::from_secs(1),
        |_| {
            cancelled.store(true, Ordering::Release);
            Err(Error::Browser)
        },
        &|_, _| panic!("unexpected token exchange"),
    );
    assert_eq!(result.err(), Some(Error::Cancelled));
}

#[test]
fn a_late_launch_cannot_extend_the_callback_deadline() {
    let result = authorize_with(
        &config(),
        &AtomicBool::new(false),
        Duration::from_millis(10),
        |url| {
            std::thread::sleep(Duration::from_millis(30));
            let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
            browser_callback(url, &[("state", &params["state"]), ("code", "late")]);
            Ok(())
        },
        &|_, _| panic!("unexpected token exchange"),
    );
    assert_eq!(result.err(), Some(Error::Timeout));
}

#[test]
fn failed_revocation_during_cancel_requires_manual_removal() {
    let cancelled = AtomicBool::new(false);
    let result = authorize_with(
        &config(),
        &cancelled,
        Duration::from_secs(3),
        |url| {
            let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
            browser_callback(url, &[("state", &params["state"]), ("code", "synthetic")]);
            Ok(())
        },
        &|endpoint, form| {
            if endpoint == TOKEN_ENDPOINT {
                cancelled.store(true, Ordering::Release);
                Ok(mock_token())
            } else {
                assert_eq!(endpoint, REVOCATION_ENDPOINT);
                assert_eq!(form, &[("token", "mock-revoke")]);
                Err(Error::Exchange)
            }
        },
    );
    assert_eq!(result.err(), Some(Error::Revocation));
    assert!(
        Error::Revocation
            .message()
            .contains("Google Account permissions")
    );
}

#[cfg(unix)]
#[test]
fn config_opener_uses_a_nonblocking_descriptor_and_rejects_nonregular_files() {
    use std::{fs, os::fd::AsRawFd};

    let root = std::env::temp_dir().join(format!("pear-oauth-test-{}", fastrand::u64(..)));
    fs::create_dir(&root).unwrap();
    struct Fixture(std::path::PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let fixture = Fixture(root);
    let file = fixture.0.join("client.json");
    fs::write(
        &file,
        br#"{"installed":{"client_id":"test.apps.googleusercontent.com"}}"#,
    )
    .unwrap();

    let opened = ClientConfig::open_file(&file).unwrap();
    // SAFETY: the descriptor is valid and F_GETFL does not take a third argument.
    let flags = unsafe { libc::fcntl(opened.as_raw_fd(), libc::F_GETFL) };
    assert_ne!(flags, -1);
    assert_ne!(flags & libc::O_NONBLOCK, 0);
    assert!(ClientConfig::read_file(&file).is_ok());
    assert!(matches!(
        ClientConfig::open_file(&fixture.0),
        Err(Error::Config)
    ));
}

fn reject_mock_grant(
    body: &[u8],
    cancel_during_exchange: bool,
    revocation_status: u16,
    expected_candidate: &str,
) -> Error {
    let cancelled = AtomicBool::new(false);
    let revoked = Cell::new(0);
    let result = authorize_with(
        &config(),
        &cancelled,
        Duration::from_secs(3),
        |url| {
            let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
            browser_callback(url, &[("state", &params["state"]), ("code", "synthetic")]);
            Ok(())
        },
        &|endpoint, form| {
            if endpoint == TOKEN_ENDPOINT {
                cancelled.store(cancel_during_exchange, Ordering::Release);
                Ok(HttpResponse {
                    status: 200,
                    body: Zeroizing::new(body.to_vec()),
                })
            } else {
                assert_eq!(endpoint, REVOCATION_ENDPOINT);
                assert_eq!(form, &[("token", expected_candidate)]);
                revoked.set(revoked.get() + 1);
                Ok(HttpResponse {
                    status: revocation_status,
                    body: Zeroizing::new(b"untrusted provider response".to_vec()),
                })
            }
        },
    );
    assert_eq!(revoked.get(), 1);
    result.err().expect("the grant must not open a session")
}

#[test]
fn rejecting_an_unexpected_scope_revokes_the_issued_grant() {
    let body = format!(
        r#"{{"access_token":"mock-access","refresh_token":"mock-revoke","scope":"{SCOPE} https://www.googleapis.com/auth/youtube","token_type":"Bearer","expires_in":60}}"#,
    );
    for (cancelled, error) in [(false, Error::Exchange), (true, Error::Cancelled)] {
        assert_eq!(
            reject_mock_grant(body.as_bytes(), cancelled, 200, "mock-revoke"),
            error,
        );
    }
}

#[test]
fn cancellation_revokes_an_issued_grant_with_invalid_session_metadata() {
    let body = br#"{"access_token":"mock-access","refresh_token":"invalid token","scope":[],"token_type":"Bearer","expires_in":60}"#;
    assert_eq!(
        reject_mock_grant(body, true, 200, "mock-access"),
        Error::Cancelled,
    );
}

#[test]
fn revocation_failure_for_a_rejected_grant_requests_manual_removal() {
    let body = br#"{"refresh_token":"mock-revoke","access_token":42}"#;
    for cancelled in [false, true] {
        let error = reject_mock_grant(body, cancelled, 503, "mock-revoke");
        assert_eq!(error, Error::Revocation);
        assert!(error.message().contains("Google Account permissions"));
    }
}
