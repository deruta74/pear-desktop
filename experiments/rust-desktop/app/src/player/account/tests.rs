use super::*;

fn panel() -> Panel {
    Panel::configured(oauth::ClientConfig::fixture())
}

fn item(id: &str, title: &str, attribution: Option<&str>) -> catalog::Item {
    catalog::Item {
        id: id.into(),
        title: title.into(),
        attribution: attribution.map(str::to_owned),
    }
}

fn state(panel: &Panel) -> serde_json::Value {
    serde_json::to_value(panel.view()).unwrap()
}

fn sign_in(panel: &mut Panel) -> (Job, Instant) {
    let authorize = panel.apply(Command::ConnectAccount {}).unwrap();
    let session = oauth::Session::fixture();
    let expires = session.expires_at();
    let (first_page, _) = panel.receive(authorize.stamp, Outcome::Authorized(Ok(session)));
    (first_page.unwrap(), expires)
}

#[test]
fn exposes_only_display_rows_and_uses_the_current_rust_owned_page_token() {
    let mut panel = panel();
    let (first_page, _) = sign_in(&mut panel);
    let JobKind::Fetch { query, .. } = first_page.kind else {
        panic!("expected the owned playlist request after sign-in");
    };
    assert_eq!(query.collection, catalog::Collection::OwnedPlaylists);
    assert_eq!(query.token, None);
    let mut response = catalog::Page {
        items: vec![item("PLprivate", "My favourites", Some("Private name"))],
        next_page_token: Some("provider-page-token".into()),
    };
    assert!(
        !panel
            .receive(
                first_page.stamp + 1,
                Outcome::Page(Ok(catalog::Page {
                    items: vec![],
                    next_page_token: None,
                }))
            )
            .1
    );
    assert!(
        panel
            .receive(first_page.stamp, Outcome::Page(Ok(response)))
            .1
    );
    let display = state(&panel);
    assert_eq!(
        display["rows"],
        serde_json::json!([{"title": "My favourites"}])
    );
    assert_eq!(display["page"], first_page.stamp);
    assert_eq!(display["hasNext"], true);
    let serialized = display.to_string();
    for private in [
        "mock-access",
        "PLprivate",
        "Private name",
        "provider-page-token",
    ] {
        assert!(!serialized.contains(private));
    }
    assert!(
        panel
            .apply(Command::NextAccountPage {
                page: first_page.stamp + 1
            })
            .is_none()
    );
    let next = panel
        .apply(Command::NextAccountPage {
            page: first_page.stamp,
        })
        .unwrap();
    let JobKind::Fetch { query, .. } = next.kind else {
        panic!("expected pagination");
    };
    assert_eq!(query.token.as_deref(), Some("provider-page-token"));
    assert!(state(&panel)["rows"].is_null());
    response = catalog::Page {
        items: vec![],
        next_page_token: None,
    };
    assert!(panel.receive(next.stamp, Outcome::Page(Ok(response))).1);
    assert_eq!(state(&panel)["message"], "No playlists on this page.");
}

#[test]
fn opens_only_videos_from_the_current_page_and_clears_on_disconnect() {
    let mut panel = panel();
    let (playlists, _) = sign_in(&mut panel);
    panel.receive(
        playlists.stamp,
        Outcome::Page(Ok(catalog::Page {
            items: vec![item("PLprivate", "My favourites", None)],
            next_page_token: None,
        })),
    );
    assert!(
        panel
            .apply(Command::OpenAccountVideo {
                page: playlists.stamp,
                row: 0
            })
            .is_none()
    );
    let items = panel
        .apply(Command::OpenAccountPlaylist {
            page: playlists.stamp,
            row: 0,
        })
        .unwrap();
    let JobKind::Fetch { query, .. } = items.kind else {
        panic!("expected a playlist request");
    };
    assert_eq!(
        query.collection,
        catalog::Collection::PlaylistItems("PLprivate".into())
    );
    panel.receive(
        items.stamp,
        Outcome::Page(Ok(catalog::Page {
            items: vec![item("M7lc1UVf-VE", "A track", Some("Creator"))],
            next_page_token: None,
        })),
    );
    assert_eq!(state(&panel)["title"], "My favourites");
    assert!(
        panel
            .apply(Command::OpenAccountVideo {
                page: playlists.stamp,
                row: 0
            })
            .is_none()
    );
    assert!(
        panel
            .apply(Command::OpenAccountVideo {
                page: items.stamp,
                row: 1
            })
            .is_none()
    );
    let open = panel
        .apply(Command::OpenAccountVideo {
            page: items.stamp,
            row: 0,
        })
        .unwrap();
    let JobKind::Open(url) = open.kind else {
        panic!("expected an official video link");
    };
    assert_eq!(url, "https://www.youtube.com/watch?v=M7lc1UVf-VE");
    let in_flight = panel
        .apply(Command::ShowAccountCollection {
            collection: TopLevel::LikedVideos,
        })
        .unwrap();
    let JobKind::Fetch { session, query } = in_flight.kind else {
        panic!("expected the liked videos request");
    };
    assert_eq!(query.collection, catalog::Collection::LikedVideos);
    assert!(session.bearer().is_some());
    let disconnect = panel.apply(Command::DisconnectAccount {}).unwrap();
    assert!(session.bearer().is_none());
    assert!(matches!(disconnect.kind, JobKind::Revoke(_)));
    let display = state(&panel);
    assert_eq!(display["status"], "disconnecting");
    assert!(display["rows"].is_null());
    assert!(display["title"].is_null());
    assert!(
        !panel
            .receive(
                in_flight.stamp,
                Outcome::Page(Err(catalog::Error::Forbidden))
            )
            .1
    );
    panel.receive(
        disconnect.stamp,
        Outcome::Revoked(Err(oauth::Error::Revocation)),
    );
    assert_eq!(state(&panel)["status"], "disconnected");
    assert!(
        state(&panel)["message"]
            .as_str()
            .unwrap()
            .contains("Google Account permissions")
    );
}

#[test]
fn revokes_a_session_that_arrives_after_cancellation_before_showing_any_rows() {
    let mut panel = panel();
    let authorize = panel.apply(Command::ConnectAccount {}).unwrap();
    let JobKind::Authorize { cancelled, .. } = authorize.kind else {
        panic!("expected an authorization attempt");
    };
    assert!(panel.apply(Command::ConnectAccount {}).is_none());
    assert!(panel.apply(Command::CancelAccount {}).is_none());
    assert!(cancelled.load(Ordering::Acquire));
    assert_eq!(state(&panel)["status"], "cancelling");
    let (revoke, changed) = panel.receive(
        authorize.stamp,
        Outcome::Authorized(Ok(oauth::Session::fixture())),
    );
    assert!(changed);
    let revoke = revoke.unwrap();
    assert!(matches!(revoke.kind, JobKind::Revoke(_)));
    assert_eq!(state(&panel)["status"], "cancelling");
    panel.receive(revoke.stamp, Outcome::Revoked(Ok(())));
    assert_eq!(state(&panel)["status"], "disconnected");
    assert_eq!(state(&panel)["message"], oauth::Error::Cancelled.message());
}

#[test]
fn expires_and_rejects_stale_results_and_commands() {
    let mut panel = panel();
    let (first_page, expires) = sign_in(&mut panel);
    assert_eq!(panel.deadline(), Some(expires));
    assert!(!panel.expire(expires - Duration::from_millis(1)));
    assert!(panel.expire(expires));
    assert!(
        !panel
            .receive(
                first_page.stamp,
                Outcome::Page(Ok(catalog::Page {
                    items: vec![item("PLprivate", "Hidden", None)],
                    next_page_token: None,
                }))
            )
            .1
    );
    assert!(
        panel
            .apply(Command::OpenAccountPlaylist {
                page: first_page.stamp,
                row: 0
            })
            .is_none()
    );
    assert_eq!(state(&panel)["status"], "disconnected");
    assert_eq!(
        state(&panel)["message"],
        "Your YouTube session expired. Connect again."
    );
}

#[test]
fn retry_preserves_catalog_cursor_and_unauthorized_clears_the_session() {
    let mut panel = panel();
    let (first_page, _) = sign_in(&mut panel);
    panel.receive(
        first_page.stamp,
        Outcome::Page(Ok(catalog::Page {
            items: vec![],
            next_page_token: Some("opaque-cursor".into()),
        })),
    );
    let next = panel
        .apply(Command::NextAccountPage {
            page: first_page.stamp,
        })
        .unwrap();
    panel.receive(
        next.stamp,
        Outcome::Page(Err(catalog::Error::QuotaExceeded)),
    );
    let display = state(&panel);
    assert_eq!(display["retry"], true);
    assert!(display["message"].as_str().unwrap().contains("quota"));
    let retry = panel.apply(Command::RetryAccountPage {}).unwrap();
    let JobKind::Fetch { query, .. } = retry.kind else {
        panic!("expected a retry of the same request");
    };
    assert_eq!(query.token.as_deref(), Some("opaque-cursor"));
    panel.receive(
        retry.stamp,
        Outcome::Page(Err(catalog::Error::Unauthorized)),
    );
    let display = state(&panel);
    assert_eq!(display["status"], "disconnected");
    assert!(display["rows"].is_null());
    assert!(display["retry"].is_null());
}

#[test]
fn quit_during_sign_in_waits_for_a_late_grant_to_be_revoked() {
    let mut panel = panel();
    let authorization = panel.apply(Command::ConnectAccount {}).unwrap();
    let JobKind::Authorize { cancelled, .. } = authorization.kind else {
        panic!("expected pending authorization");
    };
    let now = Instant::now();
    let deadline = panel
        .begin_shutdown(now)
        .expect("quit must wait for authorization");
    assert!(cancelled.load(Ordering::Acquire));
    assert_eq!(
        panel.shutdown_status(deadline, now),
        ShutdownStatus::Waiting
    );
    assert_eq!(
        panel.shutdown_status(deadline, deadline),
        ShutdownStatus::TimedOut
    );
    let (revoke, _) = panel.receive(
        authorization.stamp,
        Outcome::Authorized(Ok(oauth::Session::fixture())),
    );
    let revoke = revoke.expect("the late grant must be revoked");
    assert!(matches!(revoke.kind, JobKind::Revoke(_)));
    assert_eq!(
        panel.shutdown_status(deadline, now),
        ShutdownStatus::Waiting
    );
    panel.receive(revoke.stamp, Outcome::Revoked(Ok(())));
    assert_eq!(
        panel.shutdown_status(deadline, now),
        ShutdownStatus::Finished
    );
}

#[test]
fn quit_during_disconnect_waits_and_reports_a_failed_revocation() {
    let mut panel = panel();
    sign_in(&mut panel);
    let revoke = panel.apply(Command::DisconnectAccount {}).unwrap();
    let now = Instant::now();
    let deadline = panel
        .begin_shutdown(now)
        .expect("quit must wait for disconnect");
    assert_eq!(
        panel.shutdown_status(deadline, now),
        ShutdownStatus::Waiting
    );
    panel.receive(
        revoke.stamp,
        Outcome::Revoked(Err(oauth::Error::Revocation)),
    );
    assert_eq!(
        panel.shutdown_status(deadline, now),
        ShutdownStatus::RevocationFailed
    );
}

#[test]
fn regular_quit_clears_connected_account_access_locally() {
    let mut panel = panel();
    let (page, _) = sign_in(&mut panel);
    let JobKind::Fetch { session, .. } = page.kind else {
        panic!("expected a catalog fetch");
    };
    assert!(session.bearer().is_some());
    assert_eq!(panel.begin_shutdown(Instant::now()), None);
    assert!(session.bearer().is_none());
    assert_eq!(state(&panel)["status"], "disconnected");
}
