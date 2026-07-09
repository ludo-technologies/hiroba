/// Per-connection WebSocket handler + central tick loop (v2).
///
/// Architecture (unchanged from v1)
/// ────────────────────────────────
/// Each client spawns two lightweight tasks:
///
///   1. **Reader task** – reads WebSocket frames, parses them as `ClientMsg`,
///      and applies state mutations on the shared `Org`.
///   2. **Writer task** – drains an mpsc channel that other tasks push
///      `ServerMsg`s into, and forwards them to the WebSocket as JSON text.
///
/// A single **tick task** (started once at server boot) wakes at `tickHz` and,
/// for every tenant and every space that has at least one member, sends
/// per-space `state` and `proximity` messages. The tick task never holds an org
/// lock across an await and owns the proximity hysteresis state, keyed by
/// (org_id, space_id).
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::time::{interval, Duration};
use tracing::{debug, info, warn};

use crate::auth::Auth;
use crate::protocol::{ClientMsg, PeerPos, ServerMsg};
use crate::proximity;
use crate::registry::OrgRegistry;
use crate::state::{CreateSpaceOutcome, EnterOutcome, PageOutcome, MAX_SPACES_PER_ORG};

/// Capacity of the per-peer outbound channel.
const CHANNEL_CAP: usize = 64;

/// Server position-broadcast rate. All spaces share the same rate (NFR-04:
/// 10–15 Hz); it matches `SpaceDescriptor::tick_hz`.
const TICK_HZ: u32 = 12;

// ---------------------------------------------------------------------------
// Public entry point — called once per accepted WebSocket connection.
// ---------------------------------------------------------------------------

/// Handle a single WebSocket connection for its entire lifetime. `auth` verifies
/// the `hello` token and resolves it to a tenant + identity; `registry` then
/// hands back the matching [`crate::state::Org`] (§7.6).
pub async fn handle_ws(
    socket: WebSocket,
    registry: OrgRegistry,
    auth: Arc<Auth>,
    billing: Option<Arc<crate::billing::BillingGate>>,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    let (tx, mut rx) = mpsc::channel::<ServerMsg>(CHANNEL_CAP);

    // ── Phase 1: wait for `hello` ───────────────────────────────────────────
    let (token, name, color, avatar) = loop {
        match ws_rx.next().await {
            None => return, // disconnected before hello — nothing to clean up
            Some(Err(e)) => {
                debug!("ws error before hello: {e}");
                return;
            }
            Some(Ok(Message::Text(text))) => match serde_json::from_str::<ClientMsg>(&text) {
                Ok(ClientMsg::Hello {
                    token,
                    name,
                    color,
                    avatar,
                }) => break (token, name, color, avatar),
                Ok(_) => debug!("ignoring pre-hello message"),
                Err(e) => debug!("parse error before hello: {e}"),
            },
            Some(Ok(_)) => {} // non-text frames ignored
        }
    };

    // ── Phase 2: authenticate → tenant + identity, then register ────────────
    let identity = match auth.resolve(token.as_deref()).await {
        Ok(id) => id,
        Err(e) => {
            debug!(reason = %e, "auth rejected");
            let err = ServerMsg::Error {
                code: "auth_failed".to_string(),
                message: "Authentication failed.".to_string(),
            };
            if let Ok(text) = serde_json::to_string(&err) {
                let _ = ws_tx.send(Message::Text(text.into())).await;
            }
            return; // closes the socket
        }
    };

    // Billing gate: refuse connections from a locked org (trial paused, or
    // subscription canceled/unpaid). No-op for self-host (billing disabled) and
    // fail-open if the auth backend is unreachable.
    if let Some(gate) = billing.as_ref() {
        if gate.locked(&identity.org_id).await {
            debug!(org = %identity.org_id, "connection refused: org locked");
            let err = ServerMsg::Error {
                code: "org_suspended".to_string(),
                message: "This organization's subscription is inactive.".to_string(),
            };
            if let Ok(text) = serde_json::to_string(&err) {
                let _ = ws_tx.send(Message::Text(text.into())).await;
            }
            return; // closes the socket
        }
    }

    // Resolve (or lazily create) the tenant this identity belongs to. From here
    // on the connection is pinned to this org's scope (§7.6, NFR-12).
    let org_name = identity
        .org_name
        .clone()
        .unwrap_or_else(|| identity.org_id.clone());
    let org = registry.get_or_create(&identity.org_id, &org_name).await;

    // Profile precedence: an explicit `hello` value wins, else the verified
    // token's profile, else a default. (§9: OAuth profile, Hiroba may override.)
    let name = name.or(identity.name).unwrap_or_default();
    // The colour is validated (strict `#RRGGBB`) inside `Org::join`, where the
    // value enters the member state — not here, so no path around it exists.
    let color = color.or(identity.color).unwrap_or_default();
    // The avatar is validated (small base64 image data URL) inside `Org::join`,
    // same as the colour.
    let welcome = org.join(name, color, avatar, tx.clone()).await;
    let peer_id = match &welcome {
        ServerMsg::Welcome { id, .. } => id.clone(),
        _ => unreachable!("join returns Welcome"),
    };

    info!(
        peer_id = %peer_id,
        org = %org.id(),
        sub = identity.sub.as_deref().unwrap_or("guest"),
        "member joined"
    );

    // Send `welcome` directly via the writer half before spawning the writer
    // task, so we don't need to worry about ordering with the mpsc channel.
    let welcome_text = match serde_json::to_string(&welcome) {
        Ok(t) => t,
        Err(e) => {
            warn!("failed to serialize welcome: {e}");
            org.leave(&peer_id).await;
            return;
        }
    };
    if ws_tx
        .send(Message::Text(welcome_text.into()))
        .await
        .is_err()
    {
        org.leave(&peer_id).await;
        return;
    }

    // ── Phase 3: spawn the writer task ────────────────────────────────────
    let writer_handle = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(text) => {
                    if ws_tx.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                Err(e) => warn!("failed to serialize server message: {e}"),
            }
        }
    });

    // ── Phase 4: reader loop ──────────────────────────────────────────────
    let pid = peer_id.clone();
    'read: while let Some(frame) = ws_rx.next().await {
        match frame {
            Ok(Message::Text(text)) => match serde_json::from_str::<ClientMsg>(&text) {
                Ok(ClientMsg::Move { x, y }) => org.set_pos(&pid, x, y).await,
                Ok(ClientMsg::Mute { muted }) => org.set_mute(&pid, muted).await,
                Ok(ClientMsg::SetStatus { away, dnd }) => org.set_status(&pid, away, dnd).await,
                Ok(ClientMsg::Signal { to, data }) => org.route_signal(&pid, &to, data).await,
                Ok(ClientMsg::EnterSpace { space_id }) => {
                    let outcome = org.enter_space(&pid, &space_id).await;
                    let msg = match outcome {
                        EnterOutcome::Snapshot(m) => m,
                        EnterOutcome::Error(m) => m,
                    };
                    // Deliver to the requester via their own channel.
                    let _ = tx.send(msg).await;
                }
                Ok(ClientMsg::CreateSpace { name }) => {
                    if let CreateSpaceOutcome::LimitReached = org.create_space(name).await {
                        let _ = tx
                            .send(ServerMsg::Error {
                                code: "space_limit".to_string(),
                                message: format!("Space limit reached ({MAX_SPACES_PER_ORG})."),
                            })
                            .await;
                    }
                }
                Ok(ClientMsg::Page { to }) => {
                    if let PageOutcome::Rejected(reason) = org.page(&pid, &to).await {
                        let _ = tx
                            .send(ServerMsg::PageRejected {
                                to: to.clone(),
                                reason,
                            })
                            .await;
                    }
                }
                Ok(ClientMsg::PageAccept { to }) => org.page_accept(&pid, &to).await,
                Ok(ClientMsg::PageEnd { to }) => org.page_end(&pid, &to).await,
                Ok(ClientMsg::Bye) => break 'read,
                Ok(ClientMsg::Hello { .. }) => {
                    debug!(peer_id = %pid, "ignoring duplicate hello");
                }
                Err(_) => {
                    // Unknown message types MUST be ignored (PROTOCOL.md).
                }
            },
            Ok(Message::Close(_)) => break 'read,
            Ok(_) => {} // ping/pong/binary — ignored
            Err(e) => {
                debug!(peer_id = %pid, "ws read error: {e}");
                break 'read;
            }
        }
    }

    // ── Phase 5: cleanup ──────────────────────────────────────────────────
    org.leave(&peer_id).await;
    info!(peer_id = %peer_id, "member left");
    writer_handle.abort();
}

// ---------------------------------------------------------------------------
// Central tick loop — launched once at startup, not per connection.
// ---------------------------------------------------------------------------

/// Spawn the tick task. Runs for the lifetime of the server.
///
/// Every tick, for each tenant and each of its non-empty spaces:
///   1. Send each member a `state` message with all OTHER members' positions
///      *in that space*.
///   2. Compute proximity deltas (with hysteresis, using that space's radii)
///      and send `proximity` only to members whose connected set changed.
///
/// Proximity hysteresis state is local to this task and keyed by
/// **(org_id, space_id)**, so it is computed independently within each space of
/// each tenant — peers in different spaces (or different orgs) never connect.
/// Empty spaces and idle tenants are skipped entirely → idle CPU stays near zero.
pub fn spawn_tick_loop(registry: OrgRegistry) {
    tokio::spawn(async move {
        let tick_duration = Duration::from_secs_f64(1.0 / TICK_HZ as f64);
        let mut ticker = interval(tick_duration);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        // org_id → space_id → (peer_id → set of near peer_ids).
        let mut connected: HashMap<String, HashMap<String, HashMap<String, HashSet<String>>>> =
            HashMap::new();

        loop {
            ticker.tick().await;

            // Tenants with at least one populated space this tick.
            let mut live_orgs: HashSet<String> = HashSet::new();

            for org in registry.all().await {
                let ticks = org.tick_snapshot().await;
                if ticks.is_empty() {
                    // No populated spaces in this tenant — drop its proximity state.
                    connected.remove(org.id());
                    continue;
                }
                live_orgs.insert(org.id().to_string());
                let org_connected = connected.entry(org.id().to_string()).or_default();

                let live_spaces: HashSet<&str> =
                    ticks.iter().map(|t| t.space_id.as_str()).collect();

                for tick in &ticks {
                    // --- state broadcast (positions of all others in the space) ---
                    for member in &tick.members {
                        let others: Vec<PeerPos> = tick
                            .members
                            .iter()
                            .filter(|o| o.info.id != member.info.id)
                            .map(|o| PeerPos {
                                id: o.info.id.clone(),
                                x: o.info.x,
                                y: o.info.y,
                            })
                            .collect();
                        if others.is_empty() {
                            continue; // only one member — skip (protocol §state)
                        }
                        let _ = member.tx.try_send(ServerMsg::State { peers: others });
                    }

                    // --- proximity (computed within this space) -------------------
                    let positions: Vec<proximity::PeerPos> = tick
                        .members
                        .iter()
                        .map(|m| proximity::PeerPos {
                            num_id: m.num_id,
                            string_id: m.info.id.clone(),
                            x: m.info.x,
                            y: m.info.y,
                        })
                        .collect();

                    let sets = org_connected.entry(tick.space_id.clone()).or_default();
                    let deltas = proximity::update_proximity(
                        &positions,
                        sets,
                        tick.near_radius,
                        tick.far_radius,
                    );

                    for member in &tick.members {
                        if let Some(delta) = deltas.get(&member.info.id) {
                            if !delta.is_empty() {
                                let _ = member.tx.try_send(ServerMsg::Proximity {
                                    connect: delta.connect.clone(),
                                    disconnect: delta.disconnect.clone(),
                                });
                            }
                        }
                    }

                    // --- per-space stale cleanup ---------------------------------
                    // Members who left this space between ticks won't appear in
                    // `positions`; drop them from this space's connected set. Peers
                    // get audio teardown from `space_left`, so no proximity
                    // disconnect is needed here (mirrors v1).
                    let live_ids: HashSet<&str> =
                        positions.iter().map(|p| p.string_id.as_str()).collect();
                    let stale: Vec<String> = sets
                        .keys()
                        .filter(|id| !live_ids.contains(id.as_str()))
                        .cloned()
                        .collect();
                    for id in stale {
                        proximity::remove_peer(&id, sets);
                    }
                }

                // Drop proximity state for spaces that emptied this tick.
                org_connected.retain(|space_id, _| live_spaces.contains(space_id.as_str()));
            } // end per-org loop

            // Drop proximity state for tenants idle this tick.
            connected.retain(|org_id, _| live_orgs.contains(org_id));
        }
    });
}
