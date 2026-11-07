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
/// per-space `state` and `proximity` messages. It owns the proximity hysteresis
/// state, keyed by (org_id, space_id), and does each tenant's whole tick —
/// snapshot, proximity, and sends — inside one `Org::with_tick` closure, so no
/// member can change space between being observed and being messaged. It never
/// holds an org lock across an await.
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Instant, SystemTime};

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::time::{interval, Duration};
use tracing::{debug, info, warn};

use crate::auth::{Auth, Role};
use crate::beacon::GuestBeacon;
use crate::outbox::Outbox;
use crate::protocol::{ClientMsg, PeerPos, ServerMsg};
use crate::proximity;
use crate::registry::OrgRegistry;
use crate::state::{
    CreateSpaceOutcome, EnterOutcome, NoteError, PageOutcome, MAX_SPACES_PER_ORG, NOTE_COOLDOWN,
};

/// Capacity of the per-peer outbound channel. Most of it is kept for control
/// messages (see [`crate::outbox`]): a client that cannot take one is
/// disconnected, so the room must cover a burst — a whole org reconnecting
/// after a deploy, each arrival a `presence` to everyone — with lossy traffic
/// held to the top quarter.
const CHANNEL_CAP: usize = 256;

/// Largest message a client may send: a `hello` with its avatar (up to 64 KiB)
/// is the biggest legitimate one; an SDP with video is a few KiB.
pub const MAX_MESSAGE_BYTES: usize = 128 * 1024;

/// How long a new connection may sit before saying `hello`.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// What a connection may send, per second and in one burst. Roomy enough for a
/// client opening links to a full team space at once (a burst of offers,
/// answers and candidates, each relayed to one peer); a client past it is
/// flooding the peers its messages fan out to, and is disconnected.
const INBOUND_MSGS_PER_SEC: f64 = 200.0;
const INBOUND_MSG_BURST: f64 = 1000.0;
const INBOUND_BYTES_PER_SEC: f64 = 512.0 * 1024.0;
const INBOUND_BYTE_BURST: f64 = 2.0 * 1024.0 * 1024.0;

/// Server position-broadcast rate. All spaces share the same rate (NFR-04:
/// 10–15 Hz); it matches `SpaceDescriptor::tick_hz`.
const TICK_HZ: u32 = 12;

// ---------------------------------------------------------------------------
// Public entry point — called once per accepted WebSocket connection.
// ---------------------------------------------------------------------------

/// Handle a single WebSocket connection for its entire lifetime. `auth` verifies
/// the `hello` token and resolves it to a tenant + identity; `registry` then
/// hands back the matching [`crate::state::Org`] (§7.6). `beacon`, when
/// configured, hears about a guest's exit.
pub async fn handle_ws(
    socket: WebSocket,
    registry: OrgRegistry,
    auth: Arc<Auth>,
    billing: Option<Arc<crate::billing::BillingGate>>,
    beacon: Option<Arc<GuestBeacon>>,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    let (tx, mut rx) = mpsc::channel::<ServerMsg>(CHANNEL_CAP);
    let outbox = Outbox::from(tx.clone());

    // ── Phase 1: wait for `hello` ───────────────────────────────────────────
    let hello = tokio::time::timeout(HELLO_TIMEOUT, async {
        loop {
            match ws_rx.next().await {
                None => return None, // disconnected before hello — nothing to clean up
                Some(Err(e)) => {
                    debug!("ws error before hello: {e}");
                    return None;
                }
                Some(Ok(Message::Text(text))) => match serde_json::from_str::<ClientMsg>(&text) {
                    Ok(ClientMsg::Hello {
                        token,
                        name,
                        color,
                        avatar,
                    }) => return Some((token, name, color, avatar)),
                    Ok(_) => debug!("ignoring pre-hello message"),
                    Err(e) => debug!("parse error before hello: {e}"),
                },
                Some(Ok(_)) => {} // non-text frames ignored
            }
        }
    })
    .await;
    let Ok(Some((token, name, color, avatar))) = hello else {
        return; // no hello in time, or gone before one
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
    let welcome = org
        .join(
            name,
            color,
            avatar,
            identity.sub.clone(),
            identity.role,
            outbox.clone(),
        )
        .await;
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

    // The lobby's chat. Its own message rather than part of
    // `welcome`, so it always follows the space view it belongs to.
    org.send_notes(&peer_id).await;

    // ── Phase 4: reader loop ──────────────────────────────────────────────
    let pid = peer_id.clone();
    // The token admitted this connection only until it expires: `reauth`
    // carries a fresh one forward, otherwise the connection ends with it — so a
    // revoked invite or a removed member is out within one token lifetime.
    let mut expiry = identity.expires_at;
    let mut msgs = Allowance::new(INBOUND_MSG_BURST, INBOUND_MSGS_PER_SEC);
    let mut bytes = Allowance::new(INBOUND_BYTE_BURST, INBOUND_BYTES_PER_SEC);
    'read: loop {
        let frame = tokio::select! {
            frame = ws_rx.next() => frame,
            () = until(expiry) => {
                info!(peer_id = %pid, "token expired");
                break 'read;
            }
            () = outbox.kicked() => {
                info!(peer_id = %pid, "disconnected by the server");
                break 'read;
            }
        };
        let Some(frame) = frame else { break 'read };
        let size = match &frame {
            Ok(Message::Text(text)) => text.len(),
            Ok(Message::Binary(data)) => data.len(),
            _ => 0,
        };
        if !msgs.take(1.0) || !bytes.take(size as f64) {
            warn!(peer_id = %pid, "inbound rate exceeded; disconnecting");
            break 'read;
        }
        match frame {
            Ok(Message::Text(text)) => match serde_json::from_str::<ClientMsg>(&text) {
                Ok(ClientMsg::Move { x, y }) => org.set_pos(&pid, x, y).await,
                Ok(ClientMsg::Mute { muted }) => org.set_mute(&pid, muted).await,
                Ok(ClientMsg::SetStatus { away, dnd }) => org.set_status(&pid, away, dnd).await,
                Ok(ClientMsg::Signal { to, data }) => org.route_signal(&pid, &to, data).await,
                Ok(ClientMsg::EnterSpace { space_id }) => {
                    let outcome = org.enter_space(&pid, &space_id).await;
                    let entered = matches!(outcome, EnterOutcome::Snapshot(_));
                    let msg = match outcome {
                        EnterOutcome::Snapshot(m) => m,
                        EnterOutcome::Error(m) => m,
                    };
                    // Deliver to the requester via their own channel.
                    let _ = tx.send(msg).await;
                    if entered {
                        org.send_notes(&pid).await;
                    }
                }
                Ok(ClientMsg::CreateSpace { name, layout }) => {
                    let err = match org.create_space(name, layout).await {
                        CreateSpaceOutcome::Created => None,
                        CreateSpaceOutcome::LimitReached => Some(ServerMsg::Error {
                            code: "space_limit".to_string(),
                            message: format!("Space limit reached ({MAX_SPACES_PER_ORG})."),
                        }),
                        CreateSpaceOutcome::Duplicate(name) => Some(ServerMsg::Error {
                            code: "space_exists".to_string(),
                            message: format!("A space named \"{name}\" already exists."),
                        }),
                    };
                    if let Some(msg) = err {
                        let _ = tx.send(msg).await;
                    }
                }
                Ok(ClientMsg::PostNote { text }) => {
                    if let Err(e) = org.post_note(&pid, &text).await {
                        let _ = tx.send(note_error(e)).await;
                    }
                }
                Ok(ClientMsg::RemoveNote { id }) => {
                    if let Err(e) = org.remove_note(&pid, id).await {
                        let _ = tx.send(note_error(e)).await;
                    }
                }
                Ok(ClientMsg::React { id, emoji }) => {
                    if let Err(e) = org.react(&pid, id, emoji).await {
                        let _ = tx.send(note_error(e)).await;
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
                Ok(ClientMsg::Ping) => {
                    let _ = tx.send(ServerMsg::Pong).await;
                }
                Ok(ClientMsg::Reauth { token }) => match auth.resolve(Some(&token)).await {
                    // Renews this seat only: a token for another org, person or
                    // role is a different connection's to open.
                    Ok(renewed)
                        if renewed.org_id == identity.org_id
                            && renewed.sub == identity.sub
                            && renewed.role == identity.role =>
                    {
                        expiry = renewed.expires_at;
                    }
                    _ => {
                        info!(peer_id = %pid, "reauth refused");
                        break 'read;
                    }
                },
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
    let left = org.leave(&peer_id).await;
    info!(peer_id = %peer_id, "member left");
    writer_handle.abort();

    // A browser guest's exit is the one moment that knows what their visit
    // was like; report it off the connection's path, the way auth reports the
    // entry. Members and admins are accounted for elsewhere (auth DB).
    if let (Some(beacon), Some(m)) = (beacon, left.filter(|m| m.role == Role::Guest)) {
        let org_id = org.id().to_string();
        tokio::spawn(async move {
            beacon
                .guest_left(
                    &org_id,
                    &m.name,
                    m.joined_at.elapsed().as_secs(),
                    m.peers_max,
                )
                .await;
        });
    }
}

/// A refilling allowance (token bucket): `burst` at most, `per_sec` back.
struct Allowance {
    left: f64,
    burst: f64,
    per_sec: f64,
    at: Instant,
}

impl Allowance {
    fn new(burst: f64, per_sec: f64) -> Self {
        Self {
            left: burst,
            burst,
            per_sec,
            at: Instant::now(),
        }
    }

    /// Spend `n`; false once the allowance is used up.
    fn take(&mut self, n: f64) -> bool {
        let now = Instant::now();
        let refill = now.duration_since(self.at).as_secs_f64() * self.per_sec;
        self.left = (self.left + refill).min(self.burst);
        self.at = now;
        if self.left < n {
            return false;
        }
        self.left -= n;
        true
    }
}

/// Resolves at `at` (wall clock, as a token's `exp` is); never, when there is
/// no deadline.
async fn until(at: Option<SystemTime>) {
    match at {
        Some(at) => {
            let left = at.duration_since(SystemTime::now()).unwrap_or_default();
            tokio::time::sleep(left).await;
        }
        None => std::future::pending().await,
    }
}

fn note_error(e: NoteError) -> ServerMsg {
    let (code, message) = match e {
        NoteError::Empty => ("note_empty", "A note needs some text.".to_string()),
        NoteError::RateLimited => (
            "note_rate",
            format!("Wait {} seconds between notes.", NOTE_COOLDOWN.as_secs()),
        ),
        NoteError::Forbidden => (
            "forbidden",
            "Only its author or an admin can remove a note.".to_string(),
        ),
        NoteError::Anonymous => (
            "forbidden",
            "Reacting needs an account; this server runs without them.".to_string(),
        ),
        NoteError::ReactionRateLimited => (
            "reaction_rate",
            "Wait a moment between reactions.".to_string(),
        ),
    };
    ServerMsg::Error {
        code: code.to_string(),
        message,
    }
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
/// The link sets the engine works on belong to the org (`Org::with_tick` hands
/// them over under the org lock) and are kept per space, so proximity is
/// computed independently within each space of each tenant — peers in
/// different spaces (or different orgs) never connect — and `route_signal`
/// relays signaling only over the pairs recorded there. Empty spaces and idle
/// tenants are skipped entirely → idle CPU stays near zero.
pub fn spawn_tick_loop(registry: OrgRegistry) {
    tokio::spawn(async move {
        let tick_duration = Duration::from_secs_f64(1.0 / TICK_HZ as f64);
        let mut ticker = interval(tick_duration);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            ticker.tick().await;

            for org in registry.all().await {
                // The whole tick — snapshot, proximity, and the sends they imply
                // — runs under the org lock, so a member cannot change space
                // between being observed and being told to connect to someone
                // in the space they just left (see `Org::with_tick`).
                org.with_tick(|ticks, links| {
                    // Spaces that emptied hold no links any more (their members
                    // were unlinked as they left); drop the keys too.
                    let live_spaces: HashSet<&str> =
                        ticks.iter().map(|t| t.space_id.as_str()).collect();
                    links.retain(|space_id, _| live_spaces.contains(space_id.as_str()));

                    for tick in ticks {
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
                            member.tx.send_lossy(ServerMsg::State { peers: others });
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
                                dnd: m.dnd,
                            })
                            .collect();

                        let sets = links.entry(tick.space_id.clone()).or_default();
                        let deltas = proximity::update_proximity(
                            &positions,
                            sets,
                            tick.near_radius,
                            tick.far_radius,
                            tick.meeting_room.as_ref(),
                        );

                        // A delta that cannot be queued is never recomputed —
                        // `update_proximity` has recorded it as applied — so the
                        // outbox disconnects that client rather than leave it with
                        // a link the server believes is torn down (or opened).
                        for member in &tick.members {
                            let Some(delta) = deltas.get(&member.info.id) else {
                                continue;
                            };
                            if delta.is_empty() {
                                continue;
                            }
                            member.tx.send(ServerMsg::Proximity {
                                connect: delta.connect.clone(),
                                disconnect: delta.disconnect.clone(),
                            });
                        }
                    }
                })
                .await;
            }
        }
    });
}
