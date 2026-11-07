/// Hiroba signaling/state server.
///
/// Start-up sequence
/// ─────────────────
///   1. Init tracing (respects RUST_LOG env var).
///   2. Build the auth resolver + tenant registry; in guest mode pre-seed its org
///      (self-host single tenant, lobby + a default team space).
///   3. Spawn the tick loop (per-space position broadcast + proximity, ~12 Hz,
///      across every tenant).
///   4. Build an axum Router with:
///      - GET /health → "ok"
///      - GET /ice    → ICE/TURN config (STUN + short-lived TURN credentials)
///      - GET /ws     → WebSocket upgrade
///   5. Bind on HIROBA_ADDR (default 0.0.0.0:8787) and serve until Ctrl-C / SIGTERM.
use std::env;
use std::sync::Arc;

use axum::{
    extract::{State, WebSocketUpgrade},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use hiroba_common::cors_from_env;
use tracing::{debug, error, info, warn};

mod allowance;
mod auth;
mod beacon;
mod billing;
mod ice;
mod outbox;
mod protocol;
mod proximity;
mod registry;
mod state;
mod store;
mod ws;

use allowance::Allowances;
use auth::Auth;
use beacon::GuestBeacon;
use billing::BillingGate;
use ice::IceIssuer;
use registry::OrgRegistry;

// ---------------------------------------------------------------------------
// App state shared across handlers
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct AppState {
    registry: OrgRegistry,
    auth: Arc<Auth>,
    ice: IceIssuer,
    /// `/ice` issuances per account and per client address — see
    /// [`ice_handler`].
    ice_by_sub: Arc<Allowances>,
    ice_by_ip: Arc<Allowances>,
    /// Billing lock check, or `None` when billing enforcement is off (self-host).
    billing: Option<Arc<BillingGate>>,
    /// Guest-exit reporter, or `None` when unconfigured (self-host).
    beacon: Option<Arc<GuestBeacon>>,
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// Liveness probe: GET /health → 200 "ok"
async fn health() -> &'static str {
    "ok"
}

/// `/ice` issuances an hour (and in one burst). A client asks once per connect
/// and again at the credential's half-life, so an account needs a handful even
/// on a flaky network; an address is roomier, for an office behind one NAT.
const ICE_PER_SUB_PER_HOUR: f64 = 20.0;
const ICE_PER_IP_PER_HOUR: f64 = 100.0;

/// ICE/TURN config: GET /ice → `{ iceServers: [...] }` (NFR-07, §7.4). Returns
/// STUN always, plus TURN entries with freshly minted short-lived credentials
/// when a relay is configured. Delivered out-of-band over HTTP, never the WS.
async fn ice_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let token = bearer_token(&headers);
    let identity = match state.auth.resolve(token).await {
        Ok(identity) => identity,
        Err(err) => {
            debug!(reason = %err, "ICE config rejected");
            return StatusCode::UNAUTHORIZED.into_response();
        }
    };
    // Each call mints a relay credential that works from any TURN client for
    // its whole lifetime, and anyone the public demo admits can call: cap how
    // many one account, and one address, can collect. A client turned away
    // carries on with STUN.
    let ip = client_ip(&headers);
    let sub = identity.sub.as_deref();
    if !sub.is_none_or(|sub| state.ice_by_sub.take(sub))
        || !ip.is_none_or(|ip| state.ice_by_ip.take(ip))
    {
        warn!(org = %identity.org_id, sub = sub.unwrap_or("-"), ip = ip.unwrap_or("-"), "ICE issuance limit reached");
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    match state.ice.issue().await {
        Ok(cfg) => {
            // Who holds which relay credential: what a revocation needs.
            let relay_user = cfg.ice_servers.iter().find_map(|s| s.username.as_deref());
            info!(
                org = %identity.org_id,
                sub = sub.unwrap_or("-"),
                ip = ip.unwrap_or("-"),
                relay_user = relay_user.unwrap_or("-"),
                "ICE config issued"
            );
            Json(cfg).into_response()
        }
        Err(err) => {
            error!(error = %err, "ICE config issuance failed");
            StatusCode::BAD_GATEWAY.into_response()
        }
    }
}

/// WebSocket upgrade: GET /ws
async fn ws_handler(
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let ip = client_ip(&headers).unwrap_or("-");
    let ua = headers
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-");
    tracing::info!(ip = %ip, ua = %ua, "ws upgrade");
    upgrade
        .max_message_size(ws::MAX_MESSAGE_BYTES)
        .max_frame_size(ws::MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| {
            ws::handle_ws(
                socket,
                state.registry,
                state.auth,
                state.billing,
                state.beacon,
            )
        })
}

/// The caller's address, where the edge reports it. Fly terminates TLS at the
/// edge, so the TCP peer is always fly-proxy; `fly-client-ip` is the only place
/// the real origin survives. Absent off Fly (a self-host without that edge).
fn client_ip(headers: &HeaderMap) -> Option<&str> {
    headers.get("fly-client-ip").and_then(|v| v.to_str().ok())
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?.trim();
    value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    // ── Tracing ──────────────────────────────────────────────────────────
    // Default to INFO level; operators can override with RUST_LOG=debug etc.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // ── Auth + tenant registry ─────────────────────────────────────────────
    // `auth` resolves each connection's `hello` token to a tenant + identity:
    //   - guest (default): the single configured org, no accounts (self-host);
    //   - jwt/oidc: a verified token picks the tenant per its `org` claim (§9).
    let auth = Arc::new(Auth::from_env());

    // Billing lock enforcement: on when HIROBA_BILLING_STATUS_URL points at
    // the auth backend's /billing/status; off (no-op) for self-host.
    let billing = BillingGate::from_env().map(Arc::new);

    // Guest-exit reporting: on when HIROBA_GUEST_BEACON_URL/SECRET point at
    // the update worker's /guest/left; off (no-op) for self-host.
    let beacon = GuestBeacon::from_env().map(Arc::new);

    // ── Persistence (§7.5) ─────────────────────────────────────────────────
    // HIROBA_DB=<path> persists the org registry + space catalogs (SQLite).
    // Unset → DB-less profile: everything in memory, exactly as before.
    let registry = match env::var("HIROBA_DB") {
        Ok(path) => {
            let store = Arc::new(store::Store::open(std::path::Path::new(&path)));
            let catalogs = store.load_all();
            info!(path = %path, orgs = catalogs.len(), "persistence enabled");
            OrgRegistry::with_store(store, catalogs)
        }
        Err(_) => OrgRegistry::new(),
    };

    // Guest mode is the single-tenant path: pre-seed its org so an operator's
    // floor exists before the first guest connects. With JWT/OIDC auth every
    // tenant is named by a token and created on its first connection.
    if let Auth::Guest { org_id } = auth.as_ref() {
        let org_name = env::var("HIROBA_ORG_NAME").unwrap_or_else(|_| "Ludo".to_string());
        registry.seed(org_id.clone(), org_name).await;
    }

    // ── ICE/TURN issuer ────────────────────────────────────────────────────
    let ice = IceIssuer::from_env();

    // The tick loop runs for the entire server lifetime, ticking every tenant.
    // It is the only place that owns proximity hysteresis state, so no extra
    // locking is needed.
    ws::spawn_tick_loop(registry.clone());

    info!(
        auth = auth.mode(),
        turn = ice.has_turn(),
        billing = billing.is_some(),
        guest_beacon = beacon.is_some(),
        "auth + ICE configured"
    );

    // ── Router ───────────────────────────────────────────────────────────
    // CORS: locked down to the origins in `HIROBA_CORS_ALLOW_ORIGINS`
    // (comma-separated) when set; a malformed entry aborts startup
    // (fail-closed). Unset falls back to permissive `Any` for the
    // dev/self-host default where a Tauri webview reaches us directly.
    // See SELF_HOSTING.md §4 — desktop builds need the Tauri webview
    // origins in the list or `GET /ice` is blocked by the webview.
    let cors = cors_from_env("HIROBA_CORS_ALLOW_ORIGINS");

    let app = Router::new()
        .route("/health", get(health))
        .route("/ice", get(ice_handler))
        .route("/ws", get(ws_handler))
        .layer(cors)
        .with_state(AppState {
            registry,
            auth,
            ice,
            ice_by_sub: Arc::new(Allowances::new(
                ICE_PER_SUB_PER_HOUR,
                ICE_PER_SUB_PER_HOUR / 3600.0,
            )),
            ice_by_ip: Arc::new(Allowances::new(
                ICE_PER_IP_PER_HOUR,
                ICE_PER_IP_PER_HOUR / 3600.0,
            )),
            billing,
            beacon,
        });

    // ── Bind address ─────────────────────────────────────────────────────
    let addr = env::var("HIROBA_ADDR").unwrap_or_else(|_| "0.0.0.0:8787".to_string());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {addr}: {e}"));

    info!(addr = %addr, "hiroba-server listening");

    // ── Serve (graceful shutdown on Ctrl-C / SIGTERM) ────────────────────
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

/// Resolves on Ctrl-C or SIGTERM. SIGTERM is what `docker stop`, systemd and
/// every orchestrator send first; ignoring it means sitting out their grace
/// period and then being SIGKILLed.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl-C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
    info!("shutdown signal received");
}
