/// Hiroba signaling/state server.
///
/// Start-up sequence
/// ─────────────────
///   1. Init tracing (respects RUST_LOG env var).
///   2. Build the auth resolver + tenant registry; pre-seed the configured org
///      (self-host single tenant, lobby + a default team space).
///   3. Spawn the tick loop (per-space position broadcast + proximity, ~12 Hz,
///      across every tenant).
///   4. Build an axum Router with:
///      - GET /health → "ok"
///      - GET /ice    → ICE/TURN config (STUN + short-lived TURN credentials)
///      - GET /ws     → WebSocket upgrade
///   5. Bind on HIROBA_ADDR (default 0.0.0.0:8787) and serve until Ctrl-C.
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
use tracing::{debug, info};

mod auth;
mod billing;
mod ice;
mod protocol;
mod proximity;
mod registry;
mod state;
mod store;
mod ws;

use auth::Auth;
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
    /// Billing lock check, or `None` when billing enforcement is off (self-host).
    billing: Option<Arc<BillingGate>>,
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// Liveness probe: GET /health → 200 "ok"
async fn health() -> &'static str {
    "ok"
}

/// ICE/TURN config: GET /ice → `{ iceServers: [...] }` (NFR-07, §7.4). Returns
/// STUN always, plus TURN entries with freshly minted short-lived credentials
/// when a relay is configured. Delivered out-of-band over HTTP, never the WS.
async fn ice_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let token = bearer_token(&headers);
    match state.auth.resolve(token).await {
        Ok(_) => Json(state.ice.issue()).into_response(),
        Err(err) => {
            debug!(reason = %err, "ICE config rejected");
            StatusCode::UNAUTHORIZED.into_response()
        }
    }
}

/// WebSocket upgrade: GET /ws
async fn ws_handler(upgrade: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    upgrade
        .on_upgrade(move |socket| ws::handle_ws(socket, state.registry, state.auth, state.billing))
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

    // Self-host single-tenant path: pre-seed the configured org so an operator's
    // floor exists before the first guest connects. Hosted tenants are created
    // lazily on first authenticated connection.
    let org_id = env::var("HIROBA_ORG").unwrap_or_else(|_| "ludo".to_string());
    let org_name = env::var("HIROBA_ORG_NAME").unwrap_or_else(|_| "Ludo".to_string());
    registry.seed(org_id, org_name).await;

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
            billing,
        });

    // ── Bind address ─────────────────────────────────────────────────────
    let addr = env::var("HIROBA_ADDR").unwrap_or_else(|_| "0.0.0.0:8787".to_string());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {addr}: {e}"));

    info!(addr = %addr, "hiroba-server listening");

    // ── Serve (graceful shutdown on Ctrl-C) ──────────────────────────────
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c()
                .await
                .expect("failed to install Ctrl-C handler");
            info!("shutdown signal received");
        })
        .await
        .expect("server error");
}
