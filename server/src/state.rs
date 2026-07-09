/// Shared org state — the single source of truth for all connected members.
///
/// v2 generalises v1's single `Room` into an `Org` (tenant) that owns multiple
/// **spaces** (a lobby + team spaces). State splits into two scopes:
///
///   - **Org scope**   → the roster: every member's identity + status + which
///     space they're in. Drives the sidebar; broadcast to the whole org.
///   - **Space scope**  → positions / proximity / entry-exit / audio. Drives
///     the 2D canvas; only sent to members currently in that space.
///
/// The design keeps v1's discipline: a single `tokio::sync::Mutex` over the
/// whole `OrgInner`, held only for brief in-memory work and *never* across a
/// `.await` on a socket. All outbound sends are non-blocking `try_send`.
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, Mutex};

use crate::protocol::{
    OrgInfo, PeerInfo, PeerPos, RosterMember, ServerMsg, SpaceDescriptor, Status,
};
use crate::store::{OrgCatalog, Store};

/// Upper bound on spaces per org (lobby + team spaces). Caps unbounded
/// `create_space` from guests; generous enough for legitimate team use.
pub const MAX_SPACES_PER_ORG: usize = 64;

/// Avatar colour used when a client supplies none, or one that fails
/// validation.
const DEFAULT_COLOR: &str = "#8a93a6";

/// True iff `s` is a strict `#RRGGBB` hex colour (the only shape the client
/// emits). The colour is relayed verbatim to every other client and rendered
/// straight into the DOM/canvas, so an unvalidated value is an injection
/// vector — validation lives here, where the value enters [`Member`], so any
/// future message that sets a colour goes through the same gate.
fn is_hex_color(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(u8::is_ascii_hexdigit)
}

/// Max length of an avatar data URL in bytes (~48 KB of image). The client
/// downscales to a 128×128 WebP/JPEG (a few KB); this cap bounds broadcast
/// amplification from a hostile client, not legitimate use.
const MAX_AVATAR_LEN: usize = 64 * 1024;

/// How long an unanswered page rings before auto-declining (callee silence =
/// decline). Short enough to avoid long surprise rings on an always-on tool.
const PAGE_RING_TIMEOUT: Duration = Duration::from_secs(25);

/// True iff `s` is a well-formed `data:image/(png|jpeg|webp);base64,<base64>`
/// URL within [`MAX_AVATAR_LEN`]. Like the colour, the avatar is relayed
/// verbatim to every other client and rendered straight into the canvas/DOM,
/// so anything that is not strictly a small base64 image is rejected here,
/// where the value enters [`Member`].
fn is_valid_avatar(s: &str) -> bool {
    if s.len() > MAX_AVATAR_LEN {
        return false;
    }
    let payload = [
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
        "data:image/webp;base64,",
    ]
    .iter()
    .find_map(|p| s.strip_prefix(p));
    match payload {
        Some(b64) => {
            !b64.is_empty()
                && b64
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/' || c == b'=')
        }
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Per-member data
// ---------------------------------------------------------------------------

/// In-memory member record kept inside `OrgInner`. A member is connected to
/// exactly one org and present in exactly one space at a time; their position
/// is the position *within their current space* (reset on space switch).
#[derive(Debug)]
pub struct Member {
    pub id: String,
    /// Numeric id (equals the string parsed as u64) — used for ordering in the
    /// initiator tie-break and for spawn-ring index.
    pub num_id: u64,
    pub name: String,
    pub color: String,
    /// User-uploaded avatar (validated `data:image/...;base64,` URL), if any.
    pub avatar: Option<String>,
    /// The space the member is currently present in.
    pub space_id: String,
    pub x: f64,
    pub y: f64,
    pub muted: bool,
    /// User-controllable idle flag (NFR-01 dim-on-idle).
    pub away: bool,
    /// User-controllable do-not-disturb flag (blocks incoming pages, FR-11).
    pub dnd: bool,
    /// Peers this member currently has an established page (1:1) link with.
    /// Non-empty ⇒ effective status is `in_call`.
    pub paging: HashSet<String>,
    /// Peers we are ringing (outgoing page offers, not yet accepted).
    pub ringing_out: HashSet<String>,
    /// Peers ringing us (incoming page offers awaiting accept/decline).
    pub ringing_in: HashSet<String>,
    /// Channel to the per-connection writer task.
    pub tx: mpsc::Sender<ServerMsg>,
}

impl Member {
    /// Effective status (PROTOCOL.md §"Presence & status"):
    /// `in_call > dnd > away > active`.
    pub fn status(&self) -> Status {
        if !self.paging.is_empty() {
            Status::InCall
        } else if self.dnd {
            Status::Dnd
        } else if self.away {
            Status::Away
        } else {
            Status::Active
        }
    }

    /// Space-scoped descriptor (has position).
    pub fn as_peer_info(&self) -> PeerInfo {
        PeerInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            color: self.color.clone(),
            avatar: self.avatar.clone(),
            x: self.x,
            y: self.y,
            muted: self.muted,
        }
    }

    /// Org-scoped descriptor (has status + spaceId, no position).
    pub fn as_roster_member(&self) -> RosterMember {
        RosterMember {
            id: self.id.clone(),
            name: self.name.clone(),
            color: self.color.clone(),
            avatar: self.avatar.clone(),
            space_id: self.space_id.clone(),
            status: self.status(),
            muted: self.muted,
        }
    }
}

// ---------------------------------------------------------------------------
// Tick snapshot types (consumed by the tick loop)
// ---------------------------------------------------------------------------

/// One member's data as needed by a single tick (state + proximity).
pub struct TickMember {
    pub info: PeerInfo,
    pub num_id: u64,
    pub tx: mpsc::Sender<ServerMsg>,
}

/// All the per-space data the tick loop needs, captured under one lock so the
/// `state` broadcast set and the proximity computation observe the same peers.
pub struct SpaceTick {
    pub space_id: String,
    pub near_radius: f64,
    pub far_radius: f64,
    pub members: Vec<TickMember>,
}

// ---------------------------------------------------------------------------
// Org internals
// ---------------------------------------------------------------------------

/// A space and which members are currently present in it. Positions live on the
/// `Member` records (a member is only ever in one space at a time).
struct SpaceState {
    desc: SpaceDescriptor,
    member_ids: HashSet<String>,
}

/// Interior of the org — always accessed through `Org`'s Mutex.
pub struct OrgInner {
    id: String,
    name: String,
    members: HashMap<String, Member>,
    spaces: HashMap<String, SpaceState>,
    /// Insertion order of spaces, so the catalog is stable for clients.
    space_order: Vec<String>,
    /// Monotonic counter for auto-named team spaces (FR-14).
    next_space_seq: u64,
}

/// Choose a spawn position for the n-th member in a space. Index 0 lands
/// dead-centre; subsequent members are placed on a golden-angle (phyllotaxis)
/// spiral so no two ever stack — the old fixed `TAU / 8` ring aliased every
/// 8th member onto an identical coordinate, so later arrivals in a full
/// space all collided with someone already there.
///
/// The spread is capped below `near_radius` so every arrival spawns within
/// earshot of a centre occupant ("you hear the room the moment you walk in"),
/// matching the old fixed-ring behaviour. Past `capacity` the radius stops
/// growing — angles stay unique, so positions remain distinct.
fn spawn_position(space: &SpaceDescriptor, index: u64) -> (f64, f64) {
    let cx = space.width / 2.0;
    let cy = space.height / 2.0;
    if index == 0 {
        return (cx, cy);
    }
    // Golden angle (~137.5°): consecutive points never repeat an angle, and the
    // sqrt radius keeps spawns evenly spread out to `max_r` over the capacity.
    const GOLDEN_ANGLE: f64 = std::f64::consts::PI * (3.0 - 2.236_067_977_499_79); // 5f64.sqrt()
    let max_r = (space.width.min(space.height) * 0.4).min(space.near_radius * 0.9);
    let cap = space.capacity.max(1) as f64;
    let t = index as f64;
    let ring_r = max_r * ((t.min(cap)) / cap).sqrt();
    let angle = t * GOLDEN_ANGLE;
    let x = (cx + ring_r * angle.cos()).clamp(0.0, space.width);
    let y = (cy + ring_r * angle.sin()).clamp(0.0, space.height);
    (x, y)
}

/// Minimum clear distance (world units) between a spawn point and any member
/// already in the space. The client renders person tokens 80 wu across
/// (render.ts PEER_RADIUS = 40 wu), so this keeps an arrival from
/// materialising on top of someone parked at their own spawn point.
const SPAWN_GAP: f64 = 80.0;

impl OrgInner {
    /// Choose a spawn position in `space_id`, skipping spiral points within
    /// `SPAWN_GAP` of a current occupant. The occupancy-count index alone is
    /// not collision-free: it is reused after a departure (A, B, C join →
    /// B leaves → the next arrival gets C's old index and lands exactly on C
    /// if they never moved). Scanning forward from the occupancy index keeps
    /// the common case identical to the plain spiral; if every candidate is
    /// crowded (everyone huddled together) we fall back to the candidate
    /// farthest from its nearest occupant.
    fn pick_spawn(&self, space_id: &str) -> (f64, f64) {
        let space = &self.spaces[space_id];
        let desc = &space.desc;
        let occupied: Vec<(f64, f64)> = space
            .member_ids
            .iter()
            .filter_map(|mid| self.members.get(mid).map(|m| (m.x, m.y)))
            .collect();
        let start = occupied.len() as u64;
        let attempts = (desc.capacity.max(8) as u64) * 2;
        let mut best = spawn_position(desc, start);
        let mut best_clearance = f64::NEG_INFINITY;
        for index in start..start + attempts {
            let (x, y) = spawn_position(desc, index);
            let clearance = occupied
                .iter()
                .map(|&(ox, oy)| (ox - x).hypot(oy - y))
                .fold(f64::INFINITY, f64::min);
            if clearance >= SPAWN_GAP {
                return (x, y);
            }
            if clearance > best_clearance {
                best_clearance = clearance;
                best = (x, y);
            }
        }
        best
    }

    fn org_info(&self) -> OrgInfo {
        OrgInfo {
            id: self.id.clone(),
            name: self.name.clone(),
        }
    }

    /// Space catalog in insertion order.
    fn catalog(&self) -> Vec<SpaceDescriptor> {
        self.space_order
            .iter()
            .filter_map(|id| self.spaces.get(id).map(|s| s.desc.clone()))
            .collect()
    }

    /// Send a message to every member of the org except `except`.
    fn broadcast_org_except(&self, except: &str, msg: ServerMsg) {
        for (id, m) in &self.members {
            if id != except {
                let _ = m.tx.try_send(msg.clone());
            }
        }
    }

    /// Send a message to every member present in `space_id` except `except`.
    fn broadcast_space_except(&self, space_id: &str, except: &str, msg: ServerMsg) {
        if let Some(space) = self.spaces.get(space_id) {
            for id in &space.member_ids {
                if id != except {
                    if let Some(m) = self.members.get(id) {
                        let _ = m.tx.try_send(msg.clone());
                    }
                }
            }
        }
    }

    /// Broadcast the roster entry for `member_id` to the rest of the org.
    fn broadcast_presence(&self, member_id: &str) {
        if let Some(m) = self.members.get(member_id) {
            let msg = ServerMsg::Presence {
                member: m.as_roster_member(),
            };
            self.broadcast_org_except(member_id, msg);
        }
    }

    /// Roster of the whole org excluding `except`.
    fn roster_except(&self, except: &str) -> Vec<RosterMember> {
        self.members
            .values()
            .filter(|m| m.id != except)
            .map(|m| m.as_roster_member())
            .collect()
    }

    /// Peers in `space_id` (with positions) excluding `except`.
    fn peers_in_space_except(&self, space_id: &str, except: &str) -> Vec<PeerInfo> {
        match self.spaces.get(space_id) {
            None => Vec::new(),
            Some(space) => space
                .member_ids
                .iter()
                .filter(|id| id.as_str() != except)
                .filter_map(|id| self.members.get(id).map(|m| m.as_peer_info()))
                .collect(),
        }
    }
}

// ---------------------------------------------------------------------------
// Public Org handle
// ---------------------------------------------------------------------------

/// Outcome of an `enter_space` request.
pub enum EnterOutcome {
    /// Success: the space snapshot to send to the switching member.
    Snapshot(ServerMsg),
    /// Failure: the error to send to the requester.
    Error(ServerMsg),
}

/// Outcome of a `create_space` request.
pub enum CreateSpaceOutcome {
    /// The space was created; the updated catalog was broadcast org-wide
    /// (including to the creator).
    Created,
    /// The org already holds [`MAX_SPACES_PER_ORG`] spaces; nothing was
    /// created. The caller reports this to the requester.
    LimitReached,
}

/// Outcome of a `page` request.
pub enum PageOutcome {
    /// Offer delivered; callee is ringing (messages already sent).
    Ringing,
    /// Could not place the page; `reason` is "dnd" or "offline".
    Rejected(String),
}

/// Thread-safe handle to a shared org. Clone cheaply (Arc).
#[derive(Clone)]
pub struct Org {
    /// Tenant id, mirrored outside the lock for cheap synchronous access
    /// (the tick loop keys per-org proximity state by it without awaiting).
    id: Arc<str>,
    inner: Arc<Mutex<OrgInner>>,
    /// Monotonic member-id counter — never reused (protocol uniqueness). Scoped
    /// per tenant: ids only need to be unique within an org (NFR-12 isolation).
    next_id: Arc<AtomicU64>,
    /// Write-through persistence for the space catalog (§7.5). `None` is the
    /// DB-less self-host profile: everything stays in memory, as always.
    store: Option<Arc<Store>>,
}

impl Org {
    /// Create an org seeded with a lobby plus a default team space ("Dev"),
    /// matching the PROTOCOL.md example catalog. With a store, the new org and
    /// its seed catalog are persisted here, so a restart reloads them via
    /// [`Org::from_catalog`] instead of re-running this constructor.
    pub fn new(id: impl Into<String>, name: impl Into<String>, store: Option<Arc<Store>>) -> Self {
        let id = id.into();
        let name = name.into();
        let lobby = SpaceDescriptor::lobby();
        let dev = SpaceDescriptor::team("dev", "Dev");

        if let Some(s) = &store {
            s.upsert_org(&id, &name);
            s.insert_space(&id, &lobby, 0, 1);
            s.insert_space(&id, &dev, 1, 1);
        }

        let mut spaces = HashMap::new();
        let mut space_order = Vec::new();
        for desc in [lobby, dev] {
            space_order.push(desc.id.clone());
            spaces.insert(
                desc.id.clone(),
                SpaceState {
                    desc,
                    member_ids: HashSet::new(),
                },
            );
        }

        Self {
            id: Arc::from(id.as_str()),
            inner: Arc::new(Mutex::new(OrgInner {
                id,
                name,
                members: HashMap::new(),
                spaces,
                space_order,
                next_space_seq: 1,
            })),
            next_id: Arc::new(AtomicU64::new(1)),
            store,
        }
    }

    /// Rebuild an org from its persisted catalog (startup with `HIROBA_DB`).
    /// The persisted catalog wins over the default seed in [`Org::new`] — that
    /// constructor only ever runs for orgs with no persisted record.
    pub fn from_catalog(catalog: OrgCatalog, store: Option<Arc<Store>>) -> Self {
        let mut descs = catalog.spaces;
        // A crash between the org row and its lobby row could leave a catalog
        // without the lobby that `join()` assumes always exists; reseed it.
        if !descs.iter().any(|d| d.id == "lobby") {
            let lobby = SpaceDescriptor::lobby();
            if let Some(s) = &store {
                s.insert_space(&catalog.org_id, &lobby, 0, catalog.next_space_seq);
            }
            descs.insert(0, lobby);
        }

        let mut spaces = HashMap::new();
        let mut space_order = Vec::new();
        for desc in descs {
            space_order.push(desc.id.clone());
            spaces.insert(
                desc.id.clone(),
                SpaceState {
                    desc,
                    member_ids: HashSet::new(),
                },
            );
        }

        Self {
            id: Arc::from(catalog.org_id.as_str()),
            inner: Arc::new(Mutex::new(OrgInner {
                id: catalog.org_id,
                name: catalog.org_name,
                members: HashMap::new(),
                spaces,
                space_order,
                next_space_seq: catalog.next_space_seq,
            })),
            next_id: Arc::new(AtomicU64::new(1)),
            store,
        }
    }

    /// Tenant id (cheap, lock-free).
    pub fn id(&self) -> &str {
        &self.id
    }

    // -----------------------------------------------------------------------
    // Member lifecycle
    // -----------------------------------------------------------------------

    /// Register a new member (lands in the lobby) and return the full `welcome`.
    ///
    /// Broadcasts `presence` (the new member) to the rest of the org and
    /// `space_joined` to the other members already in the lobby.
    pub async fn join(
        &self,
        name: String,
        color: String,
        avatar: Option<String>,
        tx: mpsc::Sender<ServerMsg>,
    ) -> ServerMsg {
        let num_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let id = num_id.to_string();

        let mut guard = self.inner.lock().await;

        // Sanitise name: trim and cap at 32 chars.
        let name = name.trim().chars().take(32).collect::<String>();
        let name = if name.is_empty() {
            "Anonymous".to_string()
        } else {
            name
        };

        // Sanitise colour: strict `#RRGGBB` or the default (see is_hex_color).
        let color = if is_hex_color(&color) {
            color
        } else {
            DEFAULT_COLOR.to_string()
        };

        // Sanitise avatar: a small, well-formed image data URL or nothing
        // (see is_valid_avatar). Invalid avatars degrade to the initial disc.
        let avatar = avatar.filter(|a| is_valid_avatar(a));

        let space_id = "lobby".to_string();
        let lobby = guard
            .spaces
            .get("lobby")
            .expect("lobby always exists")
            .desc
            .clone();
        let (x, y) = guard.pick_spawn("lobby");

        let member = Member {
            id: id.clone(),
            num_id,
            name: name.clone(),
            color: color.clone(),
            avatar,
            space_id: space_id.clone(),
            x,
            y,
            muted: true, // FR-12: start muted
            away: false,
            dnd: false,
            paging: HashSet::new(),
            ringing_out: HashSet::new(),
            ringing_in: HashSet::new(),
            tx,
        };

        // Snapshots BEFORE inserting so they're "all others".
        let org = guard.org_info();
        let spaces = guard.catalog();
        let peers = guard.peers_in_space_except("lobby", &id);
        let roster = guard.roster_except(&id);
        let you = member.as_peer_info();

        // Tell existing lobby members + the org about the new member.
        let joined = ServerMsg::SpaceJoined {
            peer: member.as_peer_info(),
        };
        guard.broadcast_space_except("lobby", &id, joined);
        let presence = ServerMsg::Presence {
            member: member.as_roster_member(),
        };
        guard.broadcast_org_except(&id, presence);

        // Insert into the org + lobby.
        guard.members.insert(id.clone(), member);
        guard
            .spaces
            .get_mut("lobby")
            .unwrap()
            .member_ids
            .insert(id.clone());

        ServerMsg::Welcome {
            id,
            org,
            you,
            space_id,
            space: lobby,
            spaces,
            peers,
            roster,
        }
    }

    /// Remove a member and tear down all of their links.
    ///
    /// Broadcasts `space_left` to their space, `presence_left` to the org, and
    /// ends any active page links (notifying the partner + clearing in_call).
    pub async fn leave(&self, id: &str) {
        let mut guard = self.inner.lock().await;
        let Some(member) = guard.members.remove(id) else {
            return; // already gone
        };

        // Remove from its space + notify that space.
        if let Some(space) = guard.spaces.get_mut(&member.space_id) {
            space.member_ids.remove(id);
        }
        guard.broadcast_space_except(
            &member.space_id,
            id,
            ServerMsg::SpaceLeft { id: id.to_string() },
        );

        // End any established page links: tell the partner, clear in_call.
        for partner_id in &member.paging {
            if let Some(partner) = guard.members.get_mut(partner_id) {
                partner.paging.remove(id);
                let _ = partner.tx.try_send(ServerMsg::PageEnd {
                    from: id.to_string(),
                });
            }
        }
        let partners: Vec<String> = member.paging.iter().cloned().collect();
        for partner_id in partners {
            guard.broadcast_presence(&partner_id);
        }

        // Cancel outgoing rings (caller left) and drop incoming offers.
        for callee_id in &member.ringing_out {
            if let Some(callee) = guard.members.get_mut(callee_id) {
                callee.ringing_in.remove(id);
                let _ = callee.tx.try_send(ServerMsg::PageEnd {
                    from: id.to_string(),
                });
            }
        }
        for caller_id in &member.ringing_in {
            if let Some(caller) = guard.members.get_mut(caller_id) {
                caller.ringing_out.remove(id);
                let _ = caller.tx.try_send(ServerMsg::PageRejected {
                    to: id.to_string(),
                    reason: "offline".to_string(),
                });
            }
        }

        // Org-wide: this member left the roster.
        guard.broadcast_org_except(id, ServerMsg::PresenceLeft { id: id.to_string() });
    }

    // -----------------------------------------------------------------------
    // Space-scoped mutations
    // -----------------------------------------------------------------------

    /// Update a member's position within their current space (clamped).
    pub async fn set_pos(&self, id: &str, x: f64, y: f64) {
        let mut guard = self.inner.lock().await;
        // Look up bounds first (immutable borrow), then mutate the member.
        let bounds = guard
            .members
            .get(id)
            .and_then(|m| guard.spaces.get(&m.space_id))
            .map(|s| (s.desc.width, s.desc.height));
        if let (Some((w, h)), Some(member)) = (bounds, guard.members.get_mut(id)) {
            member.x = x.clamp(0.0, w);
            member.y = y.clamp(0.0, h);
        }
    }

    /// Update a member's mute state. Broadcasts `mute` to their space and
    /// `presence` to the org (mute is reflected in the roster too).
    pub async fn set_mute(&self, id: &str, muted: bool) {
        let mut guard = self.inner.lock().await;
        let space_id = match guard.members.get_mut(id) {
            Some(m) => {
                m.muted = muted;
                m.space_id.clone()
            }
            None => return,
        };
        guard.broadcast_space_except(
            &space_id,
            id,
            ServerMsg::Mute {
                id: id.to_string(),
                muted,
            },
        );
        guard.broadcast_presence(id);
    }

    /// Apply a partial status update (away / dnd) and broadcast `presence`.
    pub async fn set_status(&self, id: &str, away: Option<bool>, dnd: Option<bool>) {
        let mut guard = self.inner.lock().await;
        match guard.members.get_mut(id) {
            Some(m) => {
                if let Some(a) = away {
                    m.away = a;
                }
                if let Some(d) = dnd {
                    m.dnd = d;
                }
            }
            None => return,
        }
        guard.broadcast_presence(id);
    }

    /// Switch a member to another space. On success returns the snapshot to
    /// send to the mover and broadcasts `space_left`/`space_joined`/`presence`.
    pub async fn enter_space(&self, id: &str, target: &str) -> EnterOutcome {
        let mut guard = self.inner.lock().await;

        // Validate the member + target space.
        let Some(current_space_id) = guard.members.get(id).map(|m| m.space_id.clone()) else {
            return EnterOutcome::Error(ServerMsg::Error {
                code: "unknown_space".to_string(),
                message: "Not connected.".to_string(),
            });
        };
        if current_space_id == target {
            // Already here — re-send a snapshot so the client can resync.
            let space = guard.spaces[&current_space_id].desc.clone();
            let (x, y) = guard
                .members
                .get(id)
                .map(|m| (m.x, m.y))
                .unwrap_or((space.width / 2.0, space.height / 2.0));
            let peers = guard.peers_in_space_except(&current_space_id, id);
            return EnterOutcome::Snapshot(ServerMsg::SpaceSnapshot {
                space_id: current_space_id,
                space,
                you: PeerPos {
                    id: id.to_string(),
                    x,
                    y,
                },
                peers,
            });
        }
        let Some(target_space) = guard.spaces.get(target) else {
            return EnterOutcome::Error(ServerMsg::Error {
                code: "unknown_space".to_string(),
                message: format!("No such space: {target}"),
            });
        };
        let desc = target_space.desc.clone();
        let occupancy = target_space.member_ids.len() as u32;
        if occupancy >= desc.capacity {
            return EnterOutcome::Error(ServerMsg::Error {
                code: "space_full".to_string(),
                message: format!("Space is full ({}/{}).", occupancy, desc.capacity),
            });
        }

        // Leave the old space (notify its members).
        if let Some(old) = guard.spaces.get_mut(&current_space_id) {
            old.member_ids.remove(id);
        }
        guard.broadcast_space_except(
            &current_space_id,
            id,
            ServerMsg::SpaceLeft { id: id.to_string() },
        );

        // Spawn into the new space.
        let (x, y) = guard.pick_spawn(target);
        if let Some(member) = guard.members.get_mut(id) {
            member.space_id = target.to_string();
            member.x = x;
            member.y = y;
        }
        guard
            .spaces
            .get_mut(target)
            .unwrap()
            .member_ids
            .insert(id.to_string());

        // Tell the new space + the org.
        if let Some(member) = guard.members.get(id) {
            let joined = ServerMsg::SpaceJoined {
                peer: member.as_peer_info(),
            };
            guard.broadcast_space_except(target, id, joined);
        }
        guard.broadcast_presence(id);

        let peers = guard.peers_in_space_except(target, id);
        EnterOutcome::Snapshot(ServerMsg::SpaceSnapshot {
            space_id: target.to_string(),
            space: desc,
            you: PeerPos {
                id: id.to_string(),
                x,
                y,
            },
            peers,
        })
    }

    /// Create a new team space (FR-14) and broadcast the updated catalog.
    ///
    /// Refuses (creating nothing) when the org already holds
    /// [`MAX_SPACES_PER_ORG`] spaces — otherwise any guest could create spaces
    /// without bound (resource-exhaustion guard).
    pub async fn create_space(&self, name: String) -> CreateSpaceOutcome {
        let mut guard = self.inner.lock().await;

        if guard.spaces.len() >= MAX_SPACES_PER_ORG {
            return CreateSpaceOutcome::LimitReached;
        }

        let name = name.trim().chars().take(32).collect::<String>();
        let name = if name.is_empty() {
            "Team".to_string()
        } else {
            name
        };

        // Allocate a unique space id.
        let seq = guard.next_space_seq;
        guard.next_space_seq += 1;
        let mut space_id = format!("team{seq}");
        while guard.spaces.contains_key(&space_id) {
            let seq = guard.next_space_seq;
            guard.next_space_seq += 1;
            space_id = format!("team{seq}");
        }

        let desc = SpaceDescriptor::team(space_id.clone(), name);
        // Write-through before the in-memory insert: a crash in between leaves
        // the space persisted, which `from_catalog` restores cleanly. The
        // synchronous INSERT inside the tokio mutex is deliberate — space
        // creation is a rare, sub-millisecond, single-row write, so
        // spawn_blocking would add overhead without buying anything.
        if let Some(s) = &self.store {
            s.insert_space(
                &self.id,
                &desc,
                guard.space_order.len() as u64,
                guard.next_space_seq,
            );
        }
        guard.space_order.push(space_id.clone());
        guard.spaces.insert(
            space_id,
            SpaceState {
                desc,
                member_ids: HashSet::new(),
            },
        );

        let spaces = guard.catalog();
        // Broadcast to the whole org (including the creator).
        for m in guard.members.values() {
            let _ = m.tx.try_send(ServerMsg::Spaces {
                spaces: spaces.clone(),
            });
        }
        CreateSpaceOutcome::Created
    }

    // -----------------------------------------------------------------------
    // Paging (cross-space 1:1) — ring → accept/decline → connect
    // -----------------------------------------------------------------------

    /// Start a page from `from` to `to` (FR-10). Target must be online and not
    /// DND. On success the callee gets `page_offer` and the caller gets
    /// `page_ringing`; media/`in_call` only start after `page_accept`.
    pub async fn page(&self, from: &str, to: &str) -> PageOutcome {
        let mut guard = self.inner.lock().await;

        if from == to {
            return PageOutcome::Rejected("offline".to_string());
        }
        let Some(target) = guard.members.get(to) else {
            return PageOutcome::Rejected("offline".to_string());
        };
        if target.dnd {
            return PageOutcome::Rejected("dnd".to_string());
        }
        let Some(caller) = guard.members.get(from) else {
            return PageOutcome::Rejected("offline".to_string());
        };

        // Already live or already ringing this peer → treat as success (idempotent).
        if caller.paging.contains(to)
            || caller.ringing_out.contains(to)
            || caller.ringing_in.contains(to)
        {
            return PageOutcome::Ringing;
        }

        if let Some(a) = guard.members.get_mut(from) {
            a.ringing_out.insert(to.to_string());
        }
        if let Some(b) = guard.members.get_mut(to) {
            b.ringing_in.insert(from.to_string());
        }

        if let Some(a) = guard.members.get(from) {
            let _ = a.tx.try_send(ServerMsg::PageRinging {
                to: to.to_string(),
            });
        }
        if let Some(b) = guard.members.get(to) {
            let _ = b.tx.try_send(ServerMsg::PageOffer {
                from: from.to_string(),
            });
        }

        // Auto-decline if the callee never answers.
        let org = self.clone();
        let from_id = from.to_string();
        let to_id = to.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(PAGE_RING_TIMEOUT).await;
            org.page_timeout(&from_id, &to_id).await;
        });

        PageOutcome::Ringing
    }

    /// Accept an incoming page offer: `accepter` answers a ring from `caller`.
    /// Establishes the page link and instructs both peers to open WebRTC.
    pub async fn page_accept(&self, accepter: &str, caller: &str) {
        let mut guard = self.inner.lock().await;

        let pending = guard
            .members
            .get(accepter)
            .is_some_and(|m| m.ringing_in.contains(caller))
            && guard
                .members
                .get(caller)
                .is_some_and(|m| m.ringing_out.contains(accepter));
        if !pending {
            return;
        }

        // Clear ring state in both directions (handles simultaneous cross-pages).
        if let Some(a) = guard.members.get_mut(accepter) {
            a.ringing_in.remove(caller);
            a.ringing_out.remove(caller);
        }
        if let Some(c) = guard.members.get_mut(caller) {
            c.ringing_out.remove(accepter);
            c.ringing_in.remove(accepter);
        }

        let (caller_num, accepter_num) = match (guard.members.get(caller), guard.members.get(accepter))
        {
            (Some(c), Some(a)) => (c.num_id, a.num_id),
            _ => return,
        };

        if let Some(c) = guard.members.get_mut(caller) {
            c.paging.insert(accepter.to_string());
        }
        if let Some(a) = guard.members.get_mut(accepter) {
            a.paging.insert(caller.to_string());
        }

        // Initiator tie-break: smaller numeric id offers (avoids glare).
        let caller_initiates = caller_num < accepter_num;
        if let Some(c) = guard.members.get(caller) {
            let _ = c.tx.try_send(ServerMsg::PageConnect {
                peer: accepter.to_string(),
                initiator: caller_initiates,
            });
        }
        if let Some(a) = guard.members.get(accepter) {
            let _ = a.tx.try_send(ServerMsg::PageConnect {
                peer: caller.to_string(),
                initiator: !caller_initiates,
            });
        }

        guard.broadcast_presence(caller);
        guard.broadcast_presence(accepter);
    }

    /// End a live page, cancel an outgoing ring, or decline an incoming offer.
    pub async fn page_end(&self, from: &str, to: &str) {
        let mut guard = self.inner.lock().await;

        // Live link hang-up.
        let mut changed = Vec::new();
        let was_live = guard
            .members
            .get(from)
            .is_some_and(|m| m.paging.contains(to));
        if was_live {
            if let Some(a) = guard.members.get_mut(from) {
                if a.paging.remove(to) {
                    changed.push(from.to_string());
                }
            }
            if let Some(b) = guard.members.get_mut(to) {
                if b.paging.remove(from) {
                    let _ = b.tx.try_send(ServerMsg::PageEnd {
                        from: from.to_string(),
                    });
                    changed.push(to.to_string());
                }
            }
            for id in changed {
                guard.broadcast_presence(&id);
            }
            return;
        }

        // Caller cancels while ringing.
        let cancelled_out = guard
            .members
            .get(from)
            .is_some_and(|m| m.ringing_out.contains(to));
        if cancelled_out {
            if let Some(a) = guard.members.get_mut(from) {
                a.ringing_out.remove(to);
            }
            if let Some(b) = guard.members.get_mut(to) {
                b.ringing_in.remove(from);
                let _ = b.tx.try_send(ServerMsg::PageEnd {
                    from: from.to_string(),
                });
            }
            return;
        }

        // Callee declines while ringing.
        let declined = guard
            .members
            .get(from)
            .is_some_and(|m| m.ringing_in.contains(to));
        if declined {
            if let Some(a) = guard.members.get_mut(from) {
                a.ringing_in.remove(to);
            }
            if let Some(b) = guard.members.get_mut(to) {
                b.ringing_out.remove(from);
                let _ = b.tx.try_send(ServerMsg::PageRejected {
                    to: from.to_string(),
                    reason: "declined".to_string(),
                });
            }
        }
    }

    /// Auto-decline a still-pending ring after [`PAGE_RING_TIMEOUT`].
    async fn page_timeout(&self, caller: &str, callee: &str) {
        let mut guard = self.inner.lock().await;

        let still_pending = guard
            .members
            .get(caller)
            .is_some_and(|m| m.ringing_out.contains(callee))
            && guard
                .members
                .get(callee)
                .is_some_and(|m| m.ringing_in.contains(caller));
        if !still_pending {
            return;
        }

        if let Some(c) = guard.members.get_mut(caller) {
            c.ringing_out.remove(callee);
            let _ = c.tx.try_send(ServerMsg::PageRejected {
                to: callee.to_string(),
                reason: "timeout".to_string(),
            });
        }
        if let Some(a) = guard.members.get_mut(callee) {
            a.ringing_in.remove(caller);
            let _ = a.tx.try_send(ServerMsg::PageEnd {
                from: caller.to_string(),
            });
        }
    }

    // -----------------------------------------------------------------------
    // Signaling
    // -----------------------------------------------------------------------

    /// Relay a WebRTC signaling payload from `from_id` to `to_id`.
    ///
    /// A signal is only relayed when the two peers have a legitimate link:
    /// either an active **page** (`from` lists `to` in `paging`) or they share
    /// the **same space** (proximity audio is in-space). This prevents a client
    /// from injecting offers/candidates across spaces or to a peer it has no
    /// link with — which would otherwise bypass space isolation and the DND
    /// page gate. Silently drops if disallowed or `to` is not connected
    /// (PROTOCOL.md §signal).
    pub async fn route_signal(&self, from_id: &str, to_id: &str, data: serde_json::Value) {
        let guard = self.inner.lock().await;
        let (Some(from), Some(to)) = (guard.members.get(from_id), guard.members.get(to_id)) else {
            return;
        };
        let allowed = from.paging.contains(to_id) || from.space_id == to.space_id;
        if !allowed {
            return;
        }
        let _ = to.tx.try_send(ServerMsg::Signal {
            from: from_id.to_string(),
            data,
        });
    }

    // -----------------------------------------------------------------------
    // Read-only snapshots
    // -----------------------------------------------------------------------

    /// Per-space snapshot of all positions + writer handles under a SINGLE lock
    /// acquisition, so the `state` broadcast and proximity computation observe
    /// the exact same member set (no join/leave race between two locks).
    /// Only spaces with at least one member are returned (idle CPU stays low).
    pub async fn tick_snapshot(&self) -> Vec<SpaceTick> {
        let guard = self.inner.lock().await;
        let mut ticks = Vec::new();
        for space_id in &guard.space_order {
            let Some(space) = guard.spaces.get(space_id) else {
                continue;
            };
            if space.member_ids.is_empty() {
                continue;
            }
            let members: Vec<TickMember> = space
                .member_ids
                .iter()
                .filter_map(|id| guard.members.get(id))
                .map(|m| TickMember {
                    // The tick loop only reads id/x/y — leave the avatar out so
                    // we don't clone a multi-KB string per member 12×/second.
                    info: PeerInfo {
                        avatar: None,
                        ..m.as_peer_info()
                    },
                    num_id: m.num_id,
                    tx: m.tx.clone(),
                })
                .collect();
            ticks.push(SpaceTick {
                space_id: space_id.clone(),
                near_radius: space.desc.near_radius,
                far_radius: space.desc.far_radius,
                members,
            });
        }
        ticks
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_color_accepts_strict_rrggbb_only() {
        assert!(is_hex_color("#8a93a6"));
        assert!(is_hex_color("#4F9DDE")); // case-insensitive hex digits
        assert!(!is_hex_color("#f00")); // shorthand
        assert!(!is_hex_color("red")); // named
        assert!(!is_hex_color("#8a93a")); // too short
        assert!(!is_hex_color("#8a93a6f")); // too long
        assert!(!is_hex_color("8a93a6f")); // no hash
        assert!(!is_hex_color("#8a93g6")); // non-hex digit
        assert!(!is_hex_color("")); // empty
    }

    #[test]
    fn avatar_accepts_small_base64_image_data_urls_only() {
        assert!(is_valid_avatar("data:image/png;base64,iVBORw0KGgo="));
        assert!(is_valid_avatar("data:image/jpeg;base64,/9j/4AAQ"));
        assert!(is_valid_avatar("data:image/webp;base64,UklGRg+A"));
        assert!(!is_valid_avatar("data:image/svg+xml;base64,PHN2Zz4=")); // scriptable type
        assert!(!is_valid_avatar("data:image/png;base64,")); // empty payload
        assert!(!is_valid_avatar("data:image/png,iVBORw0KGgo=")); // not base64-marked
        assert!(!is_valid_avatar("https://example.com/a.png")); // remote URL
        assert!(!is_valid_avatar("data:image/png;base64,iVBOR<script>")); // non-base64 bytes
        let oversized = format!("data:image/png;base64,{}", "A".repeat(MAX_AVATAR_LEN));
        assert!(!is_valid_avatar(&oversized));
    }

    #[test]
    fn lobby_spawns_are_distinct_and_within_earshot_of_centre() {
        let lobby = SpaceDescriptor::lobby();
        let (cx, cy) = (lobby.width / 2.0, lobby.height / 2.0);
        let positions: Vec<(f64, f64)> = (0..u64::from(lobby.capacity))
            .map(|i| spawn_position(&lobby, i))
            .collect();
        for (i, &(x, y)) in positions.iter().enumerate() {
            // Every spawn is in earshot of a centre occupant (FR-08/FR-09:
            // "hear the room the moment you walk in").
            let d = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
            assert!(
                d < lobby.near_radius,
                "spawn {i} at distance {d} ≥ near_radius {}",
                lobby.near_radius
            );
            // …and never stacked on an earlier spawn.
            for (j, &(ox, oy)) in positions[..i].iter().enumerate() {
                let dd = ((x - ox).powi(2) + (y - oy).powi(2)).sqrt();
                assert!(dd > 1.0, "spawns {j} and {i} stack ({dd} apart)");
            }
        }
    }

    /// An OrgInner with `n` members parked exactly on spawn points 0..n of
    /// the given space, for spawn-collision tests.
    fn org_with_parked_members(desc: &SpaceDescriptor, n: usize) -> OrgInner {
        let (tx, _rx) = mpsc::channel(1);
        let mut members = HashMap::new();
        let mut member_ids = HashSet::new();
        for i in 0..n {
            let (x, y) = spawn_position(desc, i as u64);
            let id = i.to_string();
            members.insert(
                id.clone(),
                Member {
                    id: id.clone(),
                    num_id: i as u64,
                    name: format!("m{i}"),
                    color: DEFAULT_COLOR.to_string(),
                    avatar: None,
                    space_id: desc.id.clone(),
                    x,
                    y,
                    muted: true,
                    away: false,
                    dnd: false,
                    paging: HashSet::new(),
                    ringing_out: HashSet::new(),
                    ringing_in: HashSet::new(),
                    tx: tx.clone(),
                },
            );
            member_ids.insert(id);
        }
        let mut spaces = HashMap::new();
        spaces.insert(
            desc.id.clone(),
            SpaceState {
                desc: desc.clone(),
                member_ids,
            },
        );
        OrgInner {
            id: "org".to_string(),
            name: "Org".to_string(),
            members,
            spaces,
            space_order: vec![desc.id.clone()],
            next_space_seq: 0,
        }
    }

    #[test]
    fn pick_spawn_in_empty_space_is_centre() {
        let desc = SpaceDescriptor::team("t1", "Team");
        let org = org_with_parked_members(&desc, 0);
        assert_eq!(org.pick_spawn("t1"), (desc.width / 2.0, desc.height / 2.0));
    }

    #[test]
    fn respawn_after_departure_clears_parked_members() {
        let desc = SpaceDescriptor::team("t1", "Team");
        let mut org = org_with_parked_members(&desc, 3);
        // The middle member leaves: the next arrival reuses occupancy index 2,
        // whose plain spiral point is exactly where member "2" is parked.
        org.spaces.get_mut("t1").unwrap().member_ids.remove("1");
        org.members.remove("1");
        let (x, y) = org.pick_spawn("t1");
        for m in org.members.values() {
            let d = (m.x - x).hypot(m.y - y);
            assert!(
                d >= SPAWN_GAP,
                "spawn ({x:.0},{y:.0}) only {d:.0} wu from member {}",
                m.id
            );
        }
    }

    #[test]
    fn spawns_past_capacity_stay_in_bounds_and_distinct() {
        let lobby = SpaceDescriptor::lobby();
        let a = spawn_position(&lobby, u64::from(lobby.capacity) + 1);
        let b = spawn_position(&lobby, u64::from(lobby.capacity) + 2);
        for &(x, y) in [&a, &b] {
            assert!((0.0..=lobby.width).contains(&x));
            assert!((0.0..=lobby.height).contains(&y));
            let d = ((x - lobby.width / 2.0).powi(2) + (y - lobby.height / 2.0).powi(2)).sqrt();
            assert!(d < lobby.near_radius);
        }
        assert!(a != b, "past-capacity spawns must not stack");
    }
}
