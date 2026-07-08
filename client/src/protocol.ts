/**
 * protocol.ts — Hiroba wire-protocol types (client side, v2).
 *
 * This file is the single source of truth for the TypeScript type system.
 * It mirrors PROTOCOL.md exactly. When the protocol changes, update this
 * file first and let the compiler surface every breakage site.
 *
 * v2 splits state into two scopes (PROTOCOL.md §"Two scopes of state"):
 *   - Org   scope → the roster (identity + status + which space), org-wide,
 *     drives the sidebar member list.
 *   - Space scope → positions / proximity / entry-exit / audio, per space,
 *     drives the 2D canvas.
 *
 * All discriminated unions key on the `"t"` field so that exhaustive switch
 * statements compile cleanly under `noImplicitReturns`.
 */

// ---------------------------------------------------------------------------
// Shared entity types
// ---------------------------------------------------------------------------

/** Organization (tenant) identity, received in `welcome`. */
export interface Org {
  id: string;
  name: string;
}

/** What a space is for. `team` spaces behave as a single group call. */
export type SpaceKind = "lobby" | "team";

/**
 * Effective member status (server-computed).
 * Priority, highest first: `in_call > dnd > away > active`.
 */
export type Status = "active" | "away" | "dnd" | "in_call";

/**
 * Per-space configuration + identity. Received in `welcome.space`,
 * `welcome.spaces`, `space_snapshot.space`, and `spaces` broadcasts.
 * Clients MUST use these values rather than hard-coded constants.
 */
export interface SpaceDescriptor {
  id: string;
  name: string;
  kind: SpaceKind;
  width: number;
  height: number;
  /** Peers within this distance get a P2P audio link. */
  nearRadius: number;
  /** Hysteresis: P2P link drops only when distance exceeds this. */
  farRadius: number;
  /** Position-broadcast rate in Hz. Throttle `move` sends to this. */
  tickHz: number;
  /** Max simultaneous members in the space. */
  capacity: number;
}

/**
 * A peer as seen in the *current space* (has position).
 * Used in `welcome.peers`, `space_snapshot.peers`, and `space_joined.peer`.
 */
export interface Peer {
  id: string;
  name: string;
  color: string;
  /** Optional uploaded avatar as a small `data:image/...;base64,` URL. */
  avatar?: string;
  x: number;
  y: number;
  muted: boolean;
}

/**
 * A roster (org-scoped) member — the sidebar view. Has `spaceId` + `status`
 * instead of a position. Used in `welcome.roster` and `presence.member`.
 */
export interface RosterMember {
  id: string;
  name: string;
  color: string;
  /** Optional uploaded avatar as a small `data:image/...;base64,` URL. */
  avatar?: string;
  spaceId: string;
  status: Status;
  muted: boolean;
}

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

/**
 * First message after connecting: authenticate + join the org.
 * `token` resolves to an org + identity (absent/empty → self-host guest).
 * `name`/`color`/`avatar` optionally override the profile/defaults.
 */
export interface HelloMsg {
  t: "hello";
  token?: string;
  name?: string;
  color?: string;
  /** Uploaded avatar as a small `data:image/...;base64,` URL. */
  avatar?: string;
}

/** Switch the active space. */
export interface EnterSpaceMsg {
  t: "enter_space";
  spaceId: string;
}

/** Create a new team space (FR-14). */
export interface CreateSpaceMsg {
  t: "create_space";
  name: string;
}

/** Position update, sent at ~tickHz only when the position changed. */
export interface MoveMsg {
  t: "move";
  x: number;
  y: number;
}

/** Microphone mute state change. */
export interface MuteMsg {
  t: "mute";
  muted: boolean;
}

/** Set user-controllable status flags. Either field may be omitted. */
export interface SetStatusMsg {
  t: "set_status";
  away?: boolean;
  dnd?: boolean;
}

/**
 * WebRTC signaling relay (proximity OR page link). `data` is opaque SDP/ICE;
 * the server fills in `from` before forwarding to `to`.
 */
export interface SignalMsg {
  t: "signal";
  to: string;
  data: SignalData;
}

/** Start a cross-space 1:1 "barge-in" voice link (FR-10). */
export interface PageMsg {
  t: "page";
  to: string;
}

/** End a page link. */
export interface PageEndMsg {
  t: "page_end";
  to: string;
}

/** Graceful leave (closing the socket is equivalent). */
export interface ByeMsg {
  t: "bye";
}

/** Union of all messages the client sends to the server. */
export type ClientMsg =
  | HelloMsg
  | EnterSpaceMsg
  | CreateSpaceMsg
  | MoveMsg
  | MuteMsg
  | SetStatusMsg
  | SignalMsg
  | PageMsg
  | PageEndMsg
  | ByeMsg;

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

/**
 * Sent once, immediately after `hello`. Carries both scopes: the current
 * space (+ catalog + in-space peers) and the org-wide roster.
 */
export interface WelcomeMsg {
  t: "welcome";
  id: string;
  org: Org;
  you: Peer;
  spaceId: string;
  space: SpaceDescriptor;
  spaces: SpaceDescriptor[];
  /** Peers in the current space only (excludes self), with positions. */
  peers: Peer[];
  /** Org-wide member list (excludes self), with status. */
  roster: RosterMember[];
}

/** Fresh space view sent to the switching client after `enter_space`. */
export interface SpaceSnapshotMsg {
  t: "space_snapshot";
  spaceId: string;
  space: SpaceDescriptor;
  /** Spawn position in the new space. */
  you: { id: string; x: number; y: number };
  peers: Peer[];
}

/** Space catalog changed (e.g. after `create_space`). Replace the catalog. */
export interface SpacesMsg {
  t: "spaces";
  spaces: SpaceDescriptor[];
}

/** Org roster upsert (a member joined or changed). Upsert by `id`. */
export interface PresenceMsg {
  t: "presence";
  member: RosterMember;
}

/** A member disconnected from the org. */
export interface PresenceLeftMsg {
  t: "presence_left";
  id: string;
}

/** A peer entered your current space. */
export interface SpaceJoinedMsg {
  t: "space_joined";
  peer: Peer;
}

/** A peer left your current space (switched away or disconnected). */
export interface SpaceLeftMsg {
  t: "space_left";
  id: string;
}

/**
 * Batched position snapshot broadcast every tick (current space).
 * Contains all peers except the recipient. Only positions are updated here.
 */
export interface StateMsg {
  t: "state";
  peers: Array<{ id: string; x: number; y: number }>;
}

/** A peer in your current space changed their microphone mute state. */
export interface PeerMuteMsg {
  t: "mute";
  id: string;
  muted: boolean;
}

/**
 * Which in-space P2P audio links to open or close (computed per space).
 * Sent only when the recipient's proximity set changes.
 */
export interface ProximityMsg {
  t: "proximity";
  connect: Array<{ id: string; initiator: boolean }>;
  disconnect: string[];
}

/** Open a 1:1 page link (sent to both peers). Same tie-break as proximity. */
export interface PageConnectMsg {
  t: "page_connect";
  peer: string;
  initiator: boolean;
}

/** A page could not be placed. `reason` is "dnd" or "offline". */
export interface PageRejectedMsg {
  t: "page_rejected";
  to: string;
  reason: "dnd" | "offline";
}

/** A page link ended (peer hung up or disconnected). */
export interface PageEndedMsg {
  t: "page_end";
  from: string;
}

/** Relayed WebRTC signaling from another peer. */
export interface ServerSignalMsg {
  t: "signal";
  from: string;
  data: SignalData;
}

/** A request failed. */
export interface ErrorMsg {
  t: "error";
  code: "auth_failed" | "space_full" | "unknown_space" | "forbidden";
  message: string;
}

/** Union of all messages the server sends to the client. */
export type ServerMsg =
  | WelcomeMsg
  | SpaceSnapshotMsg
  | SpacesMsg
  | PresenceMsg
  | PresenceLeftMsg
  | SpaceJoinedMsg
  | SpaceLeftMsg
  | StateMsg
  | PeerMuteMsg
  | ProximityMsg
  | PageConnectMsg
  | PageRejectedMsg
  | PageEndedMsg
  | ServerSignalMsg
  | ErrorMsg;

// ---------------------------------------------------------------------------
// WebRTC signaling payloads (`data` field — client-to-client convention)
// ---------------------------------------------------------------------------

export interface OfferData {
  kind: "offer";
  sdp: string;
}

export interface AnswerData {
  kind: "answer";
  sdp: string;
}

export interface CandidateData {
  kind: "candidate";
  candidate: {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
  };
}

/** Which purpose (if any) the sender's outgoing video track currently serves.
 *  Sent alongside track add/remove so the receiver can label the panel —
 *  WebRTC track events alone can't distinguish screen-share from camera. */
export interface VideoModeData {
  kind: "video-mode";
  mode: "screen" | "camera" | null;
}

/** Discriminated union for all WebRTC signal payloads. */
export type SignalData = OfferData | AnswerData | CandidateData | VideoModeData;
