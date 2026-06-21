/// Hiroba wire-protocol types (v2).
///
/// Every variant's discriminator string ("t") and every field name must match
/// PROTOCOL.md exactly — this file is the Rust mirror of the authoritative doc.
/// We use `#[serde(tag = "t")]` on enums so each message serialises with the
/// `"t"` field inline, exactly as the protocol demands.
///
/// v2 introduces organizations (tenants), multiple spaces (lobby + team),
/// an org-wide roster, presence/status, and paging (cross-space 1:1 voice).
/// State splits into two scopes (PROTOCOL.md §"Two scopes of state"):
///   - Org   scope → the roster (identity + status + which space), org-wide.
///   - Space scope → positions / proximity / entry-exit / audio, per space.
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Shared sub-types
// ---------------------------------------------------------------------------

/// Organization (tenant) identity, sent in `welcome`.
#[derive(Debug, Clone, Serialize)]
pub struct OrgInfo {
    pub id: String,
    pub name: String,
}

/// What a space is for. `lobby` uses normal proximity; `team` sets its radii
/// ≥ the space diagonal so everyone is always "near" (group call).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpaceKind {
    Lobby,
    Team,
}

/// Effective member status (server-computed). Priority, highest first:
/// `in_call > dnd > away > active` (PROTOCOL.md §"Presence & status").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    InCall,
    Dnd,
    Away,
    Active,
}

/// Per-space configuration + identity. Sent in `welcome.space`,
/// `welcome.spaces`, `space_snapshot.space`, and `spaces` broadcasts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceDescriptor {
    pub id: String,
    pub name: String,
    pub kind: SpaceKind,
    pub width: f64,
    pub height: f64,
    /// Distance ≤ nearRadius → peers become NEAR (audio connects).
    #[serde(rename = "nearRadius")]
    pub near_radius: f64,
    /// Distance ≥ farRadius → peers disconnect (hysteresis upper bound).
    #[serde(rename = "farRadius")]
    pub far_radius: f64,
    /// Server position-broadcast rate in Hz (NFR-04: 10–15 Hz).
    #[serde(rename = "tickHz")]
    pub tick_hz: u32,
    /// Max simultaneous members in the space.
    pub capacity: u32,
}

impl SpaceDescriptor {
    /// The well-known lobby: org-wide plaza, normal proximity voice.
    /// 4:3 like team spaces — the client letterboxes to the room's aspect
    /// ratio, so matching it keeps both rooms the same on-screen size.
    pub fn lobby() -> Self {
        Self {
            id: "lobby".to_string(),
            name: "ロビー".to_string(),
            kind: SpaceKind::Lobby,
            width: 1600.0,
            height: 1200.0,
            near_radius: 300.0,
            far_radius: 360.0,
            tick_hz: 12,
            capacity: 32,
        }
    }

    /// A team space: radii ≥ diagonal so the whole space is one group call.
    /// 800×600 → diagonal = 1000; we use 1100 so everyone is always near.
    pub fn team(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            kind: SpaceKind::Team,
            width: 800.0,
            height: 600.0,
            near_radius: 1100.0,
            far_radius: 1100.0,
            tick_hz: 12,
            capacity: 5,
        }
    }
}

/// Full peer descriptor — the in-space view (has position). Used in
/// `welcome.peers`, `space_snapshot.peers`, and `space_joined`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    pub id: String,
    pub name: String,
    pub color: String,
    /// Optional user-uploaded avatar as a small `data:image/...;base64,` URL
    /// (validated + size-capped in state.rs). Omitted when the member has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub x: f64,
    pub y: f64,
    pub muted: bool,
}

/// Lightweight position snapshot (used inside `state` and `space_snapshot.you`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerPos {
    pub id: String,
    pub x: f64,
    pub y: f64,
}

/// Roster (org-scoped) member descriptor — the sidebar view. Has `spaceId` +
/// `status` instead of a position. Used in `welcome.roster` and `presence`.
#[derive(Debug, Clone, Serialize)]
pub struct RosterMember {
    pub id: String,
    pub name: String,
    pub color: String,
    /// Same uploaded-avatar data URL as [`PeerInfo::avatar`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(rename = "spaceId")]
    pub space_id: String,
    pub status: Status,
    pub muted: bool,
}

/// Entry in a `proximity`/`page_connect` connect list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProximityConnect {
    pub id: String,
    /// true = this client is the WebRTC offerer (numeric id < other's id).
    pub initiator: bool,
}

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

/// Every message a client may send. Unknown `"t"` values are ignored (see
/// ws.rs) for forward-compatibility as the protocol requires.
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    /// First message after connecting: authenticate + join the org.
    /// `token` resolves to an org + identity (absent/empty → self-host guest).
    /// `name`/`color`/`avatar` are optional overrides of the profile/defaults.
    Hello {
        #[serde(default)]
        token: Option<String>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        color: Option<String>,
        /// User-uploaded avatar as a small `data:image/...;base64,` URL.
        #[serde(default)]
        avatar: Option<String>,
    },

    /// Switch the active space.
    EnterSpace {
        #[serde(rename = "spaceId")]
        space_id: String,
    },

    /// Create a new team space (FR-14).
    CreateSpace { name: String },

    /// Position update — sent at ~tickHz only when moving (current space).
    Move { x: f64, y: f64 },

    /// Mic mute toggle.
    Mute { muted: bool },

    /// Set user-controllable status flags. Either field may be omitted.
    SetStatus {
        #[serde(default)]
        away: Option<bool>,
        #[serde(default)]
        dnd: Option<bool>,
    },

    /// Relay a WebRTC signaling payload to one peer (proximity OR page link).
    Signal {
        to: String,
        /// Opaque SDP / ICE payload; server relays verbatim.
        data: Value,
    },

    /// Start a cross-space 1:1 "barge-in" voice link (FR-10).
    Page { to: String },

    /// End a page link.
    PageEnd { to: String },

    /// Explicit leave (optional — closing the socket is equivalent).
    Bye,
}

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

/// Every message the server may send to a client.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg {
    /// Sent once immediately after a successful `hello`. Carries both scopes:
    /// the current space (+ catalog + in-space peers) and the org roster.
    Welcome {
        id: String,
        org: OrgInfo,
        /// The joining peer's own descriptor (with server-chosen spawn coords).
        you: PeerInfo,
        #[serde(rename = "spaceId")]
        space_id: String,
        /// The current space's config.
        space: SpaceDescriptor,
        /// The full space catalog.
        spaces: Vec<SpaceDescriptor>,
        /// Peers in the *current space only* (excludes self), with positions.
        peers: Vec<PeerInfo>,
        /// The *org-wide* member list (excludes self), with status.
        roster: Vec<RosterMember>,
    },

    /// Fresh space view sent to the switching client after `enter_space`.
    SpaceSnapshot {
        #[serde(rename = "spaceId")]
        space_id: String,
        space: SpaceDescriptor,
        /// Spawn position in the new space.
        you: PeerPos,
        peers: Vec<PeerInfo>,
    },

    /// Space catalog changed (e.g. after `create_space`). Broadcast to the org.
    Spaces { spaces: Vec<SpaceDescriptor> },

    /// Org roster upsert (a member joined or changed). Broadcast to the org.
    Presence { member: RosterMember },

    /// A member disconnected from the org. Broadcast to the org.
    PresenceLeft { id: String },

    /// A peer entered *your current space*.
    SpaceJoined { peer: PeerInfo },

    /// A peer left *your current space* (switched away or disconnected).
    SpaceLeft { id: String },

    /// Batched position snapshot for your current space, sent every tick.
    /// Contains every peer in your space *except* the recipient.
    State { peers: Vec<PeerPos> },

    /// A peer in your current space changed its mic state.
    Mute { id: String, muted: bool },

    /// Which in-space P2P audio links to open or close (computed per space).
    /// Sent only when the recipient's proximity set changes.
    Proximity {
        connect: Vec<ProximityConnect>,
        disconnect: Vec<String>,
    },

    /// Open a 1:1 page link (sent to both peers). Same tie-break as proximity.
    PageConnect { peer: String, initiator: bool },

    /// A page could not be placed. `reason` is "dnd" or "offline". To caller.
    PageRejected { to: String, reason: String },

    /// A page link ended (peer hung up or disconnected).
    PageEnd { from: String },

    /// Relayed WebRTC signaling from another peer.
    Signal { from: String, data: Value },

    /// A request failed. Codes: auth_failed, space_full, space_limit,
    /// unknown_space, forbidden. On auth_failed the server closes the socket
    /// after this frame.
    Error { code: String, message: String },
}
