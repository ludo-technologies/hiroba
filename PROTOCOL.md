# Hiroba Wire Protocol v2

This is the **authoritative contract** between the Hiroba server (`server/`) and
client (`client/`). Both implementations MUST match this document exactly. When
in doubt, this file wins.

v2 introduces **organizations (tenants)**, **multiple spaces** (a lobby + team
spaces) switched at runtime, an always-visible **org-wide roster**, and
**paging** (cross-space 1:1 "barge-in" voice). The proximity/WebRTC mechanics
from v1 are **reused**, now scoped to whichever space a client is currently in.

## Transport

- Single **WebSocket** connection per client, endpoint `GET /ws`.
- All frames are **UTF-8 JSON text frames**. No binary frames.
- Every message is a JSON object with a `"t"` field (string) discriminating the
  message type. Unknown message types MUST be ignored (forward-compat).
- The server also serves `GET /health` → `200 OK` body `ok` for liveness checks.

## Two scopes of state

The protocol carries two distinct kinds of state. Keeping them separate is the
core of v2:

| Scope     | What it is                                             | Who receives it                     |
|-----------|--------------------------------------------------------|-------------------------------------|
| **Org**   | The roster: every member's identity + status + which space they're in | **all** connected members of the org |
| **Space** | Positions, proximity, per-space peer entry/exit, audio | only members **currently in that space** |

A client is connected to exactly **one org** and present in exactly **one space**
at a time. The sidebar member list is driven by *org* messages; the 2D canvas is
driven by *space* messages.

## Identifiers & units

- `id`: peer identifier assigned by the server, one per connection. JSON
  **string** (e.g. `"7"`). Unique within the lifetime of the server process,
  never reused. Used both for the roster and for in-space positions/WebRTC.
- `org`: organization (tenant) identifier. JSON string.
- `spaceId`: space identifier, unique within an org. JSON string. The lobby has
  the well-known id `"lobby"`.
- Coordinates `x`, `y`: floating-point **world units**, per space. Origin
  top-left. A space is a rectangle `[0, width] × [0, height]`.
- `color`: CSS hex string `"#RRGGBB"`.
- `name`: display name, 1–32 chars after trimming. Server truncates/sanitizes.
- `muted`: boolean. A peer starts **muted** (`true`).
- `status`: one of `"active" | "away" | "dnd" | "in_call"` (server-computed; see
  §Presence & status).

## Authentication

The `token` carried in `hello` is resolved by the server to an org + identity:

- **Hosted**: `token` is a session token the desktop app obtains out-of-band via
  the OAuth/OIDC flow (browser round-trip). The server validates it and derives
  the org, a stable user identity, and a default name/color from the profile.
- **Self-host (guest)**: `token` MAY be empty/absent. The server places the
  client in its single configured org as a guest, using the supplied
  `name`/`color`.

The OAuth flow itself is out of scope for the wire protocol; only the resulting
`token` crosses the wire. Auth failure closes the socket after an `error` frame.

## Space configuration (server-authoritative)

Each space carries its own config, sent in `welcome` (current space) and in the
space catalog. Defaults:

| field        | lobby default | team default        | meaning                                              |
|--------------|---------------|---------------------|------------------------------------------------------|
| `width`      | 800           | 800                 | world width in units                                 |
| `height`     | 600           | 600                 | world height in units                                |
| `nearRadius` | 150           | ≥ space diagonal    | distance ≤ this ⇒ peers are "near" ⇒ audio connects  |
| `farRadius`  | 180           | ≥ space diagonal    | distance ≥ this ⇒ peers disconnect (hysteresis)      |
| `tickHz`     | 12            | 12                  | server position-broadcast rate (NFR-04: 10–15 Hz)    |
| `capacity`   | 5             | 5                   | max simultaneous members in the space                |

**Team spaces set `nearRadius`/`farRadius` to at least the space diagonal**, so
every member is always "near" everyone else → the space behaves as a single
group call. The **lobby** uses normal radii, so voice fades in by proximity as
in v1. The proximity engine and hysteresis are otherwise identical; only the
radii differ.

Proximity uses **hysteresis**: connect when distance crosses below `nearRadius`,
disconnect only when it rises above `farRadius`. Proximity is computed
**independently within each space**; peers in different spaces never connect.

## Space descriptor

Used in `welcome.spaces`, `welcome.space`, and `spaces` broadcasts:
```json
{ "id": "lobby", "name": "Lobby", "kind": "lobby",
  "width": 800, "height": 600, "nearRadius": 150, "farRadius": 180,
  "tickHz": 12, "capacity": 5 }
```
`kind` is `"lobby"` or `"team"`.

## Roster member descriptor

Used in `welcome.roster` and `presence`:
```json
{ "id": "3", "name": "Ren", "color": "#e0708a", "avatar": "data:image/webp;base64,…",
  "spaceId": "dev", "status": "active", "muted": false }
```
`spaceId` is the space the member is currently in. `status` is the effective
status (see §Presence & status). `avatar` is an optional user-uploaded profile
photo as a small `data:image/(png|jpeg|webp);base64,` URL (≤ 64 KB; validated
server-side, omitted when the member has none).

## Peer descriptor (space-scoped)

Used in `welcome.peers` and `space_joined`. This is the in-space view (has
position); the roster view (above) has status instead. `avatar` is optional,
same shape and rules as in the roster descriptor.
```json
{ "id": "3", "name": "Ren", "color": "#e0708a", "avatar": "data:image/webp;base64,…",
  "x": 400, "y": 220, "muted": false }
```

---

## Client → Server messages

### `hello` — authenticate and join the org (first message a client sends)
```json
{ "t": "hello", "token": "…opaque session token…", "name": "Aoi", "color": "#4f9dde",
  "avatar": "data:image/webp;base64,…" }
```
`token` is optional for self-host guests. `name`/`color`/`avatar` are optional
overrides of the profile/defaults. `avatar` is a user-uploaded profile photo as
a `data:image/(png|jpeg|webp);base64,` URL; the server drops it silently unless
it is well-formed and ≤ 64 KB. Server responds with `welcome`, then notifies
the org with `presence`. The client lands in the lobby by default.

### `enter_space` — switch the active space
```json
{ "t": "enter_space", "spaceId": "dev" }
```
Server moves the client out of its current space and into `spaceId`: it tears
down that client's in-space proximity links, sends a fresh space snapshot
(`welcome`-shaped subset, see `space_snapshot`), and broadcasts a `presence`
update (new `spaceId`) to the org. Rejected with `error` if the space is full or
unknown.

### `create_space` — create a new team space (FR-14)
```json
{ "t": "create_space", "name": "Design" }
```
Server creates a team space, assigns a `spaceId`, and broadcasts the updated
catalog via `spaces` to the org. (Permission to create may be restricted; see
requirements §9.)

### `move` — update own position within the current space (~tickHz, only when moving)
```json
{ "t": "move", "x": 812.0, "y": 430.5 }
```
Server clamps to the current space's bounds. Not echoed back to the sender.

### `mute` — change own mic state
```json
{ "t": "mute", "muted": false }
```
Broadcast to the current space (`mute`, server→client) **and** reflected in the
org roster via `presence`.

### `set_status` — set user-controllable status flags
```json
{ "t": "set_status", "away": true, "dnd": false }
```
Either field MAY be omitted (partial update). The server computes the effective
`status` (§Presence & status) and broadcasts a `presence` update to the org.
Clients SHOULD set `away: true` when they dim themselves on idle (NFR-01).

### `signal` — relay a WebRTC signaling payload to one peer
```json
{ "t": "signal", "to": "3", "data": { "...": "opaque SDP or ICE" } }
```
`data` is opaque and relayed verbatim. The server fills in `from` and delivers a
server→client `signal` to peer `to`. Used for **both** in-space proximity links
and page links. If `to` is not connected, the message is dropped silently.

### `page` — start a cross-space 1:1 "barge-in" voice link (FR-10)
```json
{ "t": "page", "to": "9" }
```
If `to` is offline or `dnd`, the server replies `page_rejected`. Otherwise the
server instructs **both** peers to open a 1:1 WebRTC link (`page_connect`, with
initiator tie-break) and sets both to `in_call`. The audio link is established
with the same `signal` relay used by proximity. Both peers' voice goes **live
immediately** (barge-in); the UI shows "in call" and offers a one-click hang-up.

### `page_end` — end a page link
```json
{ "t": "page_end", "to": "9" }
```
Server relays `page_end` (with `from`) to the other peer and clears both peers'
`in_call` status (back to their underlying status), broadcasting `presence`.

### `bye` — leave the org (optional; closing the socket is equivalent)
```json
{ "t": "bye" }
```

---

## Server → Client messages

### `welcome` — sent once, immediately after a successful `hello`
```json
{
  "t": "welcome",
  "id": "7",
  "org": { "id": "ludo", "name": "Ludo" },
  "you":  { "id": "7", "name": "Aoi", "color": "#4f9dde", "x": 800, "y": 600, "muted": true },
  "spaceId": "lobby",
  "space": { "id": "lobby", "name": "Lobby", "kind": "lobby", "width": 800, "height": 600, "nearRadius": 150, "farRadius": 180, "tickHz": 12, "capacity": 5 },
  "spaces": [
    { "id": "lobby", "name": "Lobby", "kind": "lobby", "width": 800, "height": 600, "nearRadius": 150, "farRadius": 180, "tickHz": 12, "capacity": 5 },
    { "id": "dev", "name": "Dev", "kind": "team", "width": 800, "height": 600, "nearRadius": 1100, "farRadius": 1100, "tickHz": 12, "capacity": 5 }
  ],
  "peers": [
    { "id": "3", "name": "Ren", "color": "#e0708a", "x": 400, "y": 220, "muted": false }
  ],
  "roster": [
    { "id": "3", "name": "Ren", "color": "#e0708a", "spaceId": "lobby", "status": "active", "muted": false },
    { "id": "9", "name": "Sora", "color": "#7ac77a", "spaceId": "dev", "status": "in_call", "muted": false }
  ]
}
```
- `you` is the joiner's own descriptor (with server-chosen spawn coords in the
  current space).
- `space` is the current space's config; `spaces` is the full catalog.
- `peers` is the roster of the **current space only** (excludes self), with
  positions.
- `roster` is the **org-wide** member list (excludes self), with status.

### `space_snapshot` — fresh space view after `enter_space`
```json
{
  "t": "space_snapshot",
  "spaceId": "dev",
  "space": { "id": "dev", "name": "Dev", "kind": "team", "width": 800, "height": 600, "nearRadius": 1100, "farRadius": 1100, "tickHz": 12, "capacity": 5 },
  "you": { "id": "7", "x": 400, "y": 300 },
  "peers": [ { "id": "9", "name": "Sora", "color": "#7ac77a", "x": 200, "y": 150, "muted": false } ]
}
```
Sent to the switching client only. `you.x/you.y` is the spawn position in the
new space. `peers` is that space's current roster (excluding self).

### `spaces` — space catalog changed (e.g. after `create_space`)
```json
{ "t": "spaces", "spaces": [ { "id": "lobby", "...": "…" }, { "id": "design", "...": "…" } ] }
```
Broadcast to the whole org. Clients replace their catalog.

### `presence` — org roster upsert (a member joined or changed)
```json
{ "t": "presence", "member": { "id": "9", "name": "Sora", "color": "#7ac77a", "spaceId": "dev", "status": "away", "muted": true } }
```
Broadcast to the whole org whenever a member joins, switches space, changes
mute, or changes status. Clients upsert by `id`.

### `presence_left` — a member disconnected from the org
```json
{ "t": "presence_left", "id": "9" }
```
Remove the member from the roster. (Whether to keep offline members listed is a
client/product choice; the wire simply reports disconnect.)

### `space_joined` — a peer entered **your current space**
```json
{ "t": "space_joined", "peer": { "id": "9", "name": "Sora", "color": "#7ac77a", "x": 520, "y": 320, "muted": true } }
```

### `space_left` — a peer left **your current space** (switched away or disconnected)
```json
{ "t": "space_left", "id": "9" }
```
This concerns the 2D view only. The peer may still be in the org roster (they
switched to another space) — that is reflected separately by `presence`.

### `state` — batched position snapshot for your current space (~tickHz)
```json
{ "t": "state", "peers": [ { "id": "3", "x": 410.0, "y": 225.0 } ] }
```
Contains every peer in your current space **except** the recipient. Positions
only. A tick with no peers may be skipped.

### `mute` — a peer in your current space changed mic state
```json
{ "t": "mute", "id": "3", "muted": true }
```

### `proximity` — which in-space P2P audio links to open/close
```json
{
  "t": "proximity",
  "connect":    [ { "id": "3", "initiator": true } ],
  "disconnect": [ "9" ]
}
```
Sent only when the recipient's in-space proximity set changes. For each
`connect` entry, if `initiator` is `true` this client creates the WebRTC offer;
otherwise it waits for one. **Tie-break (server-enforced):** in any near pair the
peer with the **numerically smaller id** is the initiator (avoids glare).
`disconnect` lists peer ids whose link MUST be torn down. Computed per space.

### `page_connect` — open a 1:1 page link (sent to both peers)
```json
{ "t": "page_connect", "peer": "3", "initiator": true }
```
Establish a 1:1 WebRTC link to `peer` using the `signal` relay. Same initiator
tie-break as proximity. Mark this as a **page** link (cross-space, shown as "in
call"), distinct from proximity links. Voice goes live immediately.

### `page_rejected` — a page could not be placed
```json
{ "t": "page_rejected", "to": "9", "reason": "dnd" }
```
`reason` is `"dnd"` or `"offline"`. Sent to the caller only.

### `page_end` — a page link ended
```json
{ "t": "page_end", "from": "9" }
```
Tear down the page link to `from`. Sent when the peer hangs up or disconnects.

### `signal` — relayed WebRTC signaling from another peer
```json
{ "t": "signal", "from": "3", "data": { "...": "opaque" } }
```

### `error` — a request failed
```json
{ "t": "error", "code": "space_full", "message": "Team is full (5/5)." }
```
Codes: `auth_failed`, `space_full`, `space_limit`, `unknown_space`,
`forbidden`. On
`auth_failed` the server closes the socket after sending this frame.

---

## Presence & status

The server computes each member's **effective** `status` with this priority:

```
in_call  >  dnd  >  away  >  active
```

- `in_call` — set while the member has an active page link (server-managed).
- `dnd` / `away` — user-controllable via `set_status`. `dnd` blocks incoming
  pages; `away` is a soft idle indicator the client sets on inactivity.
- `active` — present in a space, available.

Any change to status, `spaceId`, or `muted` triggers a `presence` broadcast.

## WebRTC signaling payloads (`data` field)

Produced and consumed only by clients; opaque to the server. Convention:
```json
{ "kind": "offer",     "sdp": "..." }
{ "kind": "answer",    "sdp": "..." }
{ "kind": "candidate", "candidate": { "candidate": "...", "sdpMid": "...", "sdpMLineIndex": 0 } }
{ "kind": "video-mode", "mode": "screen" | "camera" | null }
```
`video-mode` labels the sender's outgoing video track on a page link (screen
share vs. camera; `null` = video stopped) — sent alongside `addTrack`/
`removeTrack` renegotiation, since a bare WebRTC `track` event can't tell the
two apart. Page-only; screen share and camera are mutually exclusive on one
sender.

**ICE servers:** self-host clients use public STUN
(`stun:stun.l.google.com:19302`) by default. **Hosted clients MUST also use a
TURN server** (delivered via the desktop app's config, not this wire protocol),
so connections succeed behind symmetric NAT / corporate firewalls. The same
signaling applies to both proximity and page links.

## Spatial audio (client-side)

For each connected peer the client knows the peer's position (from `state`,
within the current space) and its own. It sets the remote audio **gain** by
distance `d`:
```
gain = clamp(1 - d / nearRadius, 0, 1)   // 1.0 at d=0, 0 at d ≥ nearRadius
```
In team spaces `nearRadius ≥ diagonal`, so gain ≈ 1 for everyone (group call).
In the lobby, gain falls off with distance (proximity voice). Page links are
1:1 and always full-gain (no spatialization). Applied via a Web Audio
`GainNode`; updates every animation frame (cheap).

## Lifecycle summary

```
client                         server
  |  ── WS connect ──────────────▶ |
  |  ── hello{token,name,color,avatar} ─▶ |  (validate token → org + identity)
  |  ◀──────── welcome{...}        |  (current space + catalog + org roster)
  |                                |  (broadcast presence to the org)
  |  ── move/mute/signal ────────▶ |  (within current space)
  |  ◀── state (every tick) ────── |
  |  ◀── proximity (on change) ─── |
  |  ◀── space_joined/space_left ─ |  (your space's 2D view)
  |  ◀── presence/presence_left ── |  (org roster updates)
  |                                |
  |  ── enter_space{spaceId} ────▶ |
  |  ◀── space_snapshot{...}       |  (+ presence broadcast: new spaceId)
  |                                |
  |  ── page{to} ────────────────▶ |  (DND/offline → page_rejected)
  |  ◀── page_connect{peer,init}   |  (to both peers; in_call)
  |  ── signal ⇄ signal ─────────▶ |  (establish 1:1 link)
  |  ── page_end{to} ────────────▶ |
  |  ◀── page_end{from}            |  (+ presence: clear in_call)
  |                                |
  |  ── bye / close ─────────────▶ |  (broadcast presence_left to the org)
```
