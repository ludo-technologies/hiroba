/**
 * render.ts — Canvas 2D renderer for Hiroba.
 *
 * Hiroba is a virtual office: a warm, furnished, top-down floor where presence
 * has *context*. Rather than dots floating in an empty void, people gather in
 * recognisable places. The floor plan depends on the space kind:
 *  - Lobby: Focus / Meeting / Lounge / Café / Commons — open ambient floor.
 *    Meeting is a walled room (its rectangle comes from the server, which
 *    uses the same one as the audio boundary): soundproof, walked into
 *    through the wall like any other furniture.
 *  - Team: a small room (group call) in the layout chosen at creation —
 *    meeting table, desk island, lounge, or café counter.
 * Seats are clickable: walk-to-snap so idle people rest on furniture instead of
 * scattering across open floor.
 *
 * The picture is a *lit room*, not a diagram. Tall windows on the far wall
 * let daylight fall across the floor, and the light follows the real clock:
 * gold in the morning, clear at noon, amber at dusk, and after dark the
 * windows go blue while the desk lamps and pendants take over. People are
 * drawn above the lighting pass, so they stay bright at any hour — they are
 * the reason the room exists.
 *
 * Design philosophy: presence-first and *calm*. The renderer does NOT own a
 * rAF loop — `main.ts` drives a demand-driven loop and calls `draw`. Every
 * static part of the scene (floor, walls, furniture, light) is painted once
 * into an offscreen cache and composited per frame; the cache is rebuilt only
 * when the viewport, the space, the board or the light step (a few minutes
 * of the clock) changes, so a quiet office still repaints nothing (NFR-01).
 *
 * All scene coordinates are computed in *physical* pixels (clientSize × dpr),
 * so we never double-apply devicePixelRatio.
 */

import {
  rectContains,
  type Peer,
  type Rect,
  type SpaceDescriptor,
  type Status,
  type TeamLayout,
} from "./protocol.js";
import { boardGeometry, type BoardGeometry } from "./board.js";

// ---------------------------------------------------------------------------
// Per-frame voice levels handed in by main.ts (decoupled from the audio engine)
// ---------------------------------------------------------------------------

export interface FrameLevels {
  /** Smoothed 0..1 speaking level for self (0 while muted). */
  selfLevel: number;
  /** Smoothed 0..1 speaking level for a remote peer (0 if silent/unknown). */
  levelOf(id: string): number;
}

export interface RenderActivity {
  highRate: boolean;
  lowRate: boolean;
}

export interface RendererOptions {
  /**
   * Local hour of day (0..24, fractional) used for the lighting. Defaults to
   * the wall clock; a preview or a test pins it.
   */
  hourOfDay?: () => number;
}

// ---------------------------------------------------------------------------
// Internal render state
// ---------------------------------------------------------------------------

interface RenderPeer extends Peer {
  /** Org-wide effective status (away / dnd / in_call / active). */
  status: Status;
  /** Last server-reported position (the interpolation target). */
  targetX: number;
  targetY: number;
  /** Interpolated on-screen position, eased toward target each frame. */
  x: number;
  y: number;
  /** Spawn progress 0→1 (fade + grow in). */
  spawn: number;
  /** Set when the peer is leaving; `leave` fades 1→0, then we drop them. */
  leaving: boolean;
  leave: number;
}

// ---------------------------------------------------------------------------
// Floor plan — a furnished office, described in world units. Built once per
// `init`. Furniture is static; the renderer paints it into the scene cache.
// ---------------------------------------------------------------------------

type Side = "top" | "bottom" | "left" | "right";

type FloorItem =
  | { kind: "rug"; x: number; y: number; w: number; h: number; color: string; label?: string }
  | { kind: "rugRound"; x: number; y: number; r: number; color: string; label?: string }
  | {
      kind: "table";
      x: number;
      y: number;
      w: number;
      h: number;
      round: boolean;
      /** Light oak (desks) or walnut (meeting / café). */
      tone: "oak" | "walnut";
    }
  /** A stool, with an optional chair back on `back` (radians from centre). */
  | { kind: "stool"; x: number; y: number; r: number; back?: number }
  /** Upholstered seat; the backrest runs along `back`. */
  | { kind: "couch"; x: number; y: number; w: number; h: number; back: Side }
  | { kind: "plant"; x: number; y: number; r: number; variant: "bush" | "palm" }
  | { kind: "board"; x: number; y: number; w: number; h: number }
  /** A walled room: floor and walls, with a whiteboard on its far wall. */
  | { kind: "room"; x: number; y: number; w: number; h: number; label: string }
  /** Props that catch the light. */
  | { kind: "monitor"; x: number; y: number; w: number }
  | { kind: "mug"; x: number; y: number; r: number }
  | { kind: "deskLamp"; x: number; y: number }
  | { kind: "pendant"; x: number; y: number; r: number }
  | { kind: "floorLamp"; x: number; y: number }
  | { kind: "machine"; x: number; y: number; w: number; h: number }
  | { kind: "shelf"; x: number; y: number; w: number; h: number }
  | { kind: "book"; x: number; y: number; w: number; h: number; color: string };

/** A sit target in world units. Click-to-sit walks here; tokens near a seat
 *  draw slightly smaller so idle people read as "at a desk / chair". */
interface Seat {
  x: number;
  y: number;
  /** Click hit radius in world units (larger than the stool for forgiving taps). */
  hitR: number;
}

/** A window on the far (top) wall, as a world-x span. Light falls from it. */
interface Window {
  x: number;
  w: number;
}

interface FloorPlan {
  items: FloorItem[];
  seats: Seat[];
  board: BoardGeometry;
  windows: Window[];
}

// ---------------------------------------------------------------------------
// Visual constants
// ---------------------------------------------------------------------------

// Person tokens are sized in *world units* (not screen px) so they keep a
// fixed proportion to the floor at any window size. Lobby and team spaces
// share the same 800×600 footprint, so avatars render at the same scale.
//
// Text sizes below are *base* canvas px at scale=1 (1 world unit = 1 CSS px
// on a 1× display). The canvas backing store is physical pixels
// (clientSize × dpr) with no ctx.scale(), so every draw call in the dynamic
// pass must multiply by the current room `scale`.
const PEER_RADIUS = 34; // world units
const SELF_RADIUS = 38; // world units
/** Within this distance of a seat centre, the token uses the seated pose. */
const SEAT_SIT_EPS = 14;
/** Seated tokens shrink slightly so they sit *on* the furniture, not over it. */
const SEAT_SIT_SCALE = 0.88;
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';
/** Name-chip text size at scale=1; multiply by scale when setting ctx.font. */
const FONT_LABEL_PX = 12.5;
/** Zone signage text size in world units. */
const FONT_ZONE_PX = 11.5;

// The room has walls outside the walkable world rectangle: the far wall is
// seen in elevation (it carries the windows), the others as thin caps. The
// view fits the walls too, so they are never cut off.
const WALL_FAR_H = 48; // elevation band above y=0, world units
const WALL_CAP = 11; // top-down thickness of the side / near walls
const VIEW_PAD_X = WALL_CAP + 10;
const VIEW_PAD_TOP = WALL_FAR_H + 10;
const VIEW_PAD_BOTTOM = WALL_CAP + 10;

const FRAME_BG = "#241f1a"; // outside the room — matches the chrome's --frame

// Materials.
const FLOOR_BASE = "#e3d2b4"; // oak, mid tone
const FLOOR_LIGHT = "#e9d9bc";
const FLOOR_DARK = "#dbc9a8";
const FLOOR_SEAM = "rgba(96,66,34,0.13)";
const PLASTER = "#efe5d6"; // the far wall's face
const PLASTER_SHADE = "#d9ccb8";
const BASEBOARD = "#6f5744";
const WALL_CAP_COLOR = "#7b644f";
const WALL_CAP_HI = "#96806a";
const WINDOW_FRAME = "#5a4738";
const WINDOW_SILL = "#f6efe2";

const OAK = "#d6b78b";
const OAK_SIDE = "#b3915f";
const WALNUT = "#a8794c";
const WALNUT_SIDE = "#7f5733";
const WOOD_EDGE = "rgba(60,38,18,0.35)";
const UPHOLSTERY = "#9ea9b0";
const UPHOLSTERY_HI = "#b6c0c5";
const UPHOLSTERY_LO = "#86929a";
const POT = "#b7724d";
const POT_SIDE = "#8f5536";
const LEAF = "#6c9a52";
const LEAF_HI = "#8bb86b";
const LEAF_LO = "#4f7a3b";
const BOARD_FACE = "#f8f1e4";
const BOARD_FRAME = "#8a6540";
const BOARD_BADGE = "#b54f2c"; // note count (the UI accent)
const WHITEBOARD = "#fbfaf6";
const METAL = "#8e9196";
const SHADE = "#f1dfbf"; // lampshades
const GLOW = "255,196,120"; // lamp light, rgb

// Zone rugs — woven, muted, distinct.
const RUG_FOCUS = "#d8b7a6"; // dusty rose
const RUG_MEET = "#b8c8d2"; // slate — the meeting room's floor
const RUG_LOUNGE = "#bfcbae"; // sage
const RUG_CAFE = "#e2c893"; // straw
const RUG_COMMONS = "#d7c2a4"; // jute

const ZONE_INK = "rgba(70,52,34,0.55)";

// Inner walls (the meeting room): wood caps like the perimeter.
const WALL_T = 8;
/** Shade the room floor casts along its own walls, world units. */
const WALL_SHADE = 18;

// The one accent: warm clay/coral, for the proximity ring & self.
// Matches --accent (#b54f2c) so canvas chrome tracks the AA-safe UI tokens.
const NEAR_FILL = "rgba(181,79,44,0.07)";
const NEAR_STROKE = "rgba(181,79,44,0.30)";

// Speaking ripples.
const RIPPLE_COUNT = 2;
const RIPPLE_PERIOD = 1.9; // seconds for one ring to travel its full reach

// Status ring colours — matched to the sidebar chrome.
const STATUS_AWAY_RING = "rgba(122, 107, 85, 0.9)"; // --ink-mute
const STATUS_DND_RING = "rgba(184, 72, 48, 0.95)"; // --danger
const STATUS_CALL_RING = "#4f7a3a"; // --sage
const STATUS_CALL_PULSE_PERIOD = 1.7;

// Easing time-constants (seconds). Smaller = snappier. Frame-rate independent
// via 1 - exp(-dt/tau), so behaviour is identical at 30 or 144 Hz.
const PEER_LERP_TAU = 0.09;
const ANIM_TAU = 0.18; // spawn / leave fades

// A position within this many world units of its target is "settled".
const SETTLE_EPS = 0.3;

/** The light is re-sampled on this grid of the clock (minutes). */
const LIGHT_STEP_MIN = 5;
/** How often the renderer checks whether the light step moved on. */
const LIGHT_POLL_MS = 30_000;

// ---------------------------------------------------------------------------
// Light — the room follows the local clock
// ---------------------------------------------------------------------------

interface Light {
  /** What the windows show. */
  sky: string;
  /** 0..1 strength of daylight through the windows. */
  sun: number;
  /** Colour of the daylight pools on the floor. */
  sunColor: string;
  /** Ambient tint multiplied over the whole room at full `ambientA`; a
   *  lower strength blends the tint toward white (no tint). */
  ambient: string;
  ambientA: number;
  /** 0..1 how brightly the lamps burn. */
  lamp: number;
  /** Horizontal lean of the light pools (+ right) as a fraction of their length. */
  skew: number;
  /** Length of the light pools as a fraction of the room height. */
  reach: number;
}

type LightKey = Light & { h: number };

/** Keyframes around the clock; the light between two is a blend. */
const LIGHT_KEYS: LightKey[] = [
  { h: 0, sky: "#1a2340", sun: 0, sunColor: "#ffd9a0", ambient: "#6b7aa8", ambientA: 1, lamp: 1, skew: 0, reach: 0.5 },
  { h: 5, sky: "#2b355a", sun: 0.08, sunColor: "#ffc9b0", ambient: "#6a759e", ambientA: 0.9, lamp: 0.9, skew: 0.55, reach: 0.8 },
  { h: 6.5, sky: "#b48da6", sun: 0.5, sunColor: "#ffcf9e", ambient: "#f1c9a2", ambientA: 0.6, lamp: 0.3, skew: 0.55, reach: 0.82 },
  { h: 9, sky: "#b9d4ee", sun: 0.85, sunColor: "#ffe6bd", ambient: "#ffffff", ambientA: 0, lamp: 0, skew: 0.32, reach: 0.6 },
  { h: 12.5, sky: "#a8cdee", sun: 0.95, sunColor: "#fff1d6", ambient: "#ffffff", ambientA: 0, lamp: 0, skew: 0, reach: 0.42 },
  { h: 15.5, sky: "#c3d6e6", sun: 0.85, sunColor: "#ffe2ae", ambient: "#e9dccb", ambientA: 0.6, lamp: 0, skew: -0.3, reach: 0.58 },
  { h: 17.5, sky: "#5a4f80", sun: 0.65, sunColor: "#ffa460", ambient: "#9a8fa8", ambientA: 0.95, lamp: 0.45, skew: -0.5, reach: 0.82 },
  { h: 19, sky: "#38325c", sun: 0.22, sunColor: "#ff9a72", ambient: "#6f6490", ambientA: 0.95, lamp: 0.85, skew: -0.55, reach: 0.82 },
  { h: 20.5, sky: "#1f2847", sun: 0, sunColor: "#ffd9a0", ambient: "#6b7aa8", ambientA: 1, lamp: 1, skew: 0, reach: 0.5 },
  { h: 24, sky: "#1a2340", sun: 0, sunColor: "#ffd9a0", ambient: "#6b7aa8", ambientA: 1, lamp: 1, skew: 0, reach: 0.5 },
];

function lightAt(hour: number): Light {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < LIGHT_KEYS.length - 2 && LIGHT_KEYS[i + 1].h <= h) i++;
  const a = LIGHT_KEYS[i];
  const b = LIGHT_KEYS[i + 1];
  const t = smooth((h - a.h) / (b.h - a.h));
  return {
    sky: mixHex(a.sky, b.sky, t),
    sun: lerp(a.sun, b.sun, t),
    sunColor: mixHex(a.sunColor, b.sunColor, t),
    ambient: mixHex(a.ambient, b.ambient, t),
    ambientA: lerp(a.ambientA, b.ambientA, t),
    lamp: lerp(a.lamp, b.lamp, t),
    skew: lerp(a.skew, b.skew, t),
    reach: lerp(a.reach, b.reach, t),
  };
}

/** Furniture shadows follow the strongest light: long and leaning by day,
 *  short and straight under the lamps at night. */
function shadowOf(light: Light): { dx: number; dy: number; alpha: number } {
  return {
    dx: light.skew * 7 * light.sun,
    dy: 4 + 6 * light.sun * light.reach,
    alpha: 0.14 + 0.1 * light.sun,
  };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly hourOfDay: () => number;

  private space: SpaceDescriptor | null = null;
  private self: RenderPeer | null = null;
  private peers = new Map<string, RenderPeer>();

  /** The current space's furniture, seats, windows (built in `init`). */
  private plan: FloorPlan | null = null;

  /** Click-to-walk destination marker, in world units (null = none). */
  private walkTarget: { x: number; y: number } | null = null;

  /** Peer id under the pointer when it can be paged (drives a hover ring). */
  private pageHoverId: string | null = null;

  /** Seat under the pointer (drives a soft hover ring on the stool). */
  private seatHover: Seat | null = null;

  /** Notes on the board; null until the server sends a board (an older
   *  server never does), and the board is not drawn. */
  private boardNotes: number | null = null;

  /** The static scene (floor, walls, furniture, light) at the current
   *  viewport; `sceneKey` says what it was painted for. */
  private scene: HTMLCanvasElement | null = null;
  private sceneKey = "";
  /** The light step the last scene was painted at (for the clock poll). */
  private lightStep = -1;
  /** Paper grain, tiled over the static scene. */
  private grain: CanvasPattern | null = null;

  /** Name chips queued during the token pass, flushed on a top layer so a
   *  nearby token can cover a body but never hide who someone is. */
  private chipQueue: Array<{
    name: string;
    x: number;
    top: number;
    isSelf: boolean;
    alpha: number;
  }> = [];

  /**
   * Decoded avatar images, keyed by their data URL (identical avatars share
   * one entry). Data URLs decode async like any src — a fresh entry triggers
   * a wake on load so the initial-letter fallback is repainted as the photo.
   */
  private avatarImages = new Map<string, HTMLImageElement>();

  /** Timestamp of the previous draw, for frame-rate-independent easing. */
  private lastDraw = 0;

  /** Called when the renderer needs the loop to wake (e.g. a resize repaint). */
  private onWake: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, opts: RendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context not available");
    this.ctx = ctx;
    this.hourOfDay = opts.hourOfDay ?? localHour;

    window.addEventListener("resize", () => this._resize());
    // The canvas's layout can settle *after* construction with no window
    // resize (first launch: stylesheet application / WebView attach races),
    // so observe the element itself rather than trusting the one-shot below.
    new ResizeObserver(() => this._resize()).observe(canvas);
    this._watchDpr();
    this._resize();
    this.paintIdle(); // dark screen until a session initializes

    // The light drifts with the clock. One repaint every few minutes is the
    // whole cost of a room that knows what time it is.
    setInterval(() => {
      if (this.space && this._lightStep() !== this.lightStep) this.onWake?.();
    }, LIGHT_POLL_MS);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Register the loop's wake callback so resizes can request a repaint. */
  setWakeCallback(cb: () => void): void {
    this.onWake = cb;
  }

  /** Call once after `welcome`, and again on `space_snapshot` (space switch). */
  init(space: SpaceDescriptor, self: Peer): void {
    // Re-measure before the first scene frame: the backing store may still
    // hold a stale size if construction ran before layout/DPR settled.
    this._resize();
    this.space = space;
    this.self = this._mkPeer(self, /* spawned */ true);
    this.lastDraw = 0;
    this.peers.clear();
    this.plan = buildFloor(space);
    this.seatHover = null;
    this.boardNotes = null;
  }

  /** Return to the un-initialized state and paint the idle screen. */
  reset(): void {
    this.space = null;
    this.self = null;
    this.peers.clear();
    this.plan = null;
    this.walkTarget = null;
    this.seatHover = null;
    this.boardNotes = null;
    this.avatarImages.clear();
    this.scene = null;
    this.sceneKey = "";
    this.paintIdle();
  }

  /**
   * Scale that fits the whole room — walls included — in the viewport, and
   * the screen-space origin of the world's top-left corner at that scale.
   * The floor is always fully visible and centred, so there is no camera to
   * pan; a future zoom (a floor bigger than one screen) is what would bring
   * one back, and both `draw` and `screenToWorld` would then need to share
   * its state through here.
   */
  private _view(space: SpaceDescriptor): { scale: number; ox: number; oy: number } {
    return fitView(this.canvas.width, this.canvas.height, space);
  }

  /**
   * Map a pointer event's client coordinates to world units, for
   * click-to-walk. Returns null before a session initializes.
   */
  screenToWorld(clientX: number, clientY: number): { x: number; y: number } | null {
    const { canvas, space } = this;
    if (!space) return null;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const px = (clientX - rect.left) * dpr;
    const py = (clientY - rect.top) * dpr;
    const { scale, ox, oy } = this._view(space);
    return { x: (px - ox) / scale, y: (py - oy) / scale };
  }

  /**
   * Hit-test remote peers for pointer interaction. Returns the closest peer
   * whose on-screen disc contains the point, or null. Uses the same world
   * radius as `_drawPeer` (plus a small pad so taps are forgiving).
   */
  peerAtScreen(clientX: number, clientY: number): string | null {
    const world = this.screenToWorld(clientX, clientY);
    if (!world) return null;

    const hitR = PEER_RADIUS * 1.08;
    let best: { id: string; d: number } | null = null;

    for (const p of this.peers.values()) {
      if (p.leaving) continue;
      const d = Math.hypot(world.x - p.x, world.y - p.y);
      if (d <= hitR && (!best || d < best.d)) best = { id: p.id, d };
    }

    return best?.id ?? null;
  }

  /**
   * Hit-test seats for click-to-sit. Returns the closest seat whose hit
   * radius contains the point, or null. Peers should be tested first so a
   * click on someone sitting still pages them.
   */
  seatAtScreen(clientX: number, clientY: number): { x: number; y: number } | null {
    const world = this.screenToWorld(clientX, clientY);
    if (!world || !this.plan) return null;

    let best: { seat: Seat; d: number } | null = null;
    for (const s of this.plan.seats) {
      const d = Math.hypot(world.x - s.x, world.y - s.y);
      if (d <= s.hitR && (!best || d < best.d)) best = { seat: s, d };
    }
    return best ? { x: best.seat.x, y: best.seat.y } : null;
  }

  /** How many notes the board holds, or null for "this space has no board". */
  setBoardNotes(count: number | null): void {
    this.boardNotes = count;
    this.onWake?.();
  }

  /** Hit-test the bulletin board. Returns where to stand to read it. */
  boardAtScreen(clientX: number, clientY: number): { x: number; y: number } | null {
    const world = this.screenToWorld(clientX, clientY);
    const b = this.plan?.board;
    if (!world || !b || this.boardNotes === null) return null;
    // The board hangs on the far wall, so its picture reaches above the floor.
    const hit =
      world.x >= b.x && world.x <= b.x + b.w && world.y >= b.y - WALL_FAR_H && world.y <= b.y + b.h;
    return hit ? { x: b.standX, y: b.standY } : null;
  }

  /** Highlight a pageable peer under the pointer, or clear the hover ring. */
  setPageHover(peerId: string | null): void {
    if (this.pageHoverId === peerId) return;
    this.pageHoverId = peerId;
    this.onWake?.();
  }

  /** Highlight a seat under the pointer (soft ring on the stool), or clear. */
  setSeatHover(target: { x: number; y: number } | null): void {
    const next =
      target === null
        ? null
        : this.plan?.seats.find((s) => s.x === target.x && s.y === target.y) ?? null;
    if (this.seatHover === next) return;
    // Same coordinates but different object identity — compare by position.
    if (
      this.seatHover &&
      next &&
      this.seatHover.x === next.x &&
      this.seatHover.y === next.y
    ) {
      return;
    }
    this.seatHover = next;
    this.onWake?.();
  }

  /** Show / move / clear (null) the click-to-walk destination marker. */
  setWalkTarget(target: { x: number; y: number } | null): void {
    this.walkTarget = target;
  }

  /** Update self position from local input integration (every frame). */
  setSelfPosition(x: number, y: number): void {
    if (this.self) {
      this.self.x = x;
      this.self.y = y;
      this.self.targetX = x;
      this.self.targetY = y;
    }
  }

  /** Update self mute state from the mic button. */
  setSelfMuted(muted: boolean): void {
    if (this.self) this.self.muted = muted;
  }

  /** Add or fully refresh a remote peer (from `peer_joined` / `welcome`). */
  upsertPeer(peer: Peer): void {
    const existing = this.peers.get(peer.id);
    if (existing) {
      // Re-announcement: refresh identity, keep eased position + spawn state.
      existing.name = peer.name;
      existing.color = peer.color;
      existing.avatar = peer.avatar;
      existing.muted = peer.muted;
      existing.targetX = peer.x;
      existing.targetY = peer.y;
      existing.leaving = false;
      existing.leave = 1;
      return;
    }
    this.peers.set(peer.id, this._mkPeer(peer, /* spawned */ false));
  }

  /** Update only the interpolation target for a remote peer (from `state`). */
  updatePeerPosition(id: string, x: number, y: number): void {
    const p = this.peers.get(id);
    if (p) {
      p.targetX = x;
      p.targetY = y;
    }
  }

  /** Update mute badge for a remote peer. */
  updatePeerMute(id: string, muted: boolean): void {
    const p = this.peers.get(id);
    if (p) p.muted = muted;
  }

  /** Update org-wide status for self (away / dnd / in_call). */
  setSelfStatus(status: Status): boolean {
    if (!this.self || this.self.status === status) return false;
    this.self.status = status;
    return true;
  }

  /** Update org-wide status for a remote peer in the current space. */
  updatePeerStatus(id: string, status: Status): boolean {
    const p = this.peers.get(id);
    if (!p || p.status === status) return false;
    p.status = status;
    return true;
  }

  /** Begin the leave animation for a peer (from `peer_left`). */
  removePeer(id: string): void {
    const p = this.peers.get(id);
    if (p) {
      p.leaving = true; // draw() fades it out, then drops it
    }
  }

  /** Number of *present* remote peers (excludes those animating out). */
  get peerCount(): number {
    let n = 0;
    for (const p of this.peers.values()) if (!p.leaving) n++;
    return n;
  }

  /** True when a world position is resting on a seat (seated pose). */
  private _isSeated(x: number, y: number): boolean {
    if (!this.plan) return false;
    for (const s of this.plan.seats) {
      if (Math.hypot(x - s.x, y - s.y) <= SEAT_SIT_EPS) return true;
    }
    return false;
  }

  private _lightStep(): number {
    return Math.floor((this.hourOfDay() * 60) / LIGHT_STEP_MIN);
  }

  // -------------------------------------------------------------------------
  // Draw — called by main.ts each active frame
  // -------------------------------------------------------------------------

  /**
   * Render one frame and report whether high-refresh motion or 30fps effects
   * remain. Keeping those classes separate lets call and speech pulses stay
   * smooth without repainting at a 120Hz display's full refresh rate.
   */
  draw(now: number, effectsNow: number, levels: FrameLevels): RenderActivity {
    const { ctx, space, self, plan } = this;
    if (!space || !self || !plan) {
      this.paintIdle();
      return { highRate: false, lowRate: false };
    }

    // Frame-rate-independent dt. Clamp so a wake from sleep doesn't teleport.
    const dt = this.lastDraw === 0 ? 0 : Math.min(0.1, (now - this.lastDraw) / 1000);
    this.lastDraw = now;

    let highRate = false;
    let lowRate = false;

    const { scale, ox, oy } = this._view(space);

    // --- The static room, from the cache ---
    ctx.drawImage(this._scene(space, plan), 0, 0);

    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, space.width * scale, space.height * scale);
    ctx.clip();

    this._drawSeatHover(ox, oy, scale);
    this._drawNearRings(ox, oy, scale, self, space);

    // Click-to-walk destination: a calm pulsing ring until we arrive.
    if (this.walkTarget) {
      this._drawWalkMarker(now, ox + this.walkTarget.x * scale, oy + this.walkTarget.y * scale);
      highRate = true;
    }

    // --- Peers: advance animations, interpolate, draw (and reap leavers) ---
    const lerpK = ease(dt, PEER_LERP_TAU);
    const animK = ease(dt, ANIM_TAU);
    const reap: string[] = [];
    this.chipQueue.length = 0;

    for (const p of this.peers.values()) {
      // Interpolate toward the latest server position.
      p.x += (p.targetX - p.x) * lerpK;
      p.y += (p.targetY - p.y) * lerpK;
      if (Math.hypot(p.targetX - p.x, p.targetY - p.y) > SETTLE_EPS) highRate = true;

      // Spawn / leave fades.
      if (p.leaving) {
        p.leave += (0 - p.leave) * animK;
        if (p.leave < 0.02) { reap.push(p.id); continue; }
        highRate = true;
      } else if (p.spawn < 0.999) {
        p.spawn += (1 - p.spawn) * animK;
        highRate = true;
      }

      const level = levels.levelOf(p.id);
      if (level > 0) lowRate = true;
      if (p.status === "in_call") lowRate = true;
      this._drawPeer(effectsNow, ox, oy, scale, p, false, level, this._isSeated(p.x, p.y));
    }
    for (const id of reap) this.peers.delete(id);

    // Self on top so it's never occluded.
    if (levels.selfLevel > 0) lowRate = true;
    if (self.status === "in_call") lowRate = true;
    this._drawPeer(
      effectsNow,
      ox,
      oy,
      scale,
      self,
      true,
      levels.selfLevel,
      this._isSeated(self.x, self.y),
    );

    // Name chips above every token (self's chip queued last, so it wins).
    for (const c of this.chipQueue) {
      ctx.globalAlpha = c.alpha;
      this._drawNameChip(c.name, c.x, c.top, c.isSelf, scale);
    }
    ctx.globalAlpha = 1;
    this.chipQueue.length = 0;

    ctx.restore();

    return { highRate, lowRate };
  }

  /** Paint the "not in a space" screen. Cheap; called when idle. */
  paintIdle(): void {
    const { ctx, canvas } = this;
    ctx.fillStyle = FRAME_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  /**
   * The static scene at the current viewport, repainted only when something
   * it depends on changed: size, space, board count, or the light step.
   */
  private _scene(space: SpaceDescriptor, plan: FloorPlan): HTMLCanvasElement {
    const step = this._lightStep();
    const key = `${this.canvas.width}x${this.canvas.height}|${space.id}|${this.boardNotes}|${step}`;
    if (this.scene && this.sceneKey === key) return this.scene;

    let scene = this.scene;
    if (!scene) {
      scene = document.createElement("canvas");
      this.scene = scene;
    }
    scene.width = this.canvas.width;
    scene.height = this.canvas.height;
    const sctx = scene.getContext("2d");
    if (!sctx) throw new Error("Canvas 2D context not available");
    if (!this.grain) this.grain = makeGrain(sctx);

    const { scale, ox, oy } = this._view(space);
    const light = lightAt((step * LIGHT_STEP_MIN) / 60);
    paintScene(sctx, scale, ox, oy, space, plan, this.boardNotes, light, this.grain);

    this.sceneKey = key;
    this.lightStep = step;
    return scene;
  }

  // -------------------------------------------------------------------------
  // Resize
  // -------------------------------------------------------------------------

  /**
   * devicePixelRatio can change with no resize event and no layout change
   * (Retina scale settling on first launch, dragging the window to another
   * display). matchMedia is the portable signal — WebKit lacks
   * ResizeObserver's device-pixel-content-box: watch for the *current*
   * ratio ceasing to match, re-fit, and re-arm for the new ratio.
   */
  private _watchDpr(): void {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const onChange = () => {
      mq.removeEventListener("change", onChange);
      this._resize();
      this._watchDpr();
    };
    mq.addEventListener("change", onChange);
  }

  private _resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const nw = Math.round(w * dpr);
    const nh = Math.round(h * dpr);
    if (this.canvas.width !== nw || this.canvas.height !== nh) {
      this.canvas.width = nw;
      this.canvas.height = nh;
      // The backing store was cleared. Repaint: wake the loop if we're in a
      // session (it'll redraw the live scene), else paint the idle screen now.
      if (this.space && this.self) this.onWake?.();
      else this.paintIdle();
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic layer: hover, rings, people
  // -------------------------------------------------------------------------

  private _mkPeer(peer: Peer, spawned: boolean, status: Status = "active"): RenderPeer {
    return {
      ...peer,
      status,
      targetX: peer.x,
      targetY: peer.y,
      x: peer.x,
      y: peer.y,
      spawn: spawned ? 1 : 0,
      leaving: false,
      leave: 1,
    };
  }

  /** Soft accent ring on the seat under the pointer (stools, couch, commons). */
  private _drawSeatHover(ox: number, oy: number, scale: number): void {
    if (!this.seatHover) return;
    const ctx = this.ctx;
    const x = ox + this.seatHover.x * scale;
    const y = oy + this.seatHover.y * scale;
    const r = 15 * scale;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(181,79,44,0.45)";
    ctx.lineWidth = Math.max(1.5, 2 * scale);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(181,79,44,0.2)";
    ctx.fill();
  }

  /** The click-to-walk destination: a soft accent dot with a breathing ring. */
  private _drawWalkMarker(now: number, sx: number, sy: number): void {
    const ctx = this.ctx;
    const phase = (now / 1000) % 1; // one breath per second
    const ringR = 7 + 5 * phase;
    ctx.save();
    ctx.beginPath();
    ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(181,79,44,0.85)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sx, sy, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(181,79,44,${0.55 * (1 - phase)})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The "talking range" around self: a circle on the open floor; inside the
   * meeting room, the room itself — that is exactly who hears you.
   */
  private _drawNearRings(
    ox: number,
    oy: number,
    scale: number,
    self: RenderPeer,
    space: SpaceDescriptor,
  ): void {
    const ctx = this.ctx;
    const sx = ox + self.x * scale;
    const sy = oy + self.y * scale;
    const sr = space.nearRadius * scale;
    const room = space.meetingRoom;

    ctx.save();
    const inset = (WALL_T / 2) * scale;
    const rx = room ? ox + room.x * scale + inset : 0;
    const ry = room ? oy + room.y * scale + inset : 0;
    const rw = room ? room.w * scale - inset * 2 : 0;
    const rh = room ? room.h * scale - inset * 2 : 0;
    ctx.beginPath();
    if (room && rectContains(room, self)) {
      ctx.rect(rx, ry, rw, rh);
    } else {
      if (room) {
        // The wall is soundproof: the circle stops at it.
        ctx.rect(0, 0, this.canvas.width, this.canvas.height);
        ctx.rect(rx, ry, rw, rh);
        ctx.clip("evenodd");
        ctx.beginPath();
      }
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    }
    ctx.fillStyle = NEAR_FILL;
    ctx.fill();
    ctx.strokeStyle = NEAR_STROKE;
    ctx.lineWidth = Math.max(1, 1.25 * scale);
    ctx.setLineDash([3 * scale, 8 * scale]);
    ctx.stroke();
    ctx.restore();
  }

  private _drawPeer(
    now: number,
    ox: number,
    oy: number,
    scale: number,
    peer: RenderPeer,
    isSelf: boolean,
    level: number,
    seated: boolean,
  ): void {
    const ctx = this.ctx;
    // Seated tokens sit a touch lower on the furniture silhouette.
    const sitNudge = seated ? 3 * scale : 0;
    const sx = ox + peer.x * scale;
    const sy = oy + peer.y * scale + sitNudge;

    // Spawn/leave drive a combined appearance factor (alpha + scale).
    const appear = isSelf ? 1 : peer.leaving ? peer.leave : easeOutBack(peer.spawn);
    let alpha = isSelf ? 1 : clamp01(peer.leaving ? peer.leave : peer.spawn);
    // Away and DND both dim: away as a soft idle cue, DND so the member reads
    // as unreachable on the canvas (walking over will not open a link) — the
    // ring/badge alone didn't communicate that.
    if (peer.status === "away" || peer.status === "dnd") alpha *= 0.62;
    // World-unit radius projected through the room scale, so the token keeps
    // its proportion to the floor at any window size. Seated pose shrinks a
    // notch so people rest *on* stools instead of covering them.
    const sitScale = seated ? SEAT_SIT_SCALE : 1;
    const r =
      (isSelf ? SELF_RADIUS : PEER_RADIUS) * scale * (0.6 + 0.4 * appear) * sitScale;

    ctx.save();
    ctx.globalAlpha = alpha;

    // --- Speaking: a warm bloom and rings radiating outward over time ---
    if (level > 0) {
      this._drawRipples(now, sx, sy, r, peer.color, alpha, level);
    }

    // --- Grounding shadow so the token sits on the floor ---
    const sh = ctx.createRadialGradient(sx, sy + r * 0.7, r * 0.15, sx, sy + r * 0.7, r * 1.45);
    sh.addColorStop(0, "rgba(60,40,20,0.34)");
    sh.addColorStop(1, "rgba(60,40,20,0)");
    ctx.fillStyle = sh;
    ctx.beginPath();
    ctx.ellipse(sx, sy + r * 0.74, r * 1.4, r * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();

    // --- Self: a soft pool of light underfoot, so "you" reads at a glance ---
    if (isSelf && peer.status === "active") {
      const halo = ctx.createRadialGradient(sx, sy + r * 0.2, r * 0.6, sx, sy + r * 0.2, r * 1.9);
      halo.addColorStop(0, "rgba(255,246,228,0.6)");
      halo.addColorStop(1, "rgba(255,246,228,0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(sx, sy + r * 0.2, r * 1.9, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- Shoulders beneath the head: a person, not a coin ---
    ctx.beginPath();
    ctx.ellipse(sx, sy + r * 0.62, r * 1.08, r * 0.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = shade(peer.color, 0.78);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(sx, sy + r * 0.56, r * 0.98, r * 0.38, 0, 0, Math.PI * 2);
    ctx.fillStyle = shade(peer.color, 0.92);
    ctx.fill();

    // --- Head, with a soft top highlight so it reads as a rounded token ---
    const body = ctx.createRadialGradient(sx - r * 0.25, sy - r * 0.35, r * 0.1, sx, sy, r);
    body.addColorStop(0, lighten(peer.color, 0.3));
    body.addColorStop(1, peer.color);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = body;
    ctx.fill();

    // --- Face: uploaded photo (circle-clipped), else the initial letter ---
    const photo = peer.avatar ? this._avatarImage(peer.avatar) : null;
    if (photo) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.clip();
      // Avatars are stored well above token size, so this is always a
      // downscale — ask for the good resampler or faces come out crunchy.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(photo, sx - r, sy - r, r * 2, r * 2);
      ctx.restore();
    } else {
      ctx.fillStyle = pickInk(peer.color);
      ctx.font = `600 ${Math.max(13, Math.round(r * 0.72))}px ${FONT_FAMILY}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText((peer.name[0] ?? "?").toUpperCase(), sx, sy + 1);
    }

    // Rim: a paper-white ring, thicker for self.
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(isSelf ? 2.5 : 1.5, r * (isSelf ? 0.1 : 0.07));
    ctx.strokeStyle = isSelf ? "rgba(255,252,246,0.97)" : "rgba(255,252,246,0.8)";
    ctx.stroke();

    // --- Page hover ring (click-to-call affordance) ---
    if (!isSelf && peer.id === this.pageHoverId) {
      ctx.save();
      ctx.globalAlpha = alpha * 0.9;
      ctx.beginPath();
      ctx.arc(sx, sy, r + Math.max(5, r * 0.22), 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(181,79,44,0.85)";
      ctx.lineWidth = Math.max(2.5, r * 0.1);
      ctx.stroke();
      ctx.restore();
    }

    // --- Status ring / pulse (away, dnd, in_call) ---
    if (peer.status !== "active") {
      this._drawStatusRing(now, sx, sy, r, peer.status, alpha);
    }

    // --- Mute badge (muted peers only; self mute is shown in the HUD) ---
    if (peer.muted && !isSelf) {
      this._drawMuteBadge(sx + r * 0.72, sy - r * 0.72, Math.max(7, r * 0.32));
    }

    // --- DND badge (bottom-left so it doesn't collide with mute) ---
    if (peer.status === "dnd") {
      this._drawDndBadge(sx - r * 0.72, sy + r * 0.72, Math.max(7, r * 0.32));
    }

    // --- Name chip below the shoulders (queued; drawn on the top layer) ---
    this.chipQueue.push({ name: peer.name, x: sx, top: sy + r * 1.1 + 5 * scale, isSelf, alpha });

    ctx.restore();
  }

  /**
   * The decoded image for an avatar data URL, or null while it's still
   * decoding (the caller falls back to the initial letter; onload wakes the
   * loop to swap the photo in).
   */
  private _avatarImage(src: string): HTMLImageElement | null {
    let img = this.avatarImages.get(src);
    if (!img) {
      img = new Image();
      img.onload = () => this.onWake?.();
      img.src = src;
      this.avatarImages.set(src, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  /** A warm bloom under a talking peer, and rings radiating outward in time. */
  private _drawRipples(
    now: number,
    sx: number,
    sy: number,
    r: number,
    color: string,
    alpha: number,
    level: number,
  ): void {
    const ctx = this.ctx;
    const lv = clamp01(level);
    // Reach is proportional to the token so ripples keep their feel at any
    // room scale (~1.7r at a whisper, ~3.6r at full level).
    const reach = r * (1.7 + 1.9 * lv);
    const t = (now / 1000) / RIPPLE_PERIOD;
    const [cr, cg, cb] = parseHex(color);

    ctx.save();
    const bloom = ctx.createRadialGradient(sx, sy, r * 0.8, sx, sy, reach);
    bloom.addColorStop(0, `rgba(${cr},${cg},${cb},${0.28 * (0.4 + 0.6 * lv)})`);
    bloom.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(sx, sy, reach, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineWidth = Math.max(1.5, r * 0.06);
    for (let i = 0; i < RIPPLE_COUNT; i++) {
      const phase = (t + i / RIPPLE_COUNT) % 1;
      const rr = r + phase * (reach - r);
      const fade = (1 - phase) * (0.25 + 0.5 * lv);
      ctx.globalAlpha = alpha * fade;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(sx, sy, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Outer ring (and pulse for in_call) that mirrors the sidebar status dots. */
  private _drawStatusRing(
    now: number,
    sx: number,
    sy: number,
    r: number,
    status: Status,
    alpha: number,
  ): void {
    const ctx = this.ctx;
    const ringR = r + Math.max(4, r * 0.18);
    const lw = Math.max(2, r * 0.09);

    ctx.save();
    ctx.globalAlpha = alpha;

    if (status === "in_call") {
      // Solid ring + a radiating pulse so "on a call" reads at a glance.
      ctx.lineWidth = lw;
      ctx.strokeStyle = STATUS_CALL_RING;
      ctx.beginPath();
      ctx.arc(sx, sy, ringR, 0, Math.PI * 2);
      ctx.stroke();

      const t = (now / 1000) / STATUS_CALL_PULSE_PERIOD;
      const phase = t % 1;
      const pulseR = ringR + phase * Math.max(10, r * 0.42);
      ctx.globalAlpha = alpha * (1 - phase) * 0.5;
      ctx.beginPath();
      ctx.arc(sx, sy, pulseR, 0, Math.PI * 2);
      ctx.stroke();
    } else if (status === "dnd") {
      ctx.lineWidth = lw + 0.5;
      ctx.strokeStyle = STATUS_DND_RING;
      ctx.beginPath();
      ctx.arc(sx, sy, ringR, 0, Math.PI * 2);
      ctx.stroke();
    } else if (status === "away") {
      ctx.lineWidth = lw;
      ctx.strokeStyle = STATUS_AWAY_RING;
      ctx.setLineDash([Math.max(3, r * 0.14), Math.max(3, r * 0.14)]);
      ctx.beginPath();
      ctx.arc(sx, sy, ringR, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  /** Small badge with a horizontal bar — the "do not disturb" mark. */
  private _drawDndBadge(cx: number, cy: number, r: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,251,243,0.96)";
    ctx.fill();
    ctx.strokeStyle = "rgba(184, 72, 48, 0.55)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = "rgba(184, 72, 48, 0.95)";
    ctx.lineWidth = Math.max(1.8, r * 0.24);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.48, cy);
    ctx.lineTo(cx + r * 0.48, cy);
    ctx.stroke();
    ctx.restore();
  }

  /** A small light circle with a mic-off slash — crisp and cross-platform. */
  private _drawMuteBadge(cx: number, cy: number, r: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,251,243,0.96)";
    ctx.fill();
    ctx.strokeStyle = "rgba(90,70,45,0.3)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = "rgba(181,79,44,0.95)";
    ctx.lineWidth = Math.max(1.6, r * 0.22);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.5, cy - r * 0.5);
    ctx.lineTo(cx + r * 0.5, cy + r * 0.5);
    ctx.stroke();
    ctx.restore();
  }

  /** A subtle rounded chip behind the name so labels stay legible. */
  private _drawNameChip(
    name: string,
    cx: number,
    top: number,
    isSelf: boolean,
    scale: number,
  ): void {
    const ctx = this.ctx;
    // Scale-proportional like avatar initials — canvas is physical px, no ctx.scale().
    const fontPx = Math.max(10, Math.round(FONT_LABEL_PX * scale));
    ctx.font = `${isSelf ? 600 : 500} ${fontPx}px ${FONT_FAMILY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const w = ctx.measureText(name).width;
    const padX = 8 * scale;
    const padY = 3.5 * scale;
    const chipW = w + padX * 2;
    const chipH = 19 * scale;
    const x = cx - chipW / 2;

    roundRect(ctx, x, top, chipW, chipH, 7 * scale);
    ctx.fillStyle = isSelf ? "rgba(255,252,246,0.97)" : "rgba(255,252,246,0.9)";
    ctx.fill();
    ctx.lineWidth = Math.max(1, scale);
    ctx.strokeStyle = isSelf ? "rgba(181,79,44,0.6)" : "rgba(90,70,45,0.16)";
    ctx.stroke();

    ctx.fillStyle = "#3f3122";
    ctx.fillText(name, cx, top + padY);
  }
}

/** Current local time as a fractional hour. */
function localHour(): number {
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
}

/** Fit the world plus its walls into a viewport (see `Renderer._view`). */
function fitView(
  vw: number,
  vh: number,
  space: SpaceDescriptor,
): { scale: number; ox: number; oy: number } {
  const fullW = space.width + VIEW_PAD_X * 2;
  const fullH = space.height + VIEW_PAD_TOP + VIEW_PAD_BOTTOM;
  const scale = Math.min(vw / fullW, vh / fullH);
  return {
    scale,
    ox: (vw - fullW * scale) / 2 + VIEW_PAD_X * scale,
    oy: (vh - fullH * scale) / 2 + VIEW_PAD_TOP * scale,
  };
}

// ---------------------------------------------------------------------------
// Floor-plan builder
// ---------------------------------------------------------------------------

/**
 * Lay out furniture in world units, as fractions of the space so it fits any
 * server geometry. Layout depends on `space.kind`:
 *  - lobby → multi-zone open floor (Focus / Meeting / Lounge / Café / Commons)
 *  - team  → the room's `layout` (see `TEAM_FLOORS`)
 */
function buildFloor(space: SpaceDescriptor): FloorPlan {
  if (space.kind === "lobby") return buildLobbyFloor(space);
  // A server from before layouts sends none: its team rooms are all meeting rooms.
  return TEAM_FLOORS[space.layout ?? "meeting"](space);
}

/** Default stool radius as a fraction of room width. */
const STOOL_R = 0.022;
/** Minimum click hit radius in world units (forgiving on small windows). */
function seatHitR(stoolR: number): number {
  return Math.max(stoolR * 2.4, 28);
}

function pushBoard(items: FloorItem[], space: SpaceDescriptor): BoardGeometry {
  const board = boardGeometry(space);
  items.push({ kind: "board", x: board.x, y: board.y, w: board.w, h: board.h });
  return board;
}

function pushStool(
  items: FloorItem[],
  seats: Seat[],
  x: number,
  y: number,
  r: number,
  back?: number,
): void {
  items.push({ kind: "stool", x, y, r, back });
  seats.push({ x, y, hitR: seatHitR(r) });
}

/**
 * The meeting room's furniture inside the server's rectangle: a round table
 * with six chairs under a pendant, sized so the ring clears the walls' inner
 * shadow.
 */
function pushMeetingRoom(items: FloorItem[], seats: Seat[], room: Rect, stoolR: number): void {
  items.push({
    kind: "room",
    x: room.x,
    y: room.y,
    w: room.w,
    h: room.h,
    label: "Meeting",
  });
  const cx = room.x + room.w / 2;
  const cy = room.y + room.h / 2;
  const tr = Math.min(room.w, room.h) * 0.22;
  items.push({
    kind: "table",
    x: cx - tr,
    y: cy - tr,
    w: tr * 2,
    h: tr * 2,
    round: true,
    tone: "walnut",
  });
  items.push({ kind: "pendant", x: cx, y: cy, r: tr * 1.9 });
  const ring = tr + stoolR * 1.5;
  // Ring starts at 3 o'clock so no chair sits under the signage at the top.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    pushStool(items, seats, cx + Math.cos(a) * ring, cy + Math.sin(a) * ring, stoolR, a);
  }
}

/** A focus desk: oak top, a monitor and a lamp, a chair below. */
function pushDesk(
  items: FloorItem[],
  seats: Seat[],
  x: number,
  y: number,
  w: number,
  h: number,
  stoolR: number,
  lamp: boolean,
): void {
  items.push({ kind: "table", x, y, w, h, round: false, tone: "oak" });
  items.push({ kind: "monitor", x: x + w * 0.5, y: y + h * 0.32, w: w * 0.5 });
  if (lamp) items.push({ kind: "deskLamp", x: x + w * 0.86, y: y + h * 0.4 });
  else items.push({ kind: "mug", x: x + w * 0.86, y: y + h * 0.6, r: w * 0.06 });
  pushStool(items, seats, x + w / 2, y + h + stoolR * 1.9, stoolR, Math.PI / 2);
}

/** Open ambient lobby: five zones so presence has place-context. */
function buildLobbyFloor(space: SpaceDescriptor): FloorPlan {
  const W = space.width;
  const H = space.height;
  const items: FloorItem[] = [];
  const seats: Seat[] = [];
  const sr = STOOL_R * W;

  // --- Focus desks (top-left): a row of desks with chairs ---
  items.push({
    kind: "rug",
    x: 0.05 * W,
    y: 0.06 * H,
    w: 0.36 * W,
    h: 0.32 * H,
    color: RUG_FOCUS,
    label: "Focus",
  });
  for (let i = 0; i < 3; i++) {
    pushDesk(items, seats, (0.1 + i * 0.1) * W, 0.14 * H, 0.085 * W, 0.07 * H, sr, i !== 1);
  }
  items.push({ kind: "plant", x: 0.07 * W, y: 0.33 * H, r: 0.035 * W, variant: "palm" });

  // --- A bookshelf against the left wall, between Focus and Lounge ---
  pushShelf(items, 0, 0.43 * H, 0.03 * W, 0.13 * H);

  // --- Meeting (top-right): the walled room, a round table ringed by chairs ---
  if (space.meetingRoom) pushMeetingRoom(items, seats, space.meetingRoom, sr);

  // --- Lounge (bottom-left): couch + coffee table + plant ---
  items.push({
    kind: "rug",
    x: 0.05 * W,
    y: 0.6 * H,
    w: 0.37 * W,
    h: 0.33 * H,
    color: RUG_LOUNGE,
    label: "Lounge",
  });
  items.push({ kind: "couch", x: 0.08 * W, y: 0.66 * H, w: 0.1 * W, h: 0.2 * H, back: "left" });
  // Couch seats (no stool mesh — sit targets along the cushions).
  for (const [sx, sy] of [
    [0.13, 0.72],
    [0.13, 0.8],
    [0.13, 0.88],
  ] as const) {
    seats.push({ x: sx * W, y: sy * H, hitR: seatHitR(sr * 1.1) });
  }
  items.push({
    kind: "table",
    x: 0.22 * W,
    y: 0.72 * H,
    w: 0.11 * W,
    h: 0.1 * H,
    round: true,
    tone: "walnut",
  });
  items.push({ kind: "mug", x: 0.255 * W, y: 0.765 * H, r: 0.0065 * W });
  items.push({ kind: "book", x: 0.285 * W, y: 0.75 * H, w: 0.03 * W, h: 0.035 * H, color: "#7a5f8a" });
  items.push({ kind: "floorLamp", x: 0.375 * W, y: 0.9 * H });
  items.push({ kind: "plant", x: 0.37 * W, y: 0.66 * H, r: 0.035 * W, variant: "bush" });

  // --- Café (bottom-right): counter + stools + plant ---
  items.push({
    kind: "rug",
    x: 0.58 * W,
    y: 0.6 * H,
    w: 0.37 * W,
    h: 0.33 * H,
    color: RUG_CAFE,
    label: "Café",
  });
  items.push({
    kind: "table",
    x: 0.62 * W,
    y: 0.66 * H,
    w: 0.29 * W,
    h: 0.065 * H,
    round: false,
    tone: "walnut",
  });
  items.push({ kind: "machine", x: 0.635 * W, y: 0.668 * H, w: 0.035 * W, h: 0.045 * H });
  for (const mx of [0.72, 0.79, 0.86]) {
    items.push({ kind: "mug", x: mx * W, y: 0.69 * H, r: 0.0065 * W });
  }
  for (const px of [0.705, 0.845]) items.push({ kind: "pendant", x: px * W, y: 0.69 * H, r: 0.085 * W });
  for (let i = 0; i < 4; i++) {
    pushStool(items, seats, (0.66 + i * 0.07) * W, 0.76 * H, sr);
  }
  items.push({ kind: "plant", x: 0.9 * W, y: 0.86 * H, r: 0.035 * W, variant: "palm" });

  // --- Commons (centre): open gathering circle with a low table ---
  const cr = 0.12 * Math.min(W, H);
  items.push({
    kind: "rugRound",
    x: 0.5 * W,
    y: 0.5 * H,
    r: cr,
    color: RUG_COMMONS,
    label: "Commons",
  });
  items.push({
    kind: "table",
    x: 0.47 * W,
    y: 0.47 * H,
    w: 0.06 * W,
    h: 0.06 * H,
    round: true,
    tone: "walnut",
  });
  items.push({ kind: "plant", x: 0.5 * W, y: 0.5 * H, r: 0.014 * W, variant: "bush" });
  // Soft sit ring around the commons table (no extra stools — keeps the
  // centre open while still offering idle rest spots).
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    seats.push({
      x: 0.5 * W + Math.cos(a) * cr * 0.72,
      y: 0.5 * H + Math.sin(a) * cr * 0.72,
      hitR: seatHitR(sr),
    });
  }

  // Windows over Focus and over the meeting room; the board hangs between.
  // The first starts clear of the space tabs that sit over the top-left.
  const windows: Window[] = [
    { x: 0.19 * W, w: 0.22 * W },
    { x: 0.63 * W, w: 0.29 * W },
  ];

  return { items, seats, board: pushBoard(items, space), windows };
}

/** A low shelf with a few books, against the left wall. */
function pushShelf(items: FloorItem[], x: number, y: number, w: number, h: number): void {
  items.push({ kind: "shelf", x, y, w, h });
  const colors = ["#8a5a4a", "#5d6f8a", "#b89a4a", "#6f8a5a", "#8a6a8a", "#c47a55"];
  const n = 6;
  const bh = (h * 0.8) / n;
  for (let i = 0; i < n; i++) {
    const bw = w * (0.5 + 0.35 * ((i * 7) % 3) / 2);
    items.push({ kind: "book", x: x + w * 0.1, y: y + h * 0.1 + i * bh, w: bw, h: bh * 0.78, color: colors[i] });
  }
}

/**
 * Team rooms. Radii on the server already make the whole room one group call,
 * so a layout only sets the furniture and where people sit. Every plan keeps
 * the board's top-left stand point clear.
 */
const TEAM_FLOORS: Record<TeamLayout, (space: SpaceDescriptor) => FloorPlan> = {
  meeting: buildMeetingFloor,
  desks: buildDesksFloor,
  lounge: buildLoungeFloor,
  cafe: buildCafeFloor,
};

/** Team stools read a touch larger than the lobby's. */
const TEAM_STOOL_R = STOOL_R * 1.05;

/** Team rooms: a wide window right of the board, a narrower one at the end. */
function teamWindows(space: SpaceDescriptor): Window[] {
  return [
    { x: 0.34 * space.width, w: 0.3 * space.width },
    { x: 0.72 * space.width, w: 0.2 * space.width },
  ];
}

function pushPlants(
  items: FloorItem[],
  space: SpaceDescriptor,
  at: Array<[number, number, "bush" | "palm"]>,
): void {
  for (const [x, y, variant] of at) {
    items.push({
      kind: "plant",
      x: x * space.width,
      y: y * space.height,
      r: 0.038 * space.width,
      variant,
    });
  }
}

/** One round table + capacity seats: talking in a circle. */
function buildMeetingFloor(space: SpaceDescriptor): FloorPlan {
  const W = space.width;
  const H = space.height;
  const items: FloorItem[] = [];
  const seats: Seat[] = [];
  const n = Math.max(2, Math.min(space.capacity || 5, 8));
  const minSide = Math.min(W, H);
  const sr = TEAM_STOOL_R * W;

  // Soft rug under the meeting area (no zone label — the tab names the room).
  items.push({
    kind: "rugRound",
    x: 0.5 * W,
    y: 0.5 * H,
    r: 0.3 * minSide,
    color: RUG_MEET,
  });

  // Central table under a pendant.
  const tr = 0.1 * minSide;
  items.push({
    kind: "table",
    x: 0.5 * W - tr,
    y: 0.5 * H - tr,
    w: tr * 2,
    h: tr * 2,
    round: true,
    tone: "walnut",
  });
  items.push({ kind: "pendant", x: 0.5 * W, y: 0.5 * H, r: tr * 2.2 });

  // Chairs ring the table (one per capacity slot), backs outward.
  const ring = tr * 1.75;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    pushStool(items, seats, 0.5 * W + Math.cos(a) * ring, 0.5 * H + Math.sin(a) * ring, sr, a);
  }

  // Corner plants — sparse, so the table stays the focus.
  pushPlants(items, space, [[0.08, 0.1, "palm"], [0.92, 0.9, "bush"]]);

  return { items, seats, board: pushBoard(items, space), windows: teamWindows(space) };
}

/** A desk island, three facing two: heads-down work within earshot. */
function buildDesksFloor(space: SpaceDescriptor): FloorPlan {
  const W = space.width;
  const H = space.height;
  const items: FloorItem[] = [];
  const seats: Seat[] = [];
  const sr = TEAM_STOOL_R * W;
  const dw = 0.13 * W;
  const dh = 0.1 * H;

  items.push({ kind: "rug", x: 0.2 * W, y: 0.27 * H, w: 0.6 * W, h: 0.58 * H, color: RUG_FOCUS });
  for (const [i, cx] of [0.36, 0.5, 0.64].entries()) {
    const x = cx * W - dw / 2;
    items.push({ kind: "table", x, y: 0.44 * H, w: dw, h: dh, round: false, tone: "oak" });
    items.push({ kind: "monitor", x: cx * W, y: 0.44 * H + dh * 0.68, w: dw * 0.42 });
    if (i !== 1) items.push({ kind: "deskLamp", x: x + dw * 0.86, y: 0.44 * H + dh * 0.5 });
    pushStool(items, seats, cx * W, 0.37 * H, sr, -Math.PI / 2);
  }
  for (const cx of [0.43, 0.57]) {
    const x = cx * W - dw / 2;
    items.push({ kind: "table", x, y: 0.54 * H, w: dw, h: dh, round: false, tone: "oak" });
    items.push({ kind: "monitor", x: cx * W, y: 0.54 * H + dh * 0.32, w: dw * 0.42 });
    items.push({ kind: "mug", x: x + dw * 0.85, y: 0.54 * H + dh * 0.6, r: 0.0065 * W });
    pushStool(items, seats, cx * W, 0.72 * H, sr, Math.PI / 2);
  }
  pushPlants(items, space, [[0.92, 0.1, "palm"], [0.08, 0.9, "bush"], [0.92, 0.9, "bush"]]);

  return { items, seats, board: pushBoard(items, space), windows: teamWindows(space) };
}

/** A sofa, a low table and two armchairs: chatting and breaks. */
function buildLoungeFloor(space: SpaceDescriptor): FloorPlan {
  const W = space.width;
  const H = space.height;
  const items: FloorItem[] = [];
  const seats: Seat[] = [];
  const hitR = seatHitR(TEAM_STOOL_R * W * 1.1);

  items.push({ kind: "rug", x: 0.16 * W, y: 0.3 * H, w: 0.68 * W, h: 0.6 * H, color: RUG_LOUNGE });
  // Sofa: sit targets along the cushions, as on the lobby couch.
  items.push({ kind: "couch", x: 0.31 * W, y: 0.71 * H, w: 0.38 * W, h: 0.13 * H, back: "bottom" });
  for (const sx of [0.39, 0.5, 0.61]) seats.push({ x: sx * W, y: 0.775 * H, hitR });
  items.push({
    kind: "table",
    x: 0.39 * W,
    y: 0.49 * H,
    w: 0.22 * W,
    h: 0.11 * H,
    round: true,
    tone: "walnut",
  });
  items.push({ kind: "mug", x: 0.46 * W, y: 0.545 * H, r: 0.0065 * W });
  items.push({ kind: "book", x: 0.51 * W, y: 0.52 * H, w: 0.035 * W, h: 0.04 * H, color: "#5d6f8a" });
  // Armchairs either side of the table, backs outward.
  items.push({ kind: "couch", x: 0.2 * W, y: 0.45 * H, w: 0.09 * W, h: 0.13 * H, back: "left" });
  seats.push({ x: 0.245 * W, y: 0.515 * H, hitR });
  items.push({ kind: "couch", x: 0.71 * W, y: 0.45 * H, w: 0.09 * W, h: 0.13 * H, back: "right" });
  seats.push({ x: 0.755 * W, y: 0.515 * H, hitR });
  items.push({ kind: "floorLamp", x: 0.2 * W, y: 0.82 * H });
  pushPlants(items, space, [[0.92, 0.12, "palm"], [0.08, 0.9, "bush"], [0.9, 0.9, "bush"]]);

  return { items, seats, board: pushBoard(items, space), windows: teamWindows(space) };
}

/** A long counter with a row of stools: dropping by for a quick word. */
function buildCafeFloor(space: SpaceDescriptor): FloorPlan {
  const W = space.width;
  const H = space.height;
  const items: FloorItem[] = [];
  const seats: Seat[] = [];
  const sr = TEAM_STOOL_R * W;

  items.push({ kind: "rug", x: 0.15 * W, y: 0.3 * H, w: 0.7 * W, h: 0.5 * H, color: RUG_CAFE });
  items.push({
    kind: "table",
    x: 0.22 * W,
    y: 0.42 * H,
    w: 0.56 * W,
    h: 0.08 * H,
    round: false,
    tone: "walnut",
  });
  items.push({ kind: "machine", x: 0.235 * W, y: 0.428 * H, w: 0.04 * W, h: 0.06 * H });
  for (const mx of [0.4, 0.5, 0.6, 0.7]) {
    items.push({ kind: "mug", x: mx * W, y: 0.455 * H, r: 0.0065 * W });
  }
  for (const px of [0.36, 0.5, 0.64]) items.push({ kind: "pendant", x: px * W, y: 0.46 * H, r: 0.09 * W });
  for (let i = 0; i < 5; i++) pushStool(items, seats, (0.3 + i * 0.1) * W, 0.6 * H, sr);
  pushPlants(items, space, [[0.92, 0.12, "palm"], [0.08, 0.9, "bush"], [0.92, 0.9, "palm"]]);

  return { items, seats, board: pushBoard(items, space), windows: teamWindows(space) };
}

// ---------------------------------------------------------------------------
// The static scene (shared by the live cache and the picker thumbnails)
// ---------------------------------------------------------------------------

/** Paint an empty team room in `layout` to fit `canvas` (the layout picker's
 *  thumbnails). Only proportions matter here: team rooms are 800×600. */
export function paintLayoutPreview(canvas: HTMLCanvasElement, layout: TeamLayout): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context not available");
  const space: SpaceDescriptor = {
    id: "preview",
    name: "",
    kind: "team",
    layout,
    width: 800,
    height: 600,
    nearRadius: 1100,
    farRadius: 1100,
    tickHz: 12,
    capacity: 5,
  };
  const { scale, ox, oy } = fitView(canvas.width, canvas.height, space);
  // Always daylight: a thumbnail is a floor plan, not a mood. No board: its
  // signage would swamp it.
  paintScene(ctx, scale, ox, oy, space, TEAM_FLOORS[layout](space), null, lightAt(11), null);
}

/**
 * Paint the whole static room: frame, walls, floor, rugs, furniture, the
 * light of the hour, and the grain. Draws in world units under one
 * transform; hairlines are expressed as `1 / scale`.
 */
function paintScene(
  ctx: CanvasRenderingContext2D,
  scale: number,
  ox: number,
  oy: number,
  space: SpaceDescriptor,
  plan: FloorPlan,
  boardNotes: number | null,
  light: Light,
  grain: CanvasPattern | null,
): void {
  const W = space.width;
  const H = space.height;
  const hair = 1 / scale;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = FRAME_BG;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(scale, 0, 0, scale, ox, oy);

  // The room's shadow on the frame, so it sits in the dark rather than on it.
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  roundRect(ctx, -WALL_CAP - 2, -WALL_FAR_H - 2, W + WALL_CAP * 2 + 4, H + WALL_FAR_H + WALL_CAP + 10, 6);
  ctx.fill();

  drawFloor(ctx, W, H, hair);

  // Zone rugs sit on the floor, under everything else.
  for (const it of plan.items) {
    if (it.kind === "rug") drawRug(ctx, it.x, it.y, it.w, it.h, it.color, it.label, hair);
    else if (it.kind === "rugRound") drawRoundRug(ctx, it.x, it.y, it.r, it.color, it.label, hair);
  }

  drawFurniture(ctx, plan.items, light, hair);

  // The hour's ambient tint, multiplied over floor and furniture alike.
  if (light.ambientA > 0) {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = mixHex("#ffffff", light.ambient, light.ambientA);
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // Light falls over the tint, not under it: daylight through the windows
  // across floor and furniture alike, and the lamps once the daylight goes.
  drawSunlight(ctx, W, H, plan.windows, light);
  if (light.lamp > 0) drawLampLight(ctx, plan.items, light.lamp);

  // Walls last: they stand above the floor and frame it.
  drawWalls(ctx, W, H, plan, boardNotes, light, hair);
  drawVignette(ctx, W, H);

  if (grain) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = grain;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  }

  ctx.restore();
}

/**
 * Herringbone oak. In a frame rotated 45°, the pattern is staircases of
 * axis-aligned planks: staircase k steps by (L+w, L−w) and neighbouring
 * staircases are offset by (w, −w). Each plank gets its own tone from a
 * hash, so the floor reads as wood rather than wallpaper.
 */
function drawFloor(ctx: CanvasRenderingContext2D, W: number, H: number, hair: number): void {
  ctx.fillStyle = FLOOR_BASE;
  ctx.fillRect(0, 0, W, H);

  const w = 15; // plank width, world units
  const L = 60; // plank length
  const R = Math.hypot(W, H) / 2 + L;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-Math.PI / 4);
  ctx.lineWidth = hair;
  ctx.strokeStyle = FLOOR_SEAM;

  const kMax = Math.ceil((R + L) / w);
  const mMax = Math.ceil(R / (L - w)) + 1;
  for (let k = -kMax; k <= kMax; k++) {
    for (let m = -mMax; m <= mMax; m++) {
      const bx = k * w + m * (L + w);
      const by = -k * w + m * (L - w);
      plank(ctx, bx, by, L, w, R, k * 31 + m * 17);
      plank(ctx, bx + L, by, w, L, R, k * 31 + m * 17 + 7);
    }
  }
  ctx.restore();
}

function plank(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  R: number,
  seed: number,
): void {
  // Cull planks that cannot touch the room's bounding circle.
  if (Math.hypot(x + w / 2, y + h / 2) > R + Math.max(w, h)) return;
  const t = hash01(seed);
  ctx.fillStyle = t < 0.33 ? FLOOR_LIGHT : t < 0.66 ? FLOOR_BASE : FLOOR_DARK;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  // A grain line or two along the plank's length.
  const along = w > h;
  ctx.globalAlpha = 0.18;
  ctx.beginPath();
  if (along) {
    const gy = y + h * (0.3 + 0.4 * hash01(seed + 3));
    ctx.moveTo(x + 4, gy);
    ctx.lineTo(x + w - 4, gy);
  } else {
    const gx = x + w * (0.3 + 0.4 * hash01(seed + 3));
    ctx.moveTo(gx, y + 4);
    ctx.lineTo(gx, y + h - 4);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** A woven rug: body, a darker border band, and fringe on two ends. */
function drawRug(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  label: string | undefined,
  hair: number,
): void {
  ctx.save();
  // A rug lies flat: a tight contact shadow, no lift.
  ctx.fillStyle = "rgba(60,40,20,0.14)";
  roundRect(ctx, x + 1, y + 2, w, h, 4);
  ctx.fill();

  roundRect(ctx, x, y, w, h, 4);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.clip();
  weave(ctx, x, y, w, h, hair);
  ctx.restore();

  // Border band, inset.
  ctx.save();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = shade(color, 0.86);
  roundRect(ctx, x + 7, y + 7, w - 14, h - 14, 2);
  ctx.stroke();
  ctx.lineWidth = hair;
  ctx.strokeStyle = "rgba(60,40,20,0.22)";
  roundRect(ctx, x, y, w, h, 4);
  ctx.stroke();
  // Fringe along the left and right ends.
  ctx.strokeStyle = shade(color, 0.8);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let fy = y + 5; fy < y + h - 3; fy += 5) {
    ctx.moveTo(x, fy);
    ctx.lineTo(x - 4, fy + 1);
    ctx.moveTo(x + w, fy);
    ctx.lineTo(x + w + 4, fy + 1);
  }
  ctx.stroke();
  ctx.restore();

  if (label) zoneLabel(ctx, label, x + w / 2, y + 16);
}

/** A round jute rug: body, concentric weave, a border ring. */
function drawRoundRug(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
  label: string | undefined,
  hair: number,
): void {
  ctx.save();
  ctx.fillStyle = "rgba(60,40,20,0.14)";
  ctx.beginPath();
  ctx.arc(cx + 1, cy + 2, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = hair;
  ctx.strokeStyle = "rgba(60,40,20,0.2)";
  for (let rr = 6; rr < r; rr += 6) {
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = shade(color, 0.86);
  ctx.beginPath();
  ctx.arc(cx, cy, r - 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  if (label) zoneLabel(ctx, label, cx, cy - r + 16);
}

/** Fine cross-hatch so a rug reads as cloth, not paint. */
function weave(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, hair: number): void {
  ctx.lineWidth = hair;
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.beginPath();
  for (let i = 0; i < w + h; i += 5) {
    ctx.moveTo(x + i, y);
    ctx.lineTo(x + i - h, y + h);
  }
  ctx.stroke();
  ctx.strokeStyle = "rgba(60,40,20,0.09)";
  ctx.beginPath();
  for (let i = -h; i < w; i += 5) {
    ctx.moveTo(x + i, y);
    ctx.lineTo(x + i + h, y + h);
  }
  ctx.stroke();
}

/**
 * Daylight through the windows: a leaning trapezoid of light under each,
 * fading with distance, with the mullions' shadows striping it. Painted as
 * a few nested layers so the edges are soft without a blur filter.
 */
function drawSunlight(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  windows: Window[],
  light: Light,
): void {
  if (light.sun <= 0.02) return;
  const reach = light.reach * H;
  const lean = light.skew * reach;
  const [r, g, b] = parseHex(light.sunColor);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
  // Screened, so the shafts add light rather than paint over the room.
  ctx.globalCompositeOperation = "screen";

  // A low sun reads stronger against a dim room, so its shafts get a lift.
  const strength = 0.42 * Math.sqrt(light.sun) * (1 + 0.6 * (1 - light.sun));
  for (const win of windows) {
    const spread = win.w * 0.12;
    for (const [grow, a] of [
      [spread, 0.3],
      [spread * 0.5, 0.3],
      [0, 0.4],
    ] as const) {
      const pool = ctx.createLinearGradient(0, 0, lean * 0.3, reach);
      pool.addColorStop(0, `rgba(${r},${g},${b},${a * strength})`);
      pool.addColorStop(0.55, `rgba(${r},${g},${b},${a * strength * 0.55})`);
      pool.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = pool;
      ctx.beginPath();
      ctx.moveTo(win.x - grow, 0);
      ctx.lineTo(win.x + win.w + grow, 0);
      ctx.lineTo(win.x + win.w + grow * 1.6 + lean, reach);
      ctx.lineTo(win.x - grow * 1.6 + lean, reach);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();

  // Mullion shadows: the frame bars, cast down the pool.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
  for (const win of windows) {
    const bars = mullions(win);
    for (const bx of bars) {
      const barShadow = ctx.createLinearGradient(0, 0, 0, reach * 0.8);
      barShadow.addColorStop(0, `rgba(60,40,20,${0.16 * light.sun})`);
      barShadow.addColorStop(1, "rgba(60,40,20,0)");
      ctx.fillStyle = barShadow;
      ctx.beginPath();
      ctx.moveTo(bx - 1.5, 0);
      ctx.lineTo(bx + 1.5, 0);
      ctx.lineTo(bx + 2.5 + lean * 0.8, reach * 0.8);
      ctx.lineTo(bx - 2.5 + lean * 0.8, reach * 0.8);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

/** Where a window's vertical frame bars stand (world x). */
function mullions(win: Window): number[] {
  const n = Math.max(2, Math.round(win.w / 60));
  const out: number[] = [];
  for (let i = 1; i < n; i++) out.push(win.x + (win.w * i) / n);
  return out;
}

/** The lamps' light, screened over the tinted room. */
function drawLampLight(ctx: CanvasRenderingContext2D, items: FloorItem[], lamp: number): void {
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (const it of items) {
    let x: number, y: number, r: number, a: number;
    if (it.kind === "pendant") { x = it.x; y = it.y; r = it.r; a = 0.85; }
    else if (it.kind === "deskLamp") { x = it.x - 6; y = it.y + 8; r = 46; a = 0.6; }
    else if (it.kind === "floorLamp") { x = it.x; y = it.y; r = 70; a = 0.55; }
    else if (it.kind === "monitor") { x = it.x; y = it.y + 10; r = 26; a = 0.22; }
    else continue;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const isScreen = it.kind === "monitor";
    const rgb = isScreen ? "190,215,255" : GLOW;
    g.addColorStop(0, `rgba(${rgb},${a * lamp})`);
    g.addColorStop(0.5, `rgba(${rgb},${a * lamp * 0.35})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * The perimeter: the far wall in elevation (plaster, windows with the hour's
 * sky, a sill, the baseboard), the other three as wooden caps seen from
 * above, and the board hanging on the far wall.
 */
function drawWalls(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  plan: FloorPlan,
  boardNotes: number | null,
  light: Light,
  hair: number,
): void {
  // Far wall face.
  const face = ctx.createLinearGradient(0, -WALL_FAR_H, 0, 0);
  face.addColorStop(0, PLASTER);
  face.addColorStop(1, PLASTER_SHADE);
  ctx.fillStyle = face;
  ctx.fillRect(-WALL_CAP, -WALL_FAR_H, W + WALL_CAP * 2, WALL_FAR_H);
  // The board hangs on the far wall above its stand point. `boardNotes`
  // null leaves it out, as for a server that sends none.
  if (boardNotes !== null) drawBoard(ctx, plan.board, boardNotes, hair);

  // Night dims the plaster — and the board on it — too.
  if (light.ambientA > 0) {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = mixHex("#ffffff", light.ambient, light.ambientA * 0.85);
    ctx.fillRect(-WALL_CAP, -WALL_FAR_H, W + WALL_CAP * 2, WALL_FAR_H);
    ctx.restore();
  }

  // Windows.
  for (const win of plan.windows) drawWindow(ctx, win, light, hair);

  // Baseboard where the wall meets the floor.
  ctx.fillStyle = BASEBOARD;
  ctx.fillRect(-WALL_CAP, -4, W + WALL_CAP * 2, 4);
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(-WALL_CAP, -4, W + WALL_CAP * 2, 1);
  // And the floor's own shadow line under it.
  const foot = ctx.createLinearGradient(0, 0, 0, 14);
  foot.addColorStop(0, "rgba(40,25,10,0.28)");
  foot.addColorStop(1, "rgba(40,25,10,0)");
  ctx.fillStyle = foot;
  ctx.fillRect(0, 0, W, 14);

  // Side and near wall caps.
  ctx.fillStyle = WALL_CAP_COLOR;
  ctx.fillRect(-WALL_CAP, -WALL_FAR_H, WALL_CAP, H + WALL_FAR_H + WALL_CAP);
  ctx.fillRect(W, -WALL_FAR_H, WALL_CAP, H + WALL_FAR_H + WALL_CAP);
  ctx.fillRect(-WALL_CAP, H, W + WALL_CAP * 2, WALL_CAP);
  // Lit inner edge on the caps.
  ctx.fillStyle = WALL_CAP_HI;
  ctx.fillRect(-WALL_CAP, -WALL_FAR_H, 2.5, H + WALL_FAR_H + WALL_CAP);
  ctx.fillRect(W + WALL_CAP - 2.5, -WALL_FAR_H, 2.5, H + WALL_FAR_H + WALL_CAP);
  ctx.fillRect(-WALL_CAP, H + WALL_CAP - 2.5, W + WALL_CAP * 2, 2.5);
  // Shadow the walls throw onto the floor along their feet.
  const sideShade = ctx.createLinearGradient(0, 0, 10, 0);
  sideShade.addColorStop(0, "rgba(40,25,10,0.2)");
  sideShade.addColorStop(1, "rgba(40,25,10,0)");
  ctx.fillStyle = sideShade;
  ctx.fillRect(0, 0, 10, H);
  const rightShade = ctx.createLinearGradient(W, 0, W - 10, 0);
  rightShade.addColorStop(0, "rgba(40,25,10,0.2)");
  rightShade.addColorStop(1, "rgba(40,25,10,0)");
  ctx.fillStyle = rightShade;
  ctx.fillRect(W - 10, 0, 10, H);
}

/** A tall window in the far wall: frame, the hour's sky, mullions, a sill. */
function drawWindow(ctx: CanvasRenderingContext2D, win: Window, light: Light, hair: number): void {
  const top = -WALL_FAR_H + 7;
  const bottom = -10;
  const h = bottom - top;

  // Frame.
  ctx.fillStyle = WINDOW_FRAME;
  roundRect(ctx, win.x - 3, top - 3, win.w + 6, h + 6, 2);
  ctx.fill();

  // Glass: the sky, warming toward the horizon (the bottom) with the sun.
  const sky = ctx.createLinearGradient(0, top, 0, bottom);
  sky.addColorStop(0, light.sky);
  sky.addColorStop(
    1,
    mixHex(light.sky, light.sun > 0 ? light.sunColor : "#ffffff", 0.3 + 0.5 * light.sun),
  );
  ctx.fillStyle = sky;
  ctx.fillRect(win.x, top, win.w, h);

  // After dark: a few stars, and a moon in the first pane.
  const dark = clamp01((0.3 - light.sun) / 0.3);
  if (dark > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(win.x, top, win.w, h);
    ctx.clip();
    ctx.fillStyle = `rgba(255,250,235,${0.9 * dark})`;
    for (let i = 0; i < 14; i++) {
      const px = win.x + hash01(i * 13 + Math.round(win.x)) * win.w;
      const py = top + hash01(i * 7 + 3) * h * 0.6;
      const pr = 0.5 + hash01(i * 5 + 1) * 0.7;
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, Math.PI * 2);
      ctx.fill();
    }
    const mx = win.x + win.w * 0.2;
    const my = top + h * 0.32;
    ctx.fillStyle = `rgba(255,246,214,${0.95 * dark})`;
    ctx.beginPath();
    ctx.arc(mx, my, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = light.sky;
    ctx.beginPath();
    ctx.arc(mx + 2.5, my - 1.5, 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Glass sheen.
  const sheen = ctx.createLinearGradient(win.x, top, win.x + win.w, bottom);
  sheen.addColorStop(0, "rgba(255,255,255,0.18)");
  sheen.addColorStop(0.5, "rgba(255,255,255,0.02)");
  sheen.addColorStop(1, "rgba(255,255,255,0.12)");
  ctx.fillStyle = sheen;
  ctx.fillRect(win.x, top, win.w, h);

  // Mullions and a transom bar.
  ctx.fillStyle = WINDOW_FRAME;
  for (const bx of mullions(win)) ctx.fillRect(bx - 1.5, top, 3, h);
  ctx.fillRect(win.x, top + h * 0.3, win.w, 2.5);

  // Sill.
  ctx.fillStyle = WINDOW_SILL;
  ctx.fillRect(win.x - 5, bottom + 2, win.w + 10, 3);
  ctx.fillStyle = "rgba(40,25,10,0.25)";
  ctx.fillRect(win.x - 5, bottom + 5, win.w + 10, hair * 2);
}

/** The bulletin board hangs on the far wall above its floor rectangle. */
function drawBoard(
  ctx: CanvasRenderingContext2D,
  b: BoardGeometry,
  count: number,
  hair: number,
): void {
  const top = -WALL_FAR_H + 12;
  const h = b.h + WALL_FAR_H - 16;
  ctx.save();
  ctx.fillStyle = "rgba(40,25,10,0.25)";
  roundRect(ctx, b.x + 2, top + 3, b.w, h, 3);
  ctx.fill();
  roundRect(ctx, b.x, top, b.w, h, 3);
  ctx.fillStyle = BOARD_FACE;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = BOARD_FRAME;
  ctx.stroke();
  // A few pinned notes.
  const notes: Array<[number, number, string]> = [
    [0.12, 0.2, "#f6d98a"],
    [0.52, 0.16, "#cfe0f2"],
    [0.32, 0.5, "#f3c5b8"],
    [0.66, 0.52, "#dcebc6"],
  ];
  for (const [nx, ny, c] of notes) {
    ctx.fillStyle = c;
    ctx.fillRect(b.x + b.w * nx, top + h * ny, b.w * 0.24, h * 0.32);
    ctx.fillStyle = "#b54f2c";
    ctx.beginPath();
    ctx.arc(b.x + b.w * (nx + 0.12), top + h * ny + 2, 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
  // Note count, as an unread-style badge on the top-right corner.
  if (count > 0) {
    const r = 8;
    ctx.beginPath();
    ctx.arc(b.x + b.w, top, r, 0, Math.PI * 2);
    ctx.fillStyle = BOARD_BADGE;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = BOARD_FACE;
    ctx.stroke();
    ctx.font = `700 10px ${FONT_FAMILY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.fillText(String(count), b.x + b.w, top + 0.5);
  }
  ctx.lineWidth = hair;
  ctx.restore();
  // Named like the zones: unlabelled it read as one more frame.
  zoneLabel(ctx, "Board", b.x + b.w / 2, b.y + b.h - 2);
}

/** Every piece of furniture, with the hour's shadow under it. */
function drawFurniture(
  ctx: CanvasRenderingContext2D,
  items: FloorItem[],
  light: Light,
  hair: number,
): void {
  const sh = shadowOf(light);

  for (const it of items) {
    switch (it.kind) {
      case "rug":
      case "rugRound":
      case "board":
        break; // rugs are painted before the light; the board on the wall
      case "room":
        drawRoom(ctx, it, hair);
        break;
      case "table":
        drawTable(ctx, it.x, it.y, it.w, it.h, it.round, it.tone, sh);
        break;
      case "couch":
        drawCouch(ctx, it.x, it.y, it.w, it.h, it.back, sh);
        break;
      case "stool":
        drawStool(ctx, it.x, it.y, it.r, it.back, sh);
        break;
      case "plant":
        drawPlant(ctx, it.x, it.y, it.r, it.variant, sh);
        break;
      case "monitor":
        drawMonitor(ctx, it.x, it.y, it.w, light);
        break;
      case "mug":
        drawMug(ctx, it.x, it.y, it.r);
        break;
      case "deskLamp":
        drawDeskLamp(ctx, it.x, it.y, light);
        break;
      case "pendant":
        drawPendant(ctx, it.x, it.y, light);
        break;
      case "floorLamp":
        drawFloorLamp(ctx, it.x, it.y, light, sh);
        break;
      case "machine":
        drawMachine(ctx, it.x, it.y, it.w, it.h, sh);
        break;
      case "shelf":
        drawShelf(ctx, it.x, it.y, it.w, it.h, sh);
        break;
      case "book":
        drawBook(ctx, it.x, it.y, it.w, it.h, it.color);
        break;
    }
  }
}

/** A soft drop shadow, leaning with the light. */
function castShadow(
  ctx: CanvasRenderingContext2D,
  sh: { dx: number; dy: number; alpha: number },
  path: () => void,
  lift = 1,
): void {
  ctx.save();
  ctx.translate(sh.dx * lift, sh.dy * lift);
  ctx.fillStyle = `rgba(50,32,14,${sh.alpha})`;
  path();
  ctx.fill();
  ctx.restore();
}

/** A table with a visible edge: top face, a darker front side, a rim. */
function drawTable(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  round: boolean,
  tone: "oak" | "walnut",
  sh: { dx: number; dy: number; alpha: number },
): void {
  const top = tone === "oak" ? OAK : WALNUT;
  const side = tone === "oak" ? OAK_SIDE : WALNUT_SIDE;
  const thick = 5;
  const shape = (ox: number, oy: number) => {
    if (round) {
      ctx.beginPath();
      ctx.ellipse(x + w / 2 + ox, y + h / 2 + oy, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else {
      roundRect(ctx, x + ox, y + oy, w, h, 5);
    }
  };
  castShadow(ctx, sh, () => shape(0, 0), 1.2);
  // Side (the thickness), then the top on it.
  ctx.fillStyle = side;
  shape(0, thick);
  ctx.fill();
  const g = ctx.createLinearGradient(x, y, x + w * 0.3, y + h);
  g.addColorStop(0, lighten(top, 0.14));
  g.addColorStop(1, top);
  ctx.fillStyle = g;
  shape(0, 0);
  ctx.fill();
  // Wood grain, faint.
  ctx.save();
  shape(0, 0);
  ctx.clip();
  ctx.strokeStyle = "rgba(60,38,18,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = Math.max(7, h / 6);
  for (let gy = y + step * 0.6; gy < y + h; gy += step) {
    ctx.moveTo(x, gy + Math.sin(gy) * 1.5);
    ctx.bezierCurveTo(x + w * 0.3, gy + 2, x + w * 0.7, gy - 2, x + w, gy + 1);
  }
  ctx.stroke();
  ctx.restore();
  ctx.lineWidth = 1;
  ctx.strokeStyle = WOOD_EDGE;
  shape(0, 0);
  ctx.stroke();
}

/** A stool, with an optional chair back on the side away from the table. */
function drawStool(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  back: number | undefined,
  sh: { dx: number; dy: number; alpha: number },
): void {
  castShadow(ctx, sh, () => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
  });
  if (back !== undefined) {
    // The backrest: a thick arc, slightly outside the seat.
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineWidth = r * 0.42;
    ctx.strokeStyle = WALNUT_SIDE;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.02, back - 0.95, back + 0.95);
    ctx.stroke();
    ctx.lineWidth = r * 0.26;
    ctx.strokeStyle = WALNUT;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.02, back - 0.9, back + 0.9);
    ctx.stroke();
    ctx.restore();
  }
  // Seat: a cushion on a wooden rim.
  ctx.beginPath();
  ctx.arc(x, y + 2, r, 0, Math.PI * 2);
  ctx.fillStyle = WALNUT_SIDE;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = WALNUT;
  ctx.fill();
  const cushion = ctx.createRadialGradient(x - r * 0.2, y - r * 0.25, r * 0.1, x, y, r * 0.72);
  cushion.addColorStop(0, "#f0dfc2");
  cushion.addColorStop(1, "#d8c2a0");
  ctx.beginPath();
  ctx.arc(x, y, r * 0.72, 0, Math.PI * 2);
  ctx.fillStyle = cushion;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = WOOD_EDGE;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
}

/** Upholstered seating: arms, a backrest along `back`, cushion seams. */
function drawCouch(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  back: Side,
  sh: { dx: number; dy: number; alpha: number },
): void {
  castShadow(ctx, sh, () => roundRect(ctx, x, y, w, h, 8), 1.3);
  // Body.
  roundRect(ctx, x, y + 3, w, h, 8);
  ctx.fillStyle = UPHOLSTERY_LO;
  ctx.fill();
  roundRect(ctx, x, y, w, h, 8);
  ctx.fillStyle = UPHOLSTERY;
  ctx.fill();

  // Backrest and arms: raised bands, lighter on top.
  const band = Math.min(w, h) * 0.22;
  const bands: Array<[number, number, number, number]> =
    back === "left" || back === "right"
      ? [
          [back === "left" ? x : x + w - band, y, band, h], // backrest
          [x, y, w, band * 0.8], // arm
          [x, y + h - band * 0.8, w, band * 0.8], // arm
        ]
      : [
          [x, back === "top" ? y : y + h - band, w, band],
          [x, y, band * 0.8, h],
          [x + w - band * 0.8, y, band * 0.8, h],
        ];
  for (const [bx, by, bw, bh] of bands) {
    roundRect(ctx, bx, by, bw, bh, 6);
    ctx.fillStyle = UPHOLSTERY_HI;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(40,50,60,0.18)";
    ctx.stroke();
  }

  // Seat cushions: split along the long axis.
  const horizontal = w >= h;
  const inset = band * 0.8;
  const sx = x + (back === "left" ? band : inset);
  const sy = y + (back === "top" ? band : inset);
  const sw = w - (back === "left" || back === "right" ? band + inset : inset * 2);
  const shh = h - (back === "top" || back === "bottom" ? band + inset : inset * 2);
  const n = horizontal ? Math.max(1, Math.round(sw / 60)) : Math.max(1, Math.round(shh / 45));
  for (let i = 0; i < n; i++) {
    const cx = horizontal ? sx + (sw / n) * i : sx;
    const cy = horizontal ? sy : sy + (shh / n) * i;
    const cw = horizontal ? sw / n : sw;
    const ch = horizontal ? shh : shh / n;
    roundRect(ctx, cx + 1.5, cy + 1.5, cw - 3, ch - 3, 5);
    const g = ctx.createLinearGradient(cx, cy, cx, cy + ch);
    g.addColorStop(0, lighten(UPHOLSTERY, 0.14));
    g.addColorStop(1, UPHOLSTERY);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = "rgba(40,50,60,0.2)";
    ctx.stroke();
  }
}

/** A potted plant: a bush of layered leaves, or a palm of radiating fronds. */
function drawPlant(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  variant: "bush" | "palm",
  sh: { dx: number; dy: number; alpha: number },
): void {
  castShadow(ctx, sh, () => {
    ctx.beginPath();
    ctx.arc(x, y, r * 0.95, 0, Math.PI * 2);
  }, 1.6);
  // Pot.
  ctx.beginPath();
  ctx.arc(x, y + 3, r * 0.6, 0, Math.PI * 2);
  ctx.fillStyle = POT_SIDE;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
  ctx.fillStyle = POT;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.48, 0, Math.PI * 2);
  ctx.fillStyle = "#4a3426";
  ctx.fill();

  if (variant === "palm") {
    // Fronds: long leaves radiating from the centre, dark under light.
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.4;
      const len = r * (0.95 + 0.25 * hash01(i * 11 + Math.round(x)));
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.ellipse(len * 0.55, 0, len * 0.55, r * 0.2, 0, 0, Math.PI * 2);
      ctx.fillStyle = i % 2 ? LEAF : LEAF_LO;
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(len * 0.5, -r * 0.04, len * 0.42, r * 0.1, 0, 0, Math.PI * 2);
      ctx.fillStyle = i % 2 ? LEAF_HI : LEAF;
      ctx.fill();
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(x, y, r * 0.18, 0, Math.PI * 2);
    ctx.fillStyle = LEAF_LO;
    ctx.fill();
  } else {
    // A bush: overlapping leaf clusters, shaded underneath.
    const leaves: Array<[number, number, number]> = [
      [0.1, 0.25, 0.62],
      [-0.55, -0.05, 0.56],
      [0.55, -0.08, 0.56],
      [-0.2, -0.5, 0.6],
      [0.28, -0.45, 0.55],
      [0, -0.1, 0.5],
    ];
    for (const [dx, dy, rr] of leaves) {
      ctx.beginPath();
      ctx.arc(x + dx * r, y + dy * r + 2.5, rr * r, 0, Math.PI * 2);
      ctx.fillStyle = LEAF_LO;
      ctx.fill();
    }
    for (const [i, [dx, dy, rr]] of leaves.entries()) {
      const g = ctx.createRadialGradient(
        x + dx * r - rr * r * 0.3,
        y + dy * r - rr * r * 0.35,
        rr * r * 0.1,
        x + dx * r,
        y + dy * r,
        rr * r,
      );
      g.addColorStop(0, LEAF_HI);
      g.addColorStop(1, i % 2 ? LEAF : shade(LEAF, 0.92));
      ctx.beginPath();
      ctx.arc(x + dx * r, y + dy * r, rr * r, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
    }
  }
}

/** A monitor seen from above: a slim dark bar whose screen glows at night. */
function drawMonitor(ctx: CanvasRenderingContext2D, cx: number, y: number, w: number, light: Light): void {
  // Stand foot.
  ctx.fillStyle = METAL;
  ctx.beginPath();
  ctx.ellipse(cx, y + 5, w * 0.16, 2.5, 0, 0, Math.PI * 2);
  ctx.fill();
  // Panel.
  ctx.fillStyle = "#3b3a3c";
  roundRect(ctx, cx - w / 2, y - 2, w, 5, 1.5);
  ctx.fill();
  // Screen edge, lit when the lamps are on.
  const on = light.lamp;
  ctx.fillStyle = on > 0 ? `rgba(${Math.round(150 + 60 * on)},${Math.round(185 + 40 * on)},255,0.9)` : "#6d7a88";
  ctx.fillRect(cx - w / 2 + 1.5, y + 1.5, w - 3, 1.5);
}

/** A mug, from above: a ring with a handle, something warm inside. */
function drawMug(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.fillStyle = "rgba(40,25,10,0.18)";
  ctx.beginPath();
  ctx.arc(x + 0.5, y + 1, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#f4ede0";
  ctx.lineWidth = r * 0.36;
  ctx.beginPath();
  ctx.arc(x + r * 1.05, y, r * 0.42, -1.3, 1.3);
  ctx.stroke();
  ctx.fillStyle = "#f4ede0";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  // A latte: milk foam with a darker ring.
  ctx.fillStyle = "#a97a52";
  ctx.beginPath();
  ctx.arc(x, y, r * 0.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e6cfae";
  ctx.beginPath();
  ctx.arc(x, y, r * 0.42, 0, Math.PI * 2);
  ctx.fill();
}

/** A desk lamp: a round base, an arm, a shade that glows when it is on. */
function drawDeskLamp(ctx: CanvasRenderingContext2D, x: number, y: number, light: Light): void {
  ctx.strokeStyle = METAL;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x + 4, y + 7);
  ctx.lineTo(x - 4, y + 2);
  ctx.stroke();
  ctx.fillStyle = METAL;
  ctx.beginPath();
  ctx.arc(x + 4, y + 7, 3, 0, Math.PI * 2);
  ctx.fill();
  // Shade.
  const on = light.lamp;
  ctx.fillStyle = on > 0 ? mixHex(SHADE, "#ffd58a", on) : SHADE;
  ctx.beginPath();
  ctx.ellipse(x - 6, y + 2, 7, 5, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(60,38,18,0.3)";
  ctx.stroke();
}

/** A pendant light seen from above: a disc on its cord, glowing when on. */
function drawPendant(ctx: CanvasRenderingContext2D, x: number, y: number, light: Light): void {
  const on = light.lamp;
  ctx.fillStyle = on > 0 ? mixHex("#c9a86a", "#ffd58a", on) : "#c9a86a";
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = on > 0 ? `rgba(255,244,214,${0.6 + 0.4 * on})` : "rgba(255,248,230,0.75)";
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(30,20,10,0.4)";
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.stroke();
}

/** A floor lamp: a tall shade seen from above, over a round base. */
function drawFloorLamp(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  light: Light,
  sh: { dx: number; dy: number; alpha: number },
): void {
  castShadow(ctx, sh, () => {
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
  }, 2);
  const on = light.lamp;
  const g = ctx.createRadialGradient(x, y, 2, x, y, 11);
  g.addColorStop(0, on > 0 ? mixHex("#fff6e4", "#ffd58a", on) : "#fff6e4");
  g.addColorStop(1, on > 0 ? mixHex(SHADE, "#f0b864", on) : SHADE);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(60,38,18,0.3)";
  ctx.stroke();
}

/** The café's espresso machine: a steel box with a warm indicator. */
function drawMachine(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  sh: { dx: number; dy: number; alpha: number },
): void {
  castShadow(ctx, sh, () => roundRect(ctx, x, y, w, h, 3), 1.5);
  roundRect(ctx, x, y + 3, w, h, 3);
  ctx.fillStyle = "#5e6166";
  ctx.fill();
  roundRect(ctx, x, y, w, h, 3);
  const g = ctx.createLinearGradient(x, y, x + w, y);
  g.addColorStop(0, "#a9adb3");
  g.addColorStop(0.5, "#d2d5d9");
  g.addColorStop(1, "#9ea2a8");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.fillStyle = "#3b3d41";
  ctx.fillRect(x + w * 0.2, y + h * 0.55, w * 0.6, h * 0.25);
  ctx.fillStyle = "#e8743a";
  ctx.beginPath();
  ctx.arc(x + w * 0.5, y + h * 0.3, 1.6, 0, Math.PI * 2);
  ctx.fill();
}

/** A low shelf against the wall, seen from above. */
function drawShelf(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  sh: { dx: number; dy: number; alpha: number },
): void {
  castShadow(ctx, sh, () => roundRect(ctx, x, y, w, h, 2), 1.4);
  roundRect(ctx, x, y + 3, w, h, 2);
  ctx.fillStyle = WALNUT_SIDE;
  ctx.fill();
  roundRect(ctx, x, y, w, h, 2);
  ctx.fillStyle = WALNUT;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = WOOD_EDGE;
  ctx.stroke();
}

/** A book, from above: a cover with a spine line. */
function drawBook(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = "rgba(40,25,10,0.25)";
  roundRect(ctx, x + 1, y + 1.5, w, h, 1);
  ctx.fill();
  roundRect(ctx, x, y, w, h, 1);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.fillRect(x + 1.5, y, 1, h);
}

/**
 * The meeting room, seen from above: a slate floor shaded along the walls so
 * it reads as enclosed, wooden wall caps, and a whiteboard on its far wall.
 * No door: you walk through the wall as through a table, and a drawn door
 * only promised a collision that is not there.
 */
function drawRoom(
  ctx: CanvasRenderingContext2D,
  it: Extract<FloorItem, { kind: "room" }>,
  hair: number,
): void {
  const { x, y, w, h } = it;
  const t = WALL_T;

  // Floor.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = RUG_MEET;
  ctx.fillRect(x, y, w, h);
  // Tiles.
  ctx.lineWidth = hair;
  ctx.strokeStyle = "rgba(40,50,60,0.14)";
  ctx.beginPath();
  for (let gx = x; gx < x + w; gx += 40) { ctx.moveTo(gx, y); ctx.lineTo(gx, y + h); }
  for (let gy = y; gy < y + h; gy += 40) { ctx.moveTo(x, gy); ctx.lineTo(x + w, gy); }
  ctx.stroke();
  // Inner shadow: a band along each wall, darkest at the wall.
  const shade = WALL_SHADE;
  const bands: Array<[number, number, number, number, number, number]> = [
    [x, y, x, y + shade, w, shade],
    [x, y + h, x, y + h - shade, w, shade],
    [x, y, x + shade, y, shade, h],
    [x + w, y, x + w - shade, y, shade, h],
  ];
  for (const [gx0, gy0, gx1, gy1, bw, bh] of bands) {
    const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
    g.addColorStop(0, "rgba(30,40,50,0.22)");
    g.addColorStop(1, "rgba(30,40,50,0)");
    ctx.fillStyle = g;
    ctx.fillRect(Math.min(gx0, gx1), Math.min(gy0, gy1), bw, bh);
  }
  // Whiteboard on the far wall.
  const bw = w * 0.36;
  const bx = x + w / 2 - bw / 2;
  ctx.fillStyle = "rgba(30,40,50,0.25)";
  ctx.fillRect(bx + 1, y + t / 2 + 1, bw, 9);
  ctx.fillStyle = WHITEBOARD;
  ctx.fillRect(bx, y + t / 2, bw, 8);
  ctx.strokeStyle = METAL;
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, y + t / 2, bw, 8);
  ctx.strokeStyle = "rgba(60,90,160,0.45)";
  ctx.beginPath();
  ctx.moveTo(bx + 6, y + t / 2 + 4);
  ctx.lineTo(bx + bw * 0.45, y + t / 2 + 4);
  ctx.moveTo(bx + bw * 0.55, y + t / 2 + 3);
  ctx.lineTo(bx + bw * 0.8, y + t / 2 + 5);
  ctx.stroke();
  ctx.restore();

  // Walls: wooden caps with a lit top edge, and a shadow outward.
  ctx.save();
  ctx.lineJoin = "miter";
  ctx.lineWidth = t + 4;
  ctx.strokeStyle = "rgba(40,25,10,0.18)";
  ctx.strokeRect(x + 1.5, y + 3, w, h);
  ctx.lineWidth = t;
  ctx.strokeStyle = WALL_CAP_COLOR;
  ctx.strokeRect(x, y, w, h);
  ctx.lineWidth = 2;
  ctx.strokeStyle = WALL_CAP_HI;
  ctx.strokeRect(x - t / 2 + 1, y - t / 2 + 1, w + t - 2, h + t - 2);
  ctx.restore();

  zoneLabel(ctx, it.label, x + w / 2, y + t / 2 + 22);
}

/** Soft darkening toward the edges of the room, for depth. */
function drawVignette(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const cx = W / 2;
  const cy = H / 2;
  const r = Math.hypot(W, H) / 2;
  const g = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r);
  g.addColorStop(0, "rgba(60,40,20,0)");
  g.addColorStop(1, "rgba(60,40,20,0.18)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/** Engraved signage: a small title-case label with a light letter-spacing. */
function zoneLabel(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number): void {
  ctx.save();
  ctx.font = `600 ${FONT_ZONE_PX}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Manual letter-spacing for a calm, signage feel (portable across WebViews).
  const letters = text.split("");
  const sp = 1.4;
  let total = 0;
  for (const ch of letters) total += ctx.measureText(ch).width + sp;
  total -= sp;
  let x = cx - total / 2;
  for (const ch of letters) {
    const cw = ctx.measureText(ch).width;
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillText(ch, x + cw / 2, y + 0.8);
    ctx.fillStyle = ZONE_INK;
    ctx.fillText(ch, x + cw / 2, y);
    x += cw + sp;
  }
  ctx.restore();
}

/** Paper grain: a small tile of faint noise, repeated over the scene. */
function makeGrain(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const tile = document.createElement("canvas");
  tile.width = tile.height = 96;
  const tctx = tile.getContext("2d");
  if (!tctx) return null;
  const img = tctx.createImageData(96, 96);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 110 + Math.round(Math.random() * 90);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 14;
  }
  tctx.putImageData(img, 0, 0);
  return ctx.createPattern(tile, "repeat");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Frame-rate-independent easing factor for an exponential approach. */
function ease(dt: number, tau: number): number {
  if (dt <= 0) return 0;
  return 1 - Math.exp(-dt / tau);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smoothstep, so light keyframes blend without a visible corner. */
function smooth(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Gentle overshoot for a lively-but-calm spawn. */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = clamp01(t) - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}

/** Deterministic 0..1 from an integer seed (for plank tones and stars). */
function hash01(n: number): number {
  let x = (n | 0) * 374761393 + 668265263;
  x = (x ^ (x >>> 13)) * 1274126177;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Parse #RRGGBB into [r,g,b]; falls back to a warm clay on malformed input. */
function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [181, 79, 44];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Lighten a color toward white by `amount` (0..1) — for the token highlight. */
function lighten(hex: string, amount: number): string {
  const [r, g, b] = parseHex(hex);
  const k = clamp01(amount);
  return `rgb(${Math.round(r + (255 - r) * k)},${Math.round(g + (255 - g) * k)},${Math.round(
    b + (255 - b) * k,
  )})`;
}

/** Scale a color's channels by `k` (<1 darkens) — for sides and shoulders. */
function shade(hex: string, k: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
}

/** Blend two hex colours in RGB, as hex (so the result can be parsed again). */
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const k = clamp01(t);
  const c = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${c(lerp(ar, br, k))}${c(lerp(ag, bg, k))}${c(lerp(ab, bb, k))}`;
}

/** Choose black or white ink for legibility on a given background colour. */
function pickInk(hex: string): string {
  const [r, g, b] = parseHex(hex);
  // Relative luminance (sRGB approximation).
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "rgba(40,30,18,0.95)" : "rgba(255,255,255,0.96)";
}

/** Rounded-rect path, manually built for WebView portability. */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
