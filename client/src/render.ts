/**
 * render.ts — Canvas 2D renderer for Hiroba.
 *
 * Hiroba is a virtual office: a warm, furnished room where presence has
 * *context*. Rather than dots floating in an empty void, people gather in
 * recognisable places. The floor plan depends on the space kind:
 *  - Lobby: Focus / Meeting / Lounge / Café / Commons — open ambient floor.
 *    Meeting is a walled room (its rectangle comes from the server, which
 *    uses the same one as the audio boundary): soundproof, walked into
 *    through the wall like any other furniture. Its walls are glass, so
 *    nobody is ever hidden behind them.
 *  - Team: a small room (group call) in the layout chosen at creation —
 *    meeting table, desk island, lounge, or café counter.
 * Seats are clickable: walk-to-snap so idle people rest on furniture instead of
 * scattering across open floor.
 *
 * The room is drawn with **height**: the floor is foreshortened, the far
 * wall stands behind it with its windows, and furniture and people rise off
 * the floor. The camera is a parallel projection with a yaw (rotation about
 * the vertical) and a pitch (how much the floor is squashed). At rest the
 * yaw is zero — the floor keeps the orientation of a plan, with the far
 * wall along the top — and on entering a space the camera swings in from a
 * 45° isometric corner view to that resting view, so the room is seen as a
 * solid thing before settling into the view you work in. World coordinates
 * (the server's 800×600 floor) never change; only the projection does:
 *
 *     x' = (x − cx)·cos θ − (y − cy)·sin θ
 *     y' = (x − cx)·sin θ + (y − cy)·cos θ
 *     sx = x'                sy = y'·K − z
 *
 * Anything that lies flat on the floor (rugs, planks, shadows, rings) is
 * painted in world space under a canvas transform that *is* that projection,
 * so circles come out as the right ellipses for free. Anything that stands
 * up (walls, table legs, people) is drawn in screen space from projected
 * points. Standing things are painter-sorted by depth (y') each frame so a
 * person walks behind a desk and in front of a sofa correctly.
 *
 * The picture is a *lit room*: tall windows in the far walls let daylight
 * fall across the floor, and the light follows the real clock — gold in the
 * morning, clear at noon, amber at dusk; after dark the windows go blue and
 * the lamps take over. People are never tinted, so they stay bright at any
 * hour: they are the reason the room exists.
 *
 * Design philosophy: presence-first and *calm*. The renderer does NOT own a
 * rAF loop — `main.ts` drives a demand-driven loop and calls `draw`. The
 * static backdrop (walls, floor, rugs, shadows, light) is painted once into
 * an offscreen cache and composited per frame; it is rebuilt only when the
 * viewport, the space, the board or the light step (a few minutes of the
 * clock) changes, so a quiet office still repaints nothing (NFR-01).
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
// Projection
// ---------------------------------------------------------------------------

/** The camera: yaw about the vertical (radians) and the floor's squash. */
interface Camera {
  yaw: number;
  pitch: number;
}

/** The resting view: a plan's orientation, tilted enough to show height. */
const CAM_REST: Camera = { yaw: 0, pitch: 0.74 };
/** Where the entrance swing starts: a true isometric corner view. */
const CAM_ENTER: Camera = { yaw: Math.PI / 4, pitch: 0.56 };
/** The swing's length, ms. */
const ENTER_MS = 1500;

/** The camera plus the fit: where the floor's centre lands on the canvas,
 *  and the pixels per world unit. */
interface View {
  cam: Camera;
  cos: number;
  sin: number;
  cx: number;
  cy: number;
  scale: number;
  ox: number;
  oy: number;
}

/** Project a world point (height z) to canvas pixels. */
function pt(V: View, x: number, y: number, z = 0): { x: number; y: number } {
  const dx = x - V.cx;
  const dy = y - V.cy;
  return {
    x: V.ox + (dx * V.cos - dy * V.sin) * V.scale,
    y: V.oy + ((dx * V.sin + dy * V.cos) * V.cam.pitch - z) * V.scale,
  };
}

/** How far into the picture a floor point lies (painter's order). */
function depthAt(V: View, x: number, y: number): number {
  return (x - V.cx) * V.sin + (y - V.cy) * V.cos;
}

/** Set the canvas transform so world-space drawing lands on the floor plane
 *  at height `z`. Circles become the right ellipses, hairlines stay thin. */
function floorXf(ctx: CanvasRenderingContext2D, V: View, z = 0): void {
  const s = V.scale;
  const k = V.cam.pitch;
  const o = pt(V, 0, 0, z);
  ctx.setTransform(V.cos * s, V.sin * k * s, -V.sin * s, V.cos * k * s, o.x, o.y);
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
// `init`. Flat items go into the backdrop; standing items are depth-sorted
// with the people every frame.
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
      /** Height of the top surface, world units. */
      top: number;
    }
  /** A stool, with an optional chair back on `back` (radians from centre). */
  | { kind: "stool"; x: number; y: number; r: number; back?: number }
  /** Upholstered seat; the backrest runs along `back`. */
  | { kind: "couch"; x: number; y: number; w: number; h: number; back: Side }
  | { kind: "plant"; x: number; y: number; r: number; variant: "bush" | "palm" }
  /** A walled room: glass partitions on the server's rectangle. */
  | { kind: "room"; x: number; y: number; w: number; h: number; label: string }
  /** Props that sit on a surface at height `z` and catch the light. */
  | { kind: "monitor"; x: number; y: number; w: number; z: number }
  | { kind: "mug"; x: number; y: number; r: number; z: number }
  | { kind: "deskLamp"; x: number; y: number; z: number }
  | { kind: "pendant"; x: number; y: number; r: number }
  | { kind: "floorLamp"; x: number; y: number }
  | { kind: "machine"; x: number; y: number; w: number; h: number; z: number }
  | { kind: "shelf"; x: number; y: number; w: number; h: number }
  | { kind: "book"; x: number; y: number; w: number; h: number; color: string; z: number };

/** A sit target in world units. Click-to-sit walks here; tokens near a seat
 *  draw slightly smaller so idle people read as "at a desk / chair". */
interface Seat {
  x: number;
  y: number;
  /** Click hit radius in world units (larger than the stool for forgiving taps). */
  hitR: number;
}

/** A window in a far wall: the `right` wall is y = 0 (a span in x), the
 *  `left` wall is x = 0 (a span in y). Light falls from it onto the floor. */
interface Window {
  wall: "left" | "right";
  at: number;
  w: number;
}

/** A length of the meeting room's glass wall (split so it sorts well). */
interface WallSeg {
  kind: "wallSeg";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A footprint on the floor, world units. */
interface Footprint {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One standing thing to paint, at its depth, with the floor it covers. */
interface Standing {
  depth: number;
  fp: Footprint;
  item: FloorItem | WallSeg;
}

interface FloorPlan {
  items: FloorItem[];
  /** Standing items, sorted back to front. */
  standing: Standing[];
  seats: Seat[];
  board: BoardGeometry;
  windows: Window[];
}

// ---------------------------------------------------------------------------
// Visual constants
// ---------------------------------------------------------------------------

// People are sized in world units, so they keep a fixed proportion to the
// room at any window size.
const PEER_R = 20;
const SELF_R = 22;
/** Within this distance of a seat centre, the token uses the seated pose. */
const SEAT_SIT_EPS = 14;
/** Seated people are raised onto the seat and drawn a notch smaller. */
const SEAT_H = 26;
const SEAT_SIT_SCALE = 0.9;
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';
/** Name-chip text size at scale=1; multiply by scale when setting ctx.font. */
const FONT_LABEL_PX = 12.5;
/** Zone signage text size at scale=1. */
const FONT_ZONE_PX = 12;

// The room's shell, world units.
const WALL_H = 150; // far walls
const WALL_T = 10; // their thickness (only the cap shows)
const SLAB_T = 18; // the floor slab's visible edge
const VIEW_PAD = 14;

const FRAME_BG = "#241f1a"; // outside the room — matches the chrome's --frame

// Materials — base colours; the hour's tint multiplies them (see Palette).
const MATERIALS = {
  floorBase: "#e3d2b4",
  floorLight: "#e9d9bc",
  floorDark: "#dbc9a8",
  plaster: "#efe5d6",
  plasterShade: "#d9ccb8",
  plasterLeft: "#e4d8c6",
  baseboard: "#6f5744",
  wallCap: "#8a7360",
  slab: "#5a4535",
  slabLight: "#6e5541",
  windowFrame: "#5a4738",
  sill: "#f6efe2",
  oak: "#d6b78b",
  oakSide: "#b3915f",
  oakDark: "#9a7a4e",
  walnut: "#a8794c",
  walnutSide: "#7f5733",
  walnutDark: "#5e3f24",
  upholstery: "#9ea9b0",
  upholsteryHi: "#b6c0c5",
  upholsteryLo: "#7d8990",
  upholsteryDark: "#66737b",
  cushion: "#eadcc0",
  pot: "#b7724d",
  potSide: "#8f5536",
  soil: "#4a3426",
  leaf: "#6c9a52",
  leafHi: "#8bb86b",
  leafLo: "#4f7a3b",
  metal: "#8e9196",
  metalHi: "#c9ccd1",
  shade: "#f1dfbf",
  panel: "#3b3a3c",
  screen: "#6d7a88",
  glassRail: "#a89a88",
  rugMeet: "#b8c8d2",
  cup: "#f4ede0",
  latte: "#a97a52",
  boardFace: "#f8f1e4",
  boardFrame: "#8a6540",
} as const;
type MaterialKey = keyof typeof MATERIALS;
/** Every material under the hour's tint, plus the tint itself. */
type Palette = Record<MaterialKey, string> & { tint: string };

const BOARD_BADGE = "#b54f2c"; // note count (the UI accent)
const BOARD_Z0 = 62; // the board hangs between these heights on the wall
const BOARD_Z1 = 118;
const GLOW = "255,196,120"; // lamp light, rgb

// Zone rugs — woven, muted, distinct.
const RUG_FOCUS = "#d8b7a6"; // dusty rose
const RUG_MEET = "#b8c8d2"; // slate — the team meeting room's rug
const RUG_LOUNGE = "#bfcbae"; // sage
const RUG_CAFE = "#e2c893"; // straw
const RUG_COMMONS = "#d7c2a4"; // jute

const ZONE_INK = "rgba(70,52,34,0.6)";

// Glass partitions.
const GLASS_H = 112;
const GLASS_BASE_H = 14;
const GLASS_T = 4;
const GLASS_FILL = "rgba(190,220,235,0.14)";
const GLASS_EDGE = "rgba(255,255,255,0.5)";

// The one accent: warm clay/coral, for the proximity ring & self.
// Matches --accent (#b54f2c) so canvas chrome tracks the AA-safe UI tokens.
const NEAR_FILL = "rgba(181,79,44,0.07)";
const NEAR_STROKE = "rgba(181,79,44,0.32)";

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
  /** Ambient tint multiplied over the room at full `ambientA`; a lower
   *  strength blends the tint toward white (no tint). */
  ambient: string;
  ambientA: number;
  /** 0..1 how brightly the lamps burn. */
  lamp: number;
  /** Lean of the light pools (+ right) as a fraction of their length. */
  skew: number;
  /** Length of the light pools as a fraction of the room's depth. */
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

/** Every material, multiplied by the hour's tint (white = no tint). */
function makePalette(light: Light): Palette {
  const tint = mixHex("#ffffff", light.ambient, light.ambientA);
  const out = { tint } as Palette;
  for (const k of Object.keys(MATERIALS) as MaterialKey[]) out[k] = mulHex(MATERIALS[k], tint);
  return out;
}

/** Furniture shadows follow the strongest light: long and leaning by day,
 *  short and straight under the lamps at night. */
function shadowOf(light: Light): { dx: number; dy: number; alpha: number } {
  return {
    dx: light.skew * 9 * light.sun,
    dy: 6 + 9 * light.sun * light.reach,
    alpha: 0.16 + 0.1 * light.sun,
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

  /** The static backdrop at the current viewport; `sceneKey` says what it
   *  was painted for. */
  private scene: HTMLCanvasElement | null = null;
  private sceneKey = "";
  /** The light step the last scene was painted at (for the clock poll). */
  private lightStep = -1;
  /** The light and palette the standing pass uses (same step as the scene). */
  private light: Light = lightAt(12);
  private palette: Palette = makePalette(this.light);
  /** Paper grain, tiled over the backdrop. */
  private grain: CanvasPattern | null = null;

  /** Name chips queued during the token pass, flushed on a top layer so a
   *  nearby token can cover a body but never hide who someone is. */
  private chipQueue: Array<{
    name: string;
    x: number;
    bottom: number;
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

  /** The entrance swing: when it started (0 = not swinging), and the yaw
   *  the standing items were last sorted for. */
  private enterStart = 0;
  private sortedYaw = NaN;

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
    this.sortedYaw = NaN;
    this.seatHover = null;
    this.boardNotes = null;
    // Swing in from the corner view (not for those who asked for less motion).
    this.enterStart = prefersReducedMotion() ? 0 : -1;
    this.onWake?.();
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
   * The projection that fits the whole room — walls and slab included — in
   * the viewport, centred. There is no camera to pan; a future zoom (a floor
   * bigger than one screen) is what would bring one back, and both `draw`
   * and the hit-tests would then need to share its state through here.
   */
  private _view(space: SpaceDescriptor): View {
    return fitView(this.canvas.width, this.canvas.height, space, this._camera(this.lastDraw));
  }

  /** The camera at time `now`: mid-swing after `init`, else at rest. */
  private _camera(now: number): Camera {
    if (this.enterStart === 0) return CAM_REST;
    if (this.enterStart < 0) return CAM_ENTER; // not started yet (first draw starts it)
    const t = (now - this.enterStart) / ENTER_MS;
    if (t >= 1) return CAM_REST;
    const e = easeInOutCubic(clamp01(t));
    return {
      yaw: lerp(CAM_ENTER.yaw, CAM_REST.yaw, e),
      pitch: lerp(CAM_ENTER.pitch, CAM_REST.pitch, e),
    };
  }

  /** Canvas pixel coordinates of a pointer event. */
  private _canvasPx(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return { x: (clientX - rect.left) * dpr, y: (clientY - rect.top) * dpr };
  }

  /** Un-project a canvas pixel onto the plane at height `z`. */
  private _toWorldAt(px: number, py: number, z: number, V: View): { x: number; y: number } {
    const sx = (px - V.ox) / V.scale;
    const sy = ((py - V.oy) / V.scale + z) / V.cam.pitch;
    return {
      x: V.cx + sx * V.cos + sy * V.sin,
      y: V.cy - sx * V.sin + sy * V.cos,
    };
  }

  /**
   * Map a pointer event's client coordinates to world units on the floor,
   * for click-to-walk. Returns null before a session initializes.
   */
  screenToWorld(clientX: number, clientY: number): { x: number; y: number } | null {
    const { space } = this;
    if (!space) return null;
    const p = this._canvasPx(clientX, clientY);
    return this._toWorldAt(p.x, p.y, 0, this._view(space));
  }

  /**
   * Hit-test remote peers for pointer interaction. Returns the closest peer
   * whose drawn figure (head or body) contains the point, or null.
   */
  peerAtScreen(clientX: number, clientY: number): string | null {
    const { space } = this;
    if (!space) return null;
    const p = this._canvasPx(clientX, clientY);
    const V = this._view(space);

    let best: { id: string; d: number } | null = null;
    for (const peer of this.peers.values()) {
      if (peer.leaving) continue;
      const fig = this._figure(V, peer, false, this._isSeated(peer.x, peer.y));
      const dHead = Math.hypot(p.x - fig.headX, p.y - fig.headY);
      const inBody =
        Math.abs(p.x - fig.headX) <= fig.r * 1.05 && p.y >= fig.headY && p.y <= fig.feetY;
      if (dHead <= fig.r * 1.15 || inBody) {
        const d = Math.min(dHead, Math.abs(p.y - fig.headY));
        if (!best || d < best.d) best = { id: peer.id, d };
      }
    }
    return best?.id ?? null;
  }

  /**
   * Hit-test seats for click-to-sit. Returns the closest seat whose hit
   * radius contains the point, or null. Peers should be tested first so a
   * click on someone sitting still pages them. The point is un-projected at
   * seat height as well as floor height, so a tap on the drawn cushion
   * counts.
   */
  seatAtScreen(clientX: number, clientY: number): { x: number; y: number } | null {
    const { space, plan } = this;
    if (!space || !plan) return null;
    const p = this._canvasPx(clientX, clientY);
    const V = this._view(space);
    const probes = [this._toWorldAt(p.x, p.y, 0, V), this._toWorldAt(p.x, p.y, SEAT_H, V)];

    let best: { seat: Seat; d: number } | null = null;
    for (const s of plan.seats) {
      for (const w of probes) {
        const d = Math.hypot(w.x - s.x, w.y - s.y);
        if (d <= s.hitR && (!best || d < best.d)) best = { seat: s, d };
      }
    }
    return best ? { x: best.seat.x, y: best.seat.y } : null;
  }

  /** How many notes the board holds, or null for "this space has no board". */
  setBoardNotes(count: number | null): void {
    this.boardNotes = count;
    this.onWake?.();
  }

  /** Hit-test the bulletin board (on the far wall). Returns where to stand
   *  to read it. */
  boardAtScreen(clientX: number, clientY: number): { x: number; y: number } | null {
    const { space } = this;
    const b = this.plan?.board;
    if (!space || !b || this.boardNotes === null) return null;
    const p = this._canvasPx(clientX, clientY);
    const V = this._view(space);
    // Test the board's wall-mounted parallelogram directly: un-project at a
    // few heights and accept when the point lands on the wall (y ≈ 0)
    // between the board's edges.
    for (let z = BOARD_Z0 - 4; z <= BOARD_Z1 + 4; z += 4) {
      const w = this._toWorldAt(p.x, p.y, z, V);
      if (Math.abs(w.y) <= 2.5 / V.cam.pitch && w.x >= b.x && w.x <= b.x + b.w) {
        return { x: b.standX, y: b.standY };
      }
    }
    return null;
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

    // The entrance swing starts on the first frame after `init`.
    if (this.enterStart < 0) this.enterStart = now;
    const swinging = this.enterStart > 0 && now - this.enterStart < ENTER_MS;
    if (swinging) highRate = true;
    else if (this.enterStart > 0) this.enterStart = 0;
    const V = fitView(this.canvas.width, this.canvas.height, space, this._camera(now));

    // Furniture keeps its painter's order for the current yaw.
    if (this.sortedYaw !== V.cam.yaw) {
      sortStanding(plan.standing, V);
      this.sortedYaw = V.cam.yaw;
    }

    // --- The static room, from the cache ---
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this._scene(space, plan, V), 0, 0);

    // --- Flat, live marks on the floor ---
    ctx.save();
    floorXf(ctx, V);
    ctx.beginPath();
    ctx.rect(0, 0, space.width, space.height);
    ctx.clip();
    this._drawNearRings(V, self, space);
    this._drawSeatHover(V);
    if (this.walkTarget) {
      this._drawWalkMarker(now, this.walkTarget.x, this.walkTarget.y, V);
      highRate = true;
    }
    ctx.restore();

    // --- Advance peers (interpolate, fade) and reap leavers ---
    const lerpK = ease(dt, PEER_LERP_TAU);
    const animK = ease(dt, ANIM_TAU);
    const reap: string[] = [];
    for (const p of this.peers.values()) {
      p.x += (p.targetX - p.x) * lerpK;
      p.y += (p.targetY - p.y) * lerpK;
      if (Math.hypot(p.targetX - p.x, p.targetY - p.y) > SETTLE_EPS) highRate = true;
      if (p.leaving) {
        p.leave += (0 - p.leave) * animK;
        if (p.leave < 0.02) { reap.push(p.id); continue; }
        highRate = true;
      } else if (p.spawn < 0.999) {
        p.spawn += (1 - p.spawn) * animK;
        highRate = true;
      }
    }
    for (const id of reap) this.peers.delete(id);

    // --- Standing things, back to front: furniture and people interleaved ---
    const people: Array<{ depth: number; peer: RenderPeer; isSelf: boolean }> = [];
    for (const p of this.peers.values()) {
      people.push({ depth: depthAt(V, p.x, p.y), peer: p, isSelf: false });
    }
    // Self sorts a hair in front of anyone at the same spot, so "you" are
    // never hidden by a peer standing exactly where you stand.
    people.push({ depth: depthAt(V, self.x, self.y) + 0.01, peer: self, isSelf: true });
    people.sort((a, b) => a.depth - b.depth);

    // Each person is painted right after the last item they stand in front
    // of (see `inFrontOf`); furniture keeps its own back-to-front order.
    const standing = plan.standing;
    const sideFaces = V.cam.yaw > 0.01;
    const slot: Array<typeof people> = [];
    for (const entry of people) {
      let at = 0;
      for (let i = 0; i < standing.length; i++) {
        if (inFrontOf(entry.peer.x, entry.peer.y, standing[i].fp, sideFaces)) at = i + 1;
      }
      (slot[at] ??= []).push(entry);
    }

    this.chipQueue.length = 0;
    const drawPerson = (entry: (typeof people)[number]) => {
      const level = entry.isSelf ? levels.selfLevel : levels.levelOf(entry.peer.id);
      if (level > 0) lowRate = true;
      if (entry.peer.status === "in_call") lowRate = true;
      this._drawPeer(effectsNow, V, entry.peer, entry.isSelf, level, this._isSeated(entry.peer.x, entry.peer.y));
    };
    for (let i = 0; i <= standing.length; i++) {
      for (const entry of slot[i] ?? []) drawPerson(entry);
      if (i < standing.length) drawStanding(ctx, V, standing[i].item, this.palette, this.light);
    }

    // Name chips above every figure (self's chip queued last, so it wins).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const c of this.chipQueue) {
      ctx.globalAlpha = c.alpha;
      this._drawNameChip(c.name, c.x, c.bottom, c.isSelf, V.scale);
    }
    ctx.globalAlpha = 1;
    this.chipQueue.length = 0;

    return { highRate, lowRate };
  }

  /** Paint the "not in a space" screen. Cheap; called when idle. */
  paintIdle(): void {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = FRAME_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  /**
   * The static backdrop at the current viewport, repainted only when
   * something it depends on changed: size, space, board count, or the light
   * step. Also refreshes the palette the standing pass draws with.
   */
  private _scene(space: SpaceDescriptor, plan: FloorPlan, V: View): HTMLCanvasElement {
    const step = this._lightStep();
    const key = `${this.canvas.width}x${this.canvas.height}|${space.id}|${this.boardNotes}|${step}|${V.cam.yaw}|${V.cam.pitch}`;
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

    if (step !== this.lightStep) {
      this.light = lightAt((step * LIGHT_STEP_MIN) / 60);
      this.palette = makePalette(this.light);
      this.lightStep = step;
    }
    paintBackdrop(sctx, V, space, plan, this.boardNotes, this.light, this.palette, this.grain);

    this.sceneKey = key;
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
  // Live layer: hover, rings, people
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

  /** Soft accent ring on the seat under the pointer (floor transform set). */
  private _drawSeatHover(V: View): void {
    if (!this.seatHover) return;
    const ctx = this.ctx;
    const { x, y } = this.seatHover;
    ctx.beginPath();
    ctx.arc(x, y, 16, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(181,79,44,0.5)";
    ctx.lineWidth = 2.2 / V.scale + 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(181,79,44,0.22)";
    ctx.fill();
  }

  /** The click-to-walk destination: a soft accent dot with a breathing ring
   *  (floor transform set). */
  private _drawWalkMarker(now: number, x: number, y: number, V: View): void {
    const ctx = this.ctx;
    const phase = (now / 1000) % 1; // one breath per second
    const ringR = (7 + 5 * phase) / V.scale + 3;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, 3.5 / V.scale + 1.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(181,79,44,0.85)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(181,79,44,${0.55 * (1 - phase)})`;
    ctx.lineWidth = 2 / V.scale;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The "talking range" around self: a circle on the open floor; inside the
   * meeting room, the room itself — that is exactly who hears you. Floor
   * transform set by the caller.
   */
  private _drawNearRings(V: View, self: RenderPeer, space: SpaceDescriptor): void {
    const ctx = this.ctx;
    const room = space.meetingRoom;
    const big = (space.width + space.height) * 2;

    ctx.save();
    ctx.beginPath();
    if (room && rectContains(room, self)) {
      ctx.rect(room.x, room.y, room.w, room.h);
    } else {
      if (room) {
        // The wall is soundproof: the circle stops at it.
        ctx.rect(-big, -big, big * 2, big * 2);
        ctx.rect(room.x, room.y, room.w, room.h);
        ctx.clip("evenodd");
        ctx.beginPath();
      }
      ctx.arc(self.x, self.y, space.nearRadius, 0, Math.PI * 2);
    }
    ctx.fillStyle = NEAR_FILL;
    ctx.fill();
    ctx.strokeStyle = NEAR_STROKE;
    ctx.lineWidth = 1.4 / V.scale;
    ctx.setLineDash([4 / V.scale, 9 / V.scale]);
    ctx.stroke();
    ctx.restore();
  }

  /** Where a person's figure lands on screen: feet, head centre, head radius. */
  private _figure(
    V: View,
    peer: RenderPeer,
    isSelf: boolean,
    seated: boolean,
  ): { feetX: number; feetY: number; headX: number; headY: number; r: number } {
    const appear = isSelf ? 1 : peer.leaving ? peer.leave : easeOutBack(peer.spawn);
    const sitScale = seated ? SEAT_SIT_SCALE : 1;
    const r = (isSelf ? SELF_R : PEER_R) * V.scale * (0.6 + 0.4 * appear) * sitScale;
    const feet = pt(V, peer.x, peer.y, seated ? SEAT_H : 0);
    const bodyH = r * (seated ? 1.1 : 1.45);
    return { feetX: feet.x, feetY: feet.y, headX: feet.x, headY: feet.y - bodyH - r * 0.78, r };
  }

  private _drawPeer(
    now: number,
    V: View,
    peer: RenderPeer,
    isSelf: boolean,
    level: number,
    seated: boolean,
  ): void {
    const ctx = this.ctx;
    let alpha = isSelf ? 1 : clamp01(peer.leaving ? peer.leave : peer.spawn);
    // Away and DND both dim: away as a soft idle cue, DND so the member reads
    // as unreachable on the canvas (walking over will not open a link) — the
    // ring/badge alone didn't communicate that.
    if (peer.status === "away" || peer.status === "dnd") alpha *= 0.62;
    const { r, headX, headY, feetX, feetY } = this._figure(V, peer, isSelf, seated);

    // --- On the floor: speaking bloom, shadow, self's pool of light ---
    ctx.save();
    ctx.globalAlpha = alpha;
    floorXf(ctx, V);
    if (level > 0) this._drawRipples(now, peer.x, peer.y, peer.color, level, V);
    if (isSelf && peer.status === "active") {
      const halo = ctx.createRadialGradient(peer.x, peer.y, 10, peer.x, peer.y, 70);
      halo.addColorStop(0, "rgba(255,246,228,0.55)");
      halo.addColorStop(1, "rgba(255,246,228,0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(peer.x, peer.y, 70, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!seated) {
      const sh = ctx.createRadialGradient(peer.x, peer.y, 4, peer.x, peer.y, 30);
      sh.addColorStop(0, "rgba(50,32,14,0.4)");
      sh.addColorStop(1, "rgba(50,32,14,0)");
      ctx.fillStyle = sh;
      ctx.beginPath();
      ctx.arc(peer.x, peer.y, 30, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;

    // --- Body: a rounded figure standing on its feet, in the peer's colour ---
    const bw = r * 0.95;
    const bodyTop = headY + r * 0.55;
    const body = ctx.createLinearGradient(feetX - bw, 0, feetX + bw, 0);
    body.addColorStop(0, shade(peer.color, 0.7));
    body.addColorStop(0.45, shade(peer.color, 0.92));
    body.addColorStop(1, shade(peer.color, 0.78));
    roundRect(ctx, feetX - bw, bodyTop, bw * 2, feetY - bodyTop, bw);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.05);
    ctx.strokeStyle = "rgba(255,252,246,0.55)";
    ctx.stroke();

    // --- Head, with a soft top highlight so it reads as a rounded token ---
    const headG = ctx.createRadialGradient(headX - r * 0.25, headY - r * 0.35, r * 0.1, headX, headY, r);
    headG.addColorStop(0, lighten(peer.color, 0.3));
    headG.addColorStop(1, peer.color);
    ctx.beginPath();
    ctx.arc(headX, headY, r, 0, Math.PI * 2);
    ctx.fillStyle = headG;
    ctx.fill();

    // --- Face: uploaded photo (circle-clipped), else the initial letter ---
    const photo = peer.avatar ? this._avatarImage(peer.avatar) : null;
    if (photo) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(headX, headY, r, 0, Math.PI * 2);
      ctx.clip();
      // Avatars are stored well above token size, so this is always a
      // downscale — ask for the good resampler or faces come out crunchy.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(photo, headX - r, headY - r, r * 2, r * 2);
      ctx.restore();
    } else {
      ctx.fillStyle = pickInk(peer.color);
      ctx.font = `600 ${Math.max(13, Math.round(r * 0.78))}px ${FONT_FAMILY}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText((peer.name[0] ?? "?").toUpperCase(), headX, headY + 1);
    }

    // Rim: a paper-white ring, thicker for self.
    ctx.beginPath();
    ctx.arc(headX, headY, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(isSelf ? 2.5 : 1.5, r * (isSelf ? 0.1 : 0.07));
    ctx.strokeStyle = isSelf ? "rgba(255,252,246,0.97)" : "rgba(255,252,246,0.85)";
    ctx.stroke();

    // --- Page hover ring (click-to-call affordance) ---
    if (!isSelf && peer.id === this.pageHoverId) {
      ctx.save();
      ctx.globalAlpha = alpha * 0.9;
      ctx.beginPath();
      ctx.arc(headX, headY, r + Math.max(5, r * 0.22), 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(181,79,44,0.85)";
      ctx.lineWidth = Math.max(2.5, r * 0.1);
      ctx.stroke();
      ctx.restore();
    }

    // --- Status ring / pulse (away, dnd, in_call) ---
    if (peer.status !== "active") {
      this._drawStatusRing(now, headX, headY, r, peer.status, alpha);
    }

    // --- Mute badge (muted peers only; self mute is shown in the HUD) ---
    if (peer.muted && !isSelf) {
      this._drawMuteBadge(headX + r * 0.72, headY - r * 0.72, Math.max(7, r * 0.32));
    }

    // --- DND badge (bottom-left so it doesn't collide with mute) ---
    if (peer.status === "dnd") {
      this._drawDndBadge(headX - r * 0.72, headY + r * 0.72, Math.max(7, r * 0.32));
    }

    // --- Name chip above the head (queued; drawn on the top layer) ---
    const ringPad = peer.status !== "active" ? r * 0.2 : 0;
    this.chipQueue.push({
      name: peer.name,
      x: headX,
      bottom: headY - r - ringPad - 6 * V.scale,
      isSelf,
      alpha,
    });

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

  /** A warm bloom on the floor under a talking peer, and rings radiating
   *  outward in time. Floor transform set by the caller. */
  private _drawRipples(
    now: number,
    x: number,
    y: number,
    color: string,
    level: number,
    V: View,
  ): void {
    const ctx = this.ctx;
    const lv = clamp01(level);
    const reach = 45 + 60 * lv; // world units
    const t = (now / 1000) / RIPPLE_PERIOD;
    const [cr, cg, cb] = parseHex(color);

    ctx.save();
    const bloom = ctx.createRadialGradient(x, y, 10, x, y, reach);
    bloom.addColorStop(0, `rgba(${cr},${cg},${cb},${0.32 * (0.4 + 0.6 * lv)})`);
    bloom.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(x, y, reach, 0, Math.PI * 2);
    ctx.fill();

    const baseAlpha = ctx.globalAlpha;
    ctx.lineWidth = 2 / V.scale;
    for (let i = 0; i < RIPPLE_COUNT; i++) {
      const phase = (t + i / RIPPLE_COUNT) % 1;
      const rr = 14 + phase * (reach - 14);
      const fade = (1 - phase) * (0.25 + 0.5 * lv);
      ctx.globalAlpha = baseAlpha * fade;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
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
    bottom: number,
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
    const top = bottom - chipH;

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

/** Fit the projected room — walls, floor and slab — into a viewport. */
function fitView(vw: number, vh: number, space: SpaceDescriptor, cam: Camera): View {
  const W = space.width;
  const H = space.height;
  const V: View = {
    cam,
    cos: Math.cos(cam.yaw),
    sin: Math.sin(cam.yaw),
    cx: W / 2,
    cy: H / 2,
    scale: 1,
    ox: 0,
    oy: 0,
  };
  // Projected extents of the room's box at scale 1, centred on the floor.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const x of [-WALL_T, W + WALL_T]) {
    for (const y of [-WALL_T, H + WALL_T]) {
      for (const z of [-SLAB_T, WALL_H]) {
        const p = pt(V, x, y, z);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    }
  }
  minX -= VIEW_PAD; maxX += VIEW_PAD; minY -= VIEW_PAD; maxY += VIEW_PAD;
  const scale = Math.min(vw / (maxX - minX), vh / (maxY - minY));
  V.scale = scale;
  V.ox = (vw - (maxX + minX) * scale) / 2;
  V.oy = (vh - (maxY + minY) * scale) / 2;
  return V;
}

// ---------------------------------------------------------------------------
// Floor-plan builder
// ---------------------------------------------------------------------------

/**
 * Lay out furniture in world units, as fractions of the space so it fits any
 * server geometry. Layout depends on `space.kind`:
 *  - lobby → multi-zone open floor (Focus / Meeting / Lounge / Café / Commons)
 *  - team  → the room's `layout` (see `TEAM_FLOORS`); a server from before
 *    layouts sends none, and its team rooms are all meeting rooms.
 */
function buildFloor(space: SpaceDescriptor): FloorPlan {
  const plan =
    space.kind === "lobby" ? buildLobbyFloor(space) : TEAM_FLOORS[space.layout ?? "meeting"](space);
  plan.standing = collectStanding(plan.items);
  return plan;
}

/** Surface heights, world units. */
const DESK_H = 42;
const COUNTER_H = 48;
const LOW_TABLE_H = 24;
const MEETING_TABLE_H = 40;

/** Default stool radius as a fraction of room width. */
const STOOL_R = 0.022;
/** Minimum click hit radius in world units (forgiving on small windows). */
function seatHitR(stoolR: number): number {
  return Math.max(stoolR * 2.4, 28);
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
 * with six chairs under a pendant, sized so the ring clears the glass.
 */
function pushMeetingRoom(items: FloorItem[], seats: Seat[], room: Rect, stoolR: number): void {
  items.push({ kind: "room", x: room.x, y: room.y, w: room.w, h: room.h, label: "Meeting" });
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
    top: MEETING_TABLE_H,
  });
  items.push({ kind: "pendant", x: cx, y: cy, r: tr * 1.9 });
  const ring = tr + stoolR * 1.5;
  // Ring starts at 3 o'clock so no chair sits under the signage at the top.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    pushStool(items, seats, cx + Math.cos(a) * ring, cy + Math.sin(a) * ring, stoolR, a);
  }
}

/** A focus desk: oak top, a monitor and a lamp or a mug, a chair in front. */
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
  items.push({ kind: "table", x, y, w, h, round: false, tone: "oak", top: DESK_H });
  items.push({ kind: "monitor", x: x + w * 0.5, y: y + h * 0.35, w: w * 0.5, z: DESK_H });
  if (lamp) items.push({ kind: "deskLamp", x: x + w * 0.85, y: y + h * 0.45, z: DESK_H });
  else items.push({ kind: "mug", x: x + w * 0.84, y: y + h * 0.62, r: w * 0.06, z: DESK_H });
  pushStool(items, seats, x + w / 2, y + h + stoolR * 1.9, stoolR, Math.PI / 2);
}

/** Open ambient lobby: five zones so presence has place-context. */
function buildLobbyFloor(space: SpaceDescriptor): FloorPlan {
  const W = space.width;
  const H = space.height;
  const items: FloorItem[] = [];
  const seats: Seat[] = [];
  const sr = STOOL_R * W;

  // --- Focus desks (far corner): a row of desks with chairs ---
  items.push({ kind: "rug", x: 0.05 * W, y: 0.06 * H, w: 0.36 * W, h: 0.32 * H, color: RUG_FOCUS, label: "Focus" });
  for (let i = 0; i < 3; i++) {
    pushDesk(items, seats, (0.1 + i * 0.1) * W, 0.14 * H, 0.085 * W, 0.07 * H, sr, i !== 1);
  }
  items.push({ kind: "plant", x: 0.07 * W, y: 0.33 * H, r: 0.035 * W, variant: "palm" });

  // --- A bookshelf against the left wall, between Focus and Lounge ---
  items.push({ kind: "shelf", x: 0.004 * W, y: 0.43 * H, w: 0.03 * W, h: 0.13 * H });

  // --- Meeting: the glass room, a round table ringed by chairs ---
  if (space.meetingRoom) pushMeetingRoom(items, seats, space.meetingRoom, sr);

  // --- Lounge: couch + coffee table + plant ---
  items.push({ kind: "rug", x: 0.05 * W, y: 0.6 * H, w: 0.37 * W, h: 0.33 * H, color: RUG_LOUNGE, label: "Lounge" });
  items.push({ kind: "couch", x: 0.08 * W, y: 0.66 * H, w: 0.1 * W, h: 0.2 * H, back: "left" });
  // Couch seats (no stool mesh — sit targets along the cushions).
  for (const [sx, sy] of [[0.13, 0.72], [0.13, 0.8], [0.13, 0.88]] as const) {
    seats.push({ x: sx * W, y: sy * H, hitR: seatHitR(sr * 1.1) });
  }
  items.push({ kind: "table", x: 0.22 * W, y: 0.72 * H, w: 0.11 * W, h: 0.1 * H, round: true, tone: "walnut", top: LOW_TABLE_H });
  items.push({ kind: "mug", x: 0.255 * W, y: 0.765 * H, r: 0.0065 * W, z: LOW_TABLE_H });
  items.push({ kind: "book", x: 0.285 * W, y: 0.75 * H, w: 0.03 * W, h: 0.035 * H, color: "#7a5f8a", z: LOW_TABLE_H });
  items.push({ kind: "floorLamp", x: 0.375 * W, y: 0.9 * H });
  items.push({ kind: "plant", x: 0.37 * W, y: 0.66 * H, r: 0.035 * W, variant: "bush" });

  // --- Café: counter + stools + plant ---
  items.push({ kind: "rug", x: 0.58 * W, y: 0.6 * H, w: 0.37 * W, h: 0.33 * H, color: RUG_CAFE, label: "Café" });
  items.push({ kind: "table", x: 0.62 * W, y: 0.66 * H, w: 0.29 * W, h: 0.065 * H, round: false, tone: "walnut", top: COUNTER_H });
  items.push({ kind: "machine", x: 0.635 * W, y: 0.668 * H, w: 0.035 * W, h: 0.045 * H, z: COUNTER_H });
  for (const mx of [0.72, 0.79, 0.86]) {
    items.push({ kind: "mug", x: mx * W, y: 0.69 * H, r: 0.0065 * W, z: COUNTER_H });
  }
  for (const px of [0.705, 0.845]) items.push({ kind: "pendant", x: px * W, y: 0.69 * H, r: 0.085 * W });
  for (let i = 0; i < 4; i++) {
    pushStool(items, seats, (0.66 + i * 0.07) * W, 0.76 * H, sr);
  }
  items.push({ kind: "plant", x: 0.9 * W, y: 0.86 * H, r: 0.035 * W, variant: "palm" });

  // --- Commons (centre): open gathering circle with a low table ---
  const cr = 0.12 * Math.min(W, H);
  items.push({ kind: "rugRound", x: 0.5 * W, y: 0.5 * H, r: cr, color: RUG_COMMONS, label: "Commons" });
  items.push({ kind: "table", x: 0.47 * W, y: 0.47 * H, w: 0.06 * W, h: 0.06 * H, round: true, tone: "walnut", top: LOW_TABLE_H });
  items.push({ kind: "plant", x: 0.5 * W, y: 0.5 * H, r: 0.014 * W, variant: "bush" });
  // Soft sit ring around the commons table (no extra stools — keeps the
  // centre open while still offering idle rest spots).
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    seats.push({ x: 0.5 * W + Math.cos(a) * cr * 0.72, y: 0.5 * H + Math.sin(a) * cr * 0.72, hitR: seatHitR(sr) });
  }

  // Windows: two in the right wall (over Focus, over the meeting room), one
  // in the left wall by the lounge. The board hangs between the first two.
  const windows: Window[] = [
    { wall: "right", at: 0.1 * W, w: 0.3 * W },
    { wall: "right", at: 0.63 * W, w: 0.29 * W },
    { wall: "left", at: 0.62 * H, w: 0.26 * H },
  ];

  return { items, standing: [], seats, board: boardGeometry(space), windows };
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

/** Team rooms: two windows right of the board, and one in the left wall. */
function teamWindows(space: SpaceDescriptor): Window[] {
  return [
    { wall: "right", at: 0.36 * space.width, w: 0.3 * space.width },
    { wall: "right", at: 0.74 * space.width, w: 0.18 * space.width },
    { wall: "left", at: 0.3 * space.height, w: 0.3 * space.height },
  ];
}

function pushPlants(
  items: FloorItem[],
  space: SpaceDescriptor,
  at: Array<[number, number, "bush" | "palm"]>,
): void {
  for (const [x, y, variant] of at) {
    items.push({ kind: "plant", x: x * space.width, y: y * space.height, r: 0.038 * space.width, variant });
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
  items.push({ kind: "rugRound", x: 0.5 * W, y: 0.5 * H, r: 0.3 * minSide, color: RUG_MEET });

  // Central table under a pendant.
  const tr = 0.1 * minSide;
  items.push({ kind: "table", x: 0.5 * W - tr, y: 0.5 * H - tr, w: tr * 2, h: tr * 2, round: true, tone: "walnut", top: MEETING_TABLE_H });
  items.push({ kind: "pendant", x: 0.5 * W, y: 0.5 * H, r: tr * 2.2 });

  // Chairs ring the table (one per capacity slot), backs outward.
  const ring = tr * 1.75;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    pushStool(items, seats, 0.5 * W + Math.cos(a) * ring, 0.5 * H + Math.sin(a) * ring, sr, a);
  }

  // Corner plants — sparse, so the table stays the focus.
  pushPlants(items, space, [[0.08, 0.1, "palm"], [0.92, 0.9, "bush"]]);

  return { items, standing: [], seats, board: boardGeometry(space), windows: teamWindows(space) };
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
    items.push({ kind: "table", x, y: 0.44 * H, w: dw, h: dh, round: false, tone: "oak", top: DESK_H });
    items.push({ kind: "monitor", x: cx * W, y: 0.44 * H + dh * 0.65, w: dw * 0.42, z: DESK_H });
    if (i !== 1) items.push({ kind: "deskLamp", x: x + dw * 0.86, y: 0.44 * H + dh * 0.5, z: DESK_H });
    pushStool(items, seats, cx * W, 0.37 * H, sr, -Math.PI / 2);
  }
  for (const cx of [0.43, 0.57]) {
    const x = cx * W - dw / 2;
    items.push({ kind: "table", x, y: 0.54 * H, w: dw, h: dh, round: false, tone: "oak", top: DESK_H });
    items.push({ kind: "monitor", x: cx * W, y: 0.54 * H + dh * 0.35, w: dw * 0.42, z: DESK_H });
    items.push({ kind: "mug", x: x + dw * 0.85, y: 0.54 * H + dh * 0.6, r: 0.0065 * W, z: DESK_H });
    pushStool(items, seats, cx * W, 0.72 * H, sr, Math.PI / 2);
  }
  pushPlants(items, space, [[0.92, 0.1, "palm"], [0.08, 0.9, "bush"], [0.92, 0.9, "bush"]]);

  return { items, standing: [], seats, board: boardGeometry(space), windows: teamWindows(space) };
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
  items.push({ kind: "couch", x: 0.31 * W, y: 0.71 * H, w: 0.38 * W, h: 0.13 * H, back: "top" });
  for (const sx of [0.39, 0.5, 0.61]) seats.push({ x: sx * W, y: 0.775 * H, hitR });
  items.push({ kind: "table", x: 0.39 * W, y: 0.49 * H, w: 0.22 * W, h: 0.11 * H, round: true, tone: "walnut", top: LOW_TABLE_H });
  items.push({ kind: "mug", x: 0.46 * W, y: 0.545 * H, r: 0.0065 * W, z: LOW_TABLE_H });
  items.push({ kind: "book", x: 0.51 * W, y: 0.52 * H, w: 0.035 * W, h: 0.04 * H, color: "#5d6f8a", z: LOW_TABLE_H });
  // Armchairs either side of the table, backs outward.
  items.push({ kind: "couch", x: 0.2 * W, y: 0.45 * H, w: 0.09 * W, h: 0.13 * H, back: "left" });
  seats.push({ x: 0.245 * W, y: 0.515 * H, hitR });
  items.push({ kind: "couch", x: 0.71 * W, y: 0.45 * H, w: 0.09 * W, h: 0.13 * H, back: "right" });
  seats.push({ x: 0.755 * W, y: 0.515 * H, hitR });
  items.push({ kind: "floorLamp", x: 0.2 * W, y: 0.82 * H });
  pushPlants(items, space, [[0.92, 0.12, "palm"], [0.08, 0.9, "bush"], [0.9, 0.9, "bush"]]);

  return { items, standing: [], seats, board: boardGeometry(space), windows: teamWindows(space) };
}

/** A long counter with a row of stools: dropping by for a quick word. */
function buildCafeFloor(space: SpaceDescriptor): FloorPlan {
  const W = space.width;
  const H = space.height;
  const items: FloorItem[] = [];
  const seats: Seat[] = [];
  const sr = TEAM_STOOL_R * W;

  items.push({ kind: "rug", x: 0.15 * W, y: 0.3 * H, w: 0.7 * W, h: 0.5 * H, color: RUG_CAFE });
  items.push({ kind: "table", x: 0.22 * W, y: 0.42 * H, w: 0.56 * W, h: 0.08 * H, round: false, tone: "walnut", top: COUNTER_H });
  items.push({ kind: "machine", x: 0.235 * W, y: 0.428 * H, w: 0.04 * W, h: 0.06 * H, z: COUNTER_H });
  for (const mx of [0.4, 0.5, 0.6, 0.7]) {
    items.push({ kind: "mug", x: mx * W, y: 0.455 * H, r: 0.0065 * W, z: COUNTER_H });
  }
  for (const px of [0.36, 0.5, 0.64]) items.push({ kind: "pendant", x: px * W, y: 0.46 * H, r: 0.09 * W });
  for (let i = 0; i < 5; i++) pushStool(items, seats, (0.3 + i * 0.1) * W, 0.6 * H, sr);
  pushPlants(items, space, [[0.92, 0.12, "palm"], [0.08, 0.9, "bush"], [0.92, 0.9, "palm"]]);

  return { items, standing: [], seats, board: boardGeometry(space), windows: teamWindows(space) };
}

// ---------------------------------------------------------------------------
// Depth sorting
// ---------------------------------------------------------------------------

/** Props on a surface sort just in front of what they stand on. */
const PROP_BIAS = 30;

/** The depth a standing item is painted at: its anchor, pushed a little
 *  forward for props so they sit on top of what carries them. */
function depthOf(V: View, item: FloorItem | WallSeg): number {
  switch (item.kind) {
    case "table":
    case "couch":
    case "shelf":
      return depthAt(V, item.x + item.w / 2, item.y + item.h / 2);
    case "machine":
    case "book":
      return depthAt(V, item.x + item.w / 2, item.y + item.h / 2) + PROP_BIAS;
    case "monitor":
    case "mug":
    case "deskLamp":
      return depthAt(V, item.x, item.y) + PROP_BIAS;
    case "wallSeg":
      return depthAt(V, (item.x0 + item.x1) / 2, (item.y0 + item.y1) / 2);
    case "stool":
    case "plant":
    case "pendant":
    case "floorLamp":
      return depthAt(V, item.x, item.y);
    default:
      return 0;
  }
}

/** The floor a standing item covers (for sorting people against it). */
function footprintOf(item: FloorItem | WallSeg): Footprint {
  switch (item.kind) {
    case "table":
    case "couch":
    case "shelf":
    case "machine":
    case "book":
      return { x0: item.x, y0: item.y, x1: item.x + item.w, y1: item.y + item.h };
    case "stool":
      return { x0: item.x - item.r, y0: item.y - item.r, x1: item.x + item.r, y1: item.y + item.r };
    case "plant":
      return { x0: item.x - item.r * 0.5, y0: item.y - item.r * 0.5, x1: item.x + item.r * 0.5, y1: item.y + item.r * 0.5 };
    case "monitor":
      return { x0: item.x - item.w / 2, y0: item.y - 2, x1: item.x + item.w / 2, y1: item.y + 2 };
    case "mug":
      return { x0: item.x - item.r, y0: item.y - item.r, x1: item.x + item.r, y1: item.y + item.r };
    case "wallSeg":
      return {
        x0: Math.min(item.x0, item.x1) - GLASS_T / 2,
        y0: Math.min(item.y0, item.y1) - GLASS_T / 2,
        x1: Math.max(item.x0, item.x1) + GLASS_T / 2,
        y1: Math.max(item.y0, item.y1) + GLASS_T / 2,
      };
    case "deskLamp":
    case "pendant":
    case "floorLamp":
      return { x0: item.x - 8, y0: item.y - 8, x1: item.x + 8, y1: item.y + 8 };
    default:
      return { x0: 0, y0: 0, x1: 0, y1: 0 };
  }
}

/**
 * Whether a person standing at (px, py) is painted over a footprint.
 * Anything past a box's near face (+y; and +x too when the camera is
 * yawed so that face shows) is in front of it; anything short of its far
 * faces is behind; on the footprint itself (a seat) counts as in front. A
 * scalar depth cannot say this for a long counter, whose centre may be
 * deeper than someone standing at its end.
 */
function inFrontOf(px: number, py: number, fp: Footprint, sideFaces: boolean): boolean {
  if (py >= fp.y1 - 1 || (sideFaces && px >= fp.x1 - 1)) return true;
  if (py <= fp.y0 + 1 || (sideFaces && px <= fp.x0 + 1)) return false;
  return true;
}

/** Everything that stands up (unsorted). Rooms become glass segments. */
function collectStanding(items: FloorItem[]): Standing[] {
  const out: Standing[] = [];
  const push = (item: FloorItem | WallSeg) => out.push({ depth: 0, fp: footprintOf(item), item });
  for (const it of items) {
    if (it.kind === "rug" || it.kind === "rugRound") continue;
    if (it.kind === "room") {
      for (const seg of roomSegments(it)) push(seg);
      continue;
    }
    push(it);
  }
  return out;
}

/** Order the standing items back to front for this camera (in place). */
function sortStanding(standing: Standing[], V: View): void {
  for (const s of standing) s.depth = depthOf(V, s.item);
  standing.sort((a, b) => a.depth - b.depth);
}

/** Split a room's four walls into short lengths so they sort with people. */
function roomSegments(room: Extract<FloorItem, { kind: "room" }>): WallSeg[] {
  const segs: WallSeg[] = [];
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(len / 70));
    for (let i = 0; i < n; i++) {
      const t0 = i / n;
      const t1 = (i + 1) / n;
      segs.push({
        kind: "wallSeg",
        x0: x0 + (x1 - x0) * t0,
        y0: y0 + (y1 - y0) * t0,
        x1: x0 + (x1 - x0) * t1,
        y1: y0 + (y1 - y0) * t1,
      });
    }
  };
  const { x, y, w, h } = room;
  edge(x, y, x + w, y); // far (y = top)
  edge(x, y, x, y + h); // far (x = left)
  edge(x + w, y, x + w, y + h); // near right
  edge(x, y + h, x + w, y + h); // near left
  return segs;
}

// ---------------------------------------------------------------------------
// The backdrop (shared by the live cache and the picker thumbnails)
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
  const V = fitView(canvas.width, canvas.height, space, CAM_REST);
  const plan = buildFloor(space);
  sortStanding(plan.standing, V);
  // Always daylight: a thumbnail is a floor plan, not a mood. No board: its
  // signage would swamp it.
  const light = lightAt(11);
  const pal = makePalette(light);
  paintBackdrop(ctx, V, space, plan, null, light, pal, null);
  for (const s of plan.standing) drawStanding(ctx, V, s.item, pal, light);
}

/**
 * Paint the whole static room: frame, far walls with windows and the board,
 * the floor slab, planks, rugs, the room's tiles, furniture shadows, the
 * hour's tint and light, the vignette and the grain.
 */
function paintBackdrop(
  ctx: CanvasRenderingContext2D,
  V: View,
  space: SpaceDescriptor,
  plan: FloorPlan,
  boardNotes: number | null,
  light: Light,
  pal: Palette,
  grain: CanvasPattern | null,
): void {
  const W = space.width;
  const H = space.height;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = FRAME_BG;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // The room's shadow on the frame, so it sits in the dark rather than on it.
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  poly(ctx, [
    pt(V, -WALL_T, H + 6, WALL_H),
    pt(V, -WALL_T, -WALL_T, WALL_H),
    pt(V, W + 6, -WALL_T, WALL_H),
    pt(V, W + 6, -WALL_T, -SLAB_T - 8),
    pt(V, W + 6, H + 6, -SLAB_T - 8),
    pt(V, -WALL_T, H + 6, -SLAB_T - 8),
  ]);
  ctx.fill();

  drawFarWalls(ctx, V, W, H, plan, light, pal);
  if (boardNotes !== null) drawBoard(ctx, V, plan.board, boardNotes, pal);

  // The floor slab's visible edges.
  ctx.fillStyle = pal.slab;
  poly(ctx, [pt(V, 0, H, 0), pt(V, W, H, 0), pt(V, W, H, -SLAB_T), pt(V, 0, H, -SLAB_T)]);
  ctx.fill();
  ctx.fillStyle = pal.slabLight;
  poly(ctx, [pt(V, W, 0, 0), pt(V, W, H, 0), pt(V, W, H, -SLAB_T), pt(V, W, 0, -SLAB_T)]);
  ctx.fill();

  // --- Flat things, in world space on the floor plane ---
  ctx.save();
  floorXf(ctx, V);
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
  const hair = 1 / V.scale;

  drawFloor(ctx, W, H, hair, pal);
  for (const it of plan.items) {
    if (it.kind === "rug") drawRug(ctx, it.x, it.y, it.w, it.h, it.color, hair);
    else if (it.kind === "rugRound") drawRoundRug(ctx, it.x, it.y, it.r, it.color, hair);
    else if (it.kind === "room") drawRoomFloor(ctx, it, hair, pal);
  }
  drawFurnitureShadows(ctx, plan.items, light);

  // Shadow along the foot of the far walls.
  const footL = ctx.createLinearGradient(0, 0, 14, 0);
  footL.addColorStop(0, "rgba(40,25,10,0.3)");
  footL.addColorStop(1, "rgba(40,25,10,0)");
  ctx.fillStyle = footL;
  ctx.fillRect(0, 0, 14, H);
  const footR = ctx.createLinearGradient(0, 0, 0, 14);
  footR.addColorStop(0, "rgba(40,25,10,0.3)");
  footR.addColorStop(1, "rgba(40,25,10,0)");
  ctx.fillStyle = footR;
  ctx.fillRect(0, 0, W, 14);

  // The hour's tint, then the light that falls over it: daylight through the
  // windows, and the lamps once the daylight goes.
  if (light.ambientA > 0) {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = pal.tint;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  drawSunlight(ctx, W, H, plan.windows, light);
  if (light.lamp > 0) drawLampLight(ctx, plan.items, light.lamp);
  drawVignette(ctx, W, H);
  ctx.restore();

  // Zone signage: billboards along the near edge of each area, where the
  // furniture (painted later) does not stand.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const it of plan.items) {
    if (it.kind === "rug" && it.label) {
      const p = pt(V, it.x + it.w / 2, it.y + it.h - 12);
      zoneLabel(ctx, it.label, p.x, p.y, V.scale);
    } else if (it.kind === "rugRound" && it.label) {
      const p = pt(V, it.x - it.r * 0.55, it.y - it.r * 0.55);
      zoneLabel(ctx, it.label, p.x, p.y, V.scale);
    } else if (it.kind === "room") {
      // The near corner, clear of the chair ring.
      const p = pt(V, it.x + it.w - 42, it.y + it.h - 30);
      zoneLabel(ctx, it.label, p.x, p.y, V.scale);
    }
  }

  if (grain) {
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = grain;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

/**
 * Herringbone oak. In a frame rotated 45°, the pattern is staircases of
 * axis-aligned planks: staircase k steps by (L+w, L−w) and neighbouring
 * staircases are offset by (w, −w). Each plank gets its own tone from a
 * hash, so the floor reads as wood rather than wallpaper. Floor transform
 * set by the caller.
 */
function drawFloor(ctx: CanvasRenderingContext2D, W: number, H: number, hair: number, pal: Palette): void {
  ctx.fillStyle = pal.floorBase;
  ctx.fillRect(0, 0, W, H);

  const w = 15; // plank width, world units
  const L = 60; // plank length
  const R = Math.hypot(W, H) / 2 + L;

  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-Math.PI / 4);
  ctx.lineWidth = hair;
  ctx.strokeStyle = "rgba(96,66,34,0.13)";

  const kMax = Math.ceil((R + L) / w);
  const mMax = Math.ceil(R / (L - w)) + 1;
  for (let k = -kMax; k <= kMax; k++) {
    for (let m = -mMax; m <= mMax; m++) {
      const bx = k * w + m * (L + w);
      const by = -k * w + m * (L - w);
      plank(ctx, bx, by, L, w, R, k * 31 + m * 17, pal);
      plank(ctx, bx + L, by, w, L, R, k * 31 + m * 17 + 7, pal);
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
  pal: Palette,
): void {
  // Cull planks that cannot touch the room's bounding circle.
  if (Math.hypot(x + w / 2, y + h / 2) > R + Math.max(w, h)) return;
  const t = hash01(seed);
  ctx.fillStyle = t < 0.33 ? pal.floorLight : t < 0.66 ? pal.floorBase : pal.floorDark;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  // A grain line along the plank's length.
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
  hair: number,
): void {
  ctx.save();
  roundRect(ctx, x, y, w, h, 4);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.clip();
  weave(ctx, x, y, w, h, hair);
  ctx.restore();

  ctx.save();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = shade(color, 0.86);
  roundRect(ctx, x + 7, y + 7, w - 14, h - 14, 2);
  ctx.stroke();
  ctx.lineWidth = hair;
  ctx.strokeStyle = "rgba(60,40,20,0.22)";
  roundRect(ctx, x, y, w, h, 4);
  ctx.stroke();
  // Fringe along the two short ends.
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
}

/** A round jute rug: body, concentric weave, a border ring. */
function drawRoundRug(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
  hair: number,
): void {
  ctx.save();
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

/** The meeting room's floor: slate tiles, shaded along the far glass. */
function drawRoomFloor(
  ctx: CanvasRenderingContext2D,
  it: Extract<FloorItem, { kind: "room" }>,
  hair: number,
  pal: Palette,
): void {
  const { x, y, w, h } = it;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = pal.rugMeet;
  ctx.fillRect(x, y, w, h);
  ctx.lineWidth = hair;
  ctx.strokeStyle = "rgba(40,50,60,0.16)";
  ctx.beginPath();
  for (let gx = x; gx < x + w; gx += 40) { ctx.moveTo(gx, y); ctx.lineTo(gx, y + h); }
  for (let gy = y; gy < y + h; gy += 40) { ctx.moveTo(x, gy); ctx.lineTo(x + w, gy); }
  ctx.stroke();
  const bands: Array<[number, number, number, number, number, number]> = [
    [x, y, x, y + 16, w, 16],
    [x, y, x + 16, y, 16, h],
  ];
  for (const [gx0, gy0, gx1, gy1, bw, bh] of bands) {
    const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
    g.addColorStop(0, "rgba(30,40,50,0.2)");
    g.addColorStop(1, "rgba(30,40,50,0)");
    ctx.fillStyle = g;
    ctx.fillRect(Math.min(gx0, gx1), Math.min(gy0, gy1), bw, bh);
  }
  ctx.restore();
}

/** Every piece of furniture's shadow on the floor, leaning with the light.
 *  Floor transform set by the caller. */
function drawFurnitureShadows(ctx: CanvasRenderingContext2D, items: FloorItem[], light: Light): void {
  const sh = shadowOf(light);
  ctx.save();
  ctx.fillStyle = `rgba(50,32,14,${sh.alpha})`;
  for (const it of items) {
    ctx.beginPath();
    switch (it.kind) {
      case "table":
        if (it.round) ctx.ellipse(it.x + it.w / 2 + sh.dx, it.y + it.h / 2 + sh.dy, it.w / 2, it.h / 2, 0, 0, Math.PI * 2);
        else roundRect(ctx, it.x + sh.dx, it.y + sh.dy, it.w, it.h, 4);
        break;
      case "couch":
        roundRect(ctx, it.x + sh.dx * 1.2, it.y + sh.dy * 1.2, it.w, it.h, 6);
        break;
      case "shelf":
      case "machine":
        roundRect(ctx, it.x + sh.dx * 1.4, it.y + sh.dy * 1.4, it.w, it.h, 2);
        break;
      case "stool":
        ctx.arc(it.x + sh.dx * 0.7, it.y + sh.dy * 0.7, it.r, 0, Math.PI * 2);
        break;
      case "plant":
        ctx.arc(it.x + sh.dx * 1.6, it.y + sh.dy * 1.6, it.r * 0.8, 0, Math.PI * 2);
        break;
      case "floorLamp":
        ctx.arc(it.x + sh.dx * 2, it.y + sh.dy * 2, 11, 0, Math.PI * 2);
        break;
      default:
        continue;
    }
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Daylight through the windows: a leaning trapezoid of light from each,
 * fading with distance, with the mullions' shadows striping it. Painted as
 * a few nested layers so the edges are soft without a blur filter. Floor
 * transform set by the caller.
 */
function drawSunlight(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  windows: Window[],
  light: Light,
): void {
  if (light.sun <= 0.02) return;
  const [r, g, b] = parseHex(light.sunColor);
  // A low sun reads stronger against a dim room, so its shafts get a lift.
  const strength = 0.5 * Math.sqrt(light.sun) * (1 + 0.6 * (1 - light.sun));

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (const win of windows) {
    // Pools run away from the wall: +y from the right wall, +x from the left.
    const reach = light.reach * (win.wall === "right" ? H : W);
    const lean = light.skew * reach;
    const spread = win.w * 0.12;
    for (const [grow, a] of [[spread, 0.3], [spread * 0.5, 0.3], [0, 0.4]] as const) {
      const pool = win.wall === "right"
        ? ctx.createLinearGradient(0, 0, lean * 0.3, reach)
        : ctx.createLinearGradient(0, 0, reach, lean * 0.3);
      pool.addColorStop(0, `rgba(${r},${g},${b},${a * strength})`);
      pool.addColorStop(0.55, `rgba(${r},${g},${b},${a * strength * 0.55})`);
      pool.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = pool;
      poolPath(ctx, win, grow, lean, reach);
      ctx.fill();
    }
  }
  ctx.restore();

  // Mullion shadows: the frame bars, cast down the pool.
  ctx.save();
  for (const win of windows) {
    const reach = light.reach * (win.wall === "right" ? H : W) * 0.8;
    const lean = light.skew * reach;
    const barShadow = win.wall === "right"
      ? ctx.createLinearGradient(0, 0, 0, reach)
      : ctx.createLinearGradient(0, 0, reach, 0);
    barShadow.addColorStop(0, `rgba(60,40,20,${0.16 * light.sun})`);
    barShadow.addColorStop(1, "rgba(60,40,20,0)");
    ctx.fillStyle = barShadow;
    for (const bx of mullions(win)) {
      poolPath(ctx, { ...win, at: bx - 1.5, w: 3 }, 0, lean, reach, 1);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** The trapezoid a window's light covers on the floor. */
function poolPath(
  ctx: CanvasRenderingContext2D,
  win: Window,
  grow: number,
  lean: number,
  reach: number,
  farGrow = 1.6,
): void {
  const a0 = win.at - grow;
  const a1 = win.at + win.w + grow;
  const f0 = win.at - grow * farGrow + lean;
  const f1 = win.at + win.w + grow * farGrow + lean;
  ctx.beginPath();
  if (win.wall === "right") {
    ctx.moveTo(a0, 0);
    ctx.lineTo(a1, 0);
    ctx.lineTo(f1, reach);
    ctx.lineTo(f0, reach);
  } else {
    ctx.moveTo(0, a0);
    ctx.lineTo(0, a1);
    ctx.lineTo(reach, f1);
    ctx.lineTo(reach, f0);
  }
  ctx.closePath();
}

/** Where a window's vertical frame bars stand (position along the wall). */
function mullions(win: Window): number[] {
  const n = Math.max(2, Math.round(win.w / 60));
  const out: number[] = [];
  for (let i = 1; i < n; i++) out.push(win.at + (win.w * i) / n);
  return out;
}

/** The lamps' light on the floor, screened over the tinted room. Floor
 *  transform set by the caller. */
function drawLampLight(ctx: CanvasRenderingContext2D, items: FloorItem[], lamp: number): void {
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (const it of items) {
    let x: number, y: number, r: number, a: number;
    if (it.kind === "pendant") { x = it.x; y = it.y; r = it.r; a = 0.85; }
    else if (it.kind === "deskLamp") { x = it.x - 8; y = it.y + 10; r = 50; a = 0.6; }
    else if (it.kind === "floorLamp") { x = it.x; y = it.y; r = 75; a = 0.55; }
    else if (it.kind === "monitor") { x = it.x; y = it.y + 12; r = 28; a = 0.22; }
    else continue;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const rgb = it.kind === "monitor" ? "190,215,255" : GLOW;
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
 * The two far walls in elevation: plaster, a baseboard, windows with the
 * hour's sky, and a cap along the top. The left wall is lit less than the
 * right so the corner reads.
 */
function drawFarWalls(
  ctx: CanvasRenderingContext2D,
  V: View,
  W: number,
  H: number,
  plan: FloorPlan,
  light: Light,
  pal: Palette,
): void {
  const corner = pt(V, 0, 0, 0);
  const topY = corner.y - WALL_H * V.scale;

  // Left wall (x = 0).
  const gL = ctx.createLinearGradient(0, topY, 0, pt(V, 0, H, 0).y);
  gL.addColorStop(0, pal.plasterLeft);
  gL.addColorStop(1, pal.plasterShade);
  ctx.fillStyle = gL;
  poly(ctx, [pt(V, 0, H, 0), pt(V, 0, 0, 0), pt(V, 0, 0, WALL_H), pt(V, 0, H, WALL_H)]);
  ctx.fill();
  // Right wall (y = 0).
  const gR = ctx.createLinearGradient(0, topY, 0, pt(V, W, 0, 0).y);
  gR.addColorStop(0, pal.plaster);
  gR.addColorStop(1, pal.plasterShade);
  ctx.fillStyle = gR;
  poly(ctx, [pt(V, 0, 0, 0), pt(V, W, 0, 0), pt(V, W, 0, WALL_H), pt(V, 0, 0, WALL_H)]);
  ctx.fill();

  for (const win of plan.windows) drawWindow(ctx, V, win, light, pal);

  // Baseboards.
  ctx.fillStyle = pal.baseboard;
  poly(ctx, [pt(V, 0, H, 0), pt(V, 0, 0, 0), pt(V, 0, 0, 5), pt(V, 0, H, 5)]);
  ctx.fill();
  poly(ctx, [pt(V, 0, 0, 0), pt(V, W, 0, 0), pt(V, W, 0, 5), pt(V, 0, 0, 5)]);
  ctx.fill();

  // Caps along the top of both walls, and the corner post.
  ctx.fillStyle = pal.wallCap;
  poly(ctx, [pt(V, 0, 0, WALL_H), pt(V, 0, H, WALL_H), pt(V, -WALL_T, H, WALL_H), pt(V, -WALL_T, 0, WALL_H)]);
  ctx.fill();
  poly(ctx, [pt(V, 0, 0, WALL_H), pt(V, W, 0, WALL_H), pt(V, W, -WALL_T, WALL_H), pt(V, 0, -WALL_T, WALL_H)]);
  ctx.fill();
  poly(ctx, [pt(V, 0, 0, WALL_H), pt(V, -WALL_T, 0, WALL_H), pt(V, -WALL_T, -WALL_T, WALL_H), pt(V, 0, -WALL_T, WALL_H)]);
  ctx.fill();
  // The near ends of the walls (their thickness, seen head-on).
  ctx.fillStyle = pal.plasterShade;
  poly(ctx, [pt(V, 0, H, 0), pt(V, -WALL_T, H, 0), pt(V, -WALL_T, H, WALL_H), pt(V, 0, H, WALL_H)]);
  ctx.fill();
  ctx.fillStyle = pal.plasterLeft;
  poly(ctx, [pt(V, W, 0, 0), pt(V, W, -WALL_T, 0), pt(V, W, -WALL_T, WALL_H), pt(V, W, 0, WALL_H)]);
  ctx.fill();
}

/** A tall window in a far wall: frame, the hour's sky, mullions, a sill. */
function drawWindow(
  ctx: CanvasRenderingContext2D,
  V: View,
  win: Window,
  light: Light,
  pal: Palette,
): void {
  const z0 = 34;
  const z1 = WALL_H - 22;
  // A point on the wall: `along` the wall, `out` of it into the room, up `z`.
  const P = (along: number, z: number, out = 0) =>
    win.wall === "right" ? pt(V, along, out, z) : pt(V, out, along, z);
  const a0 = win.at;
  const a1 = win.at + win.w;

  // Frame.
  ctx.fillStyle = pal.windowFrame;
  poly(ctx, [P(a0 - 3, z0 - 3), P(a1 + 3, z0 - 3), P(a1 + 3, z1 + 3), P(a0 - 3, z1 + 3)]);
  ctx.fill();

  // Glass: the sky, warming toward the horizon (the bottom) with the sun.
  const top = Math.min(P(a0, z1).y, P(a1, z1).y);
  const bottom = Math.max(P(a0, z0).y, P(a1, z0).y);
  const sky = ctx.createLinearGradient(0, top, 0, bottom);
  sky.addColorStop(0, light.sky);
  sky.addColorStop(1, mixHex(light.sky, light.sun > 0 ? light.sunColor : "#ffffff", 0.3 + 0.5 * light.sun));
  ctx.fillStyle = sky;
  poly(ctx, [P(a0, z0), P(a1, z0), P(a1, z1), P(a0, z1)]);
  ctx.fill();

  // After dark: a few stars, and a moon in the first pane of the right wall.
  const dark = clamp01((0.3 - light.sun) / 0.3);
  if (dark > 0) {
    ctx.save();
    poly(ctx, [P(a0, z0), P(a1, z0), P(a1, z1), P(a0, z1)]);
    ctx.clip();
    ctx.fillStyle = `rgba(255,250,235,${0.9 * dark})`;
    for (let i = 0; i < 14; i++) {
      const s = P(a0 + hash01(i * 13 + Math.round(win.at)) * win.w, z0 + (z1 - z0) * (0.45 + hash01(i * 7 + 3) * 0.55));
      ctx.beginPath();
      ctx.arc(s.x, s.y, (0.5 + hash01(i * 5 + 1) * 0.7) * V.scale, 0, Math.PI * 2);
      ctx.fill();
    }
    if (win.wall === "right") {
      const m = P(a0 + win.w * 0.2, z0 + (z1 - z0) * 0.7);
      ctx.fillStyle = `rgba(255,246,214,${0.95 * dark})`;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 6 * V.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = light.sky;
      ctx.beginPath();
      ctx.arc(m.x + 3 * V.scale, m.y - 2 * V.scale, 5 * V.scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Glass sheen.
  const s0 = P(a0, z1);
  const s1 = P(a1, z0);
  const sheen = ctx.createLinearGradient(s0.x, s0.y, s1.x, s1.y);
  sheen.addColorStop(0, "rgba(255,255,255,0.2)");
  sheen.addColorStop(0.5, "rgba(255,255,255,0.02)");
  sheen.addColorStop(1, "rgba(255,255,255,0.12)");
  ctx.fillStyle = sheen;
  poly(ctx, [P(a0, z0), P(a1, z0), P(a1, z1), P(a0, z1)]);
  ctx.fill();

  // Mullions (vertical) and a transom bar (along the wall).
  ctx.fillStyle = pal.windowFrame;
  for (const m of mullions(win)) {
    poly(ctx, [P(m - 1.5, z0), P(m + 1.5, z0), P(m + 1.5, z1), P(m - 1.5, z1)]);
    ctx.fill();
  }
  const zt = z0 + (z1 - z0) * 0.7;
  poly(ctx, [P(a0, zt - 1.2), P(a1, zt - 1.2), P(a1, zt + 1.2), P(a0, zt + 1.2)]);
  ctx.fill();

  // Sill: a small shelf standing out of the wall.
  ctx.fillStyle = pal.sill;
  poly(ctx, [P(a0 - 5, z0 - 3), P(a1 + 5, z0 - 3), P(a1 + 5, z0 - 3, 4), P(a0 - 5, z0 - 3, 4)]);
  ctx.fill();
  ctx.fillStyle = pal.plasterShade;
  poly(ctx, [P(a0 - 5, z0 - 3, 4), P(a1 + 5, z0 - 3, 4), P(a1 + 5, z0 - 6, 4), P(a0 - 5, z0 - 6, 4)]);
  ctx.fill();
}

/** The bulletin board hangs on the right wall above its stand point. */
function drawBoard(
  ctx: CanvasRenderingContext2D,
  V: View,
  b: BoardGeometry,
  count: number,
  pal: Palette,
): void {
  const P = (x: number, z: number) => pt(V, x, 0, z);
  ctx.save();
  // Shadow, frame and face.
  ctx.fillStyle = "rgba(40,25,10,0.3)";
  poly(ctx, [P(b.x + 3, BOARD_Z0 - 4), P(b.x + b.w + 3, BOARD_Z0 - 4), P(b.x + b.w + 3, BOARD_Z1 - 4), P(b.x + 3, BOARD_Z1 - 4)]);
  ctx.fill();
  ctx.fillStyle = pal.boardFrame;
  poly(ctx, [P(b.x - 3, BOARD_Z0 - 3), P(b.x + b.w + 3, BOARD_Z0 - 3), P(b.x + b.w + 3, BOARD_Z1 + 3), P(b.x - 3, BOARD_Z1 + 3)]);
  ctx.fill();
  ctx.fillStyle = pal.boardFace;
  poly(ctx, [P(b.x, BOARD_Z0), P(b.x + b.w, BOARD_Z0), P(b.x + b.w, BOARD_Z1), P(b.x, BOARD_Z1)]);
  ctx.fill();
  // A few pinned notes.
  const notes: Array<[number, number, string]> = [
    [0.1, 0.56, "#f6d98a"],
    [0.52, 0.6, "#cfe0f2"],
    [0.3, 0.16, "#f3c5b8"],
    [0.66, 0.14, "#dcebc6"],
  ];
  const zh = BOARD_Z1 - BOARD_Z0;
  for (const [nx, nz, c] of notes) {
    const x0 = b.x + b.w * nx;
    const z0 = BOARD_Z0 + zh * nz;
    ctx.fillStyle = mulHex(c, pal.tint);
    poly(ctx, [P(x0, z0), P(x0 + b.w * 0.24, z0), P(x0 + b.w * 0.24, z0 + zh * 0.3), P(x0, z0 + zh * 0.3)]);
    ctx.fill();
    const pin = P(x0 + b.w * 0.12, z0 + zh * 0.3 - 2);
    ctx.fillStyle = "#b54f2c";
    ctx.beginPath();
    ctx.arc(pin.x, pin.y, 1.6 * V.scale, 0, Math.PI * 2);
    ctx.fill();
  }
  // Note count, as an unread-style badge on the top-right corner.
  if (count > 0) {
    const c = P(b.x + b.w + 1, BOARD_Z1 + 1);
    const r = 8 * V.scale;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fillStyle = BOARD_BADGE;
    ctx.fill();
    ctx.lineWidth = 1.5 * V.scale;
    ctx.strokeStyle = MATERIALS.boardFace;
    ctx.stroke();
    ctx.font = `700 ${Math.max(9, Math.round(10 * V.scale))}px ${FONT_FAMILY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.fillText(String(count), c.x, c.y + 0.5);
  }
  ctx.restore();
  // Named like the zones: unlabelled it read as one more frame.
  const lp = P(b.x + b.w / 2, BOARD_Z0 - 13);
  zoneLabel(ctx, "Board", lp.x, lp.y, V.scale);
}

/** Soft darkening toward the edges of the floor, for depth. Floor transform
 *  set by the caller. */
function drawVignette(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) / 2);
  g.addColorStop(0, "rgba(60,40,20,0)");
  g.addColorStop(1, "rgba(60,40,20,0.2)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// ---------------------------------------------------------------------------
// Standing things (drawn every frame, depth-sorted with the people)
// ---------------------------------------------------------------------------

function drawStanding(
  ctx: CanvasRenderingContext2D,
  V: View,
  it: FloorItem | WallSeg,
  pal: Palette,
  light: Light,
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  switch (it.kind) {
    case "table":
      drawTable(ctx, V, it, pal);
      break;
    case "stool":
      drawStool(ctx, V, it, pal);
      break;
    case "couch":
      drawCouch(ctx, V, it, pal);
      break;
    case "plant":
      drawPlant(ctx, V, it, pal);
      break;
    case "monitor":
      drawMonitor(ctx, V, it, pal, light);
      break;
    case "mug":
      drawMug(ctx, V, it, pal);
      break;
    case "deskLamp":
      drawDeskLamp(ctx, V, it, pal, light);
      break;
    case "pendant":
      drawPendant(ctx, V, it, pal, light);
      break;
    case "floorLamp":
      drawFloorLamp(ctx, V, it, pal, light);
      break;
    case "machine":
      drawMachine(ctx, V, it, pal);
      break;
    case "shelf":
      drawShelf(ctx, V, it, pal);
      break;
    case "book":
      drawBook(ctx, V, it, pal);
      break;
    case "wallSeg":
      drawGlass(ctx, V, it, pal);
      break;
    default:
      break;
  }
}

/** An axis-aligned box: top, the +x face (right, side-lit) and the +y face
 *  (left, in shadow). Faces are omitted when their colour is null. */
function isoBox(
  ctx: CanvasRenderingContext2D,
  V: View,
  x: number,
  y: number,
  w: number,
  h: number,
  z0: number,
  z1: number,
  top: string | null,
  right: string | null,
  left: string | null,
  edge?: string,
): void {
  if (left) {
    ctx.fillStyle = left;
    poly(ctx, [pt(V, x, y + h, z1), pt(V, x + w, y + h, z1), pt(V, x + w, y + h, z0), pt(V, x, y + h, z0)]);
    ctx.fill();
  }
  if (right) {
    ctx.fillStyle = right;
    poly(ctx, [pt(V, x + w, y, z1), pt(V, x + w, y + h, z1), pt(V, x + w, y + h, z0), pt(V, x + w, y, z0)]);
    ctx.fill();
  }
  if (top) {
    ctx.fillStyle = top;
    poly(ctx, [pt(V, x, y, z1), pt(V, x + w, y, z1), pt(V, x + w, y + h, z1), pt(V, x, y + h, z1)]);
    ctx.fill();
    if (edge) {
      ctx.lineWidth = Math.max(1, V.scale * 0.8);
      ctx.strokeStyle = edge;
      ctx.stroke();
    }
  }
}

/** A vertical cylinder: the curved side (shaded) and its top disc. */
function isoCyl(
  ctx: CanvasRenderingContext2D,
  V: View,
  cx: number,
  cy: number,
  r: number,
  z0: number,
  z1: number,
  top: string | null,
  sideLight: string,
  sideDark: string,
  edge?: string,
): void {
  const base = pt(V, cx, cy, z0);
  const up = pt(V, cx, cy, z1);
  const rx = r * V.scale;
  const ry = rx * V.cam.pitch;
  const g = ctx.createLinearGradient(base.x - rx, 0, base.x + rx, 0);
  g.addColorStop(0, sideDark);
  g.addColorStop(0.55, sideLight);
  g.addColorStop(1, sideDark);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(base.x, base.y, rx, ry, 0, 0, Math.PI);
  ctx.ellipse(up.x, up.y, rx, ry, 0, Math.PI, 0, true);
  ctx.closePath();
  ctx.fill();
  if (top) {
    ctx.fillStyle = top;
    ctx.beginPath();
    ctx.ellipse(up.x, up.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    if (edge) {
      ctx.lineWidth = Math.max(1, V.scale * 0.8);
      ctx.strokeStyle = edge;
      ctx.stroke();
    }
  }
}

function drawTable(
  ctx: CanvasRenderingContext2D,
  V: View,
  it: Extract<FloorItem, { kind: "table" }>,
  pal: Palette,
): void {
  const oak = it.tone === "oak";
  const top = oak ? pal.oak : pal.walnut;
  const side = oak ? pal.oakSide : pal.walnutSide;
  const dark = oak ? pal.oakDark : pal.walnutDark;
  const edge = "rgba(60,38,18,0.35)";
  const thick = 6;
  if (it.round) {
    const r = Math.min(it.w, it.h) / 2;
    const cx = it.x + it.w / 2;
    const cy = it.y + it.h / 2;
    // Pedestal, then the top.
    isoCyl(ctx, V, cx, cy, r * 0.22, 0, it.top - thick, null, side, dark);
    isoCyl(ctx, V, cx, cy, r, it.top - thick, it.top, top, side, dark, edge);
    return;
  }
  // Legs at the corners.
  const lw = Math.min(6, it.w * 0.08);
  const legs: Array<[number, number]> = [
    [it.x + 3, it.y + 3],
    [it.x + it.w - lw - 3, it.y + 3],
    [it.x + 3, it.y + it.h - lw - 3],
    [it.x + it.w - lw - 3, it.y + it.h - lw - 3],
  ];
  for (const [lx, ly] of legs) isoBox(ctx, V, lx, ly, lw, lw, 0, it.top - thick, null, side, dark);
  isoBox(ctx, V, it.x, it.y, it.w, it.h, it.top - thick, it.top, top, side, dark, edge);
  // Grain across the top.
  ctx.save();
  poly(ctx, [pt(V, it.x, it.y, it.top), pt(V, it.x + it.w, it.y, it.top), pt(V, it.x + it.w, it.y + it.h, it.top), pt(V, it.x, it.y + it.h, it.top)]);
  ctx.clip();
  ctx.strokeStyle = "rgba(60,38,18,0.12)";
  ctx.lineWidth = Math.max(1, V.scale * 0.7);
  ctx.beginPath();
  const step = Math.max(7, it.h / 6);
  for (let gy = it.y + step * 0.6; gy < it.y + it.h; gy += step) {
    const a = pt(V, it.x, gy, it.top);
    const b = pt(V, it.x + it.w, gy + 1, it.top);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.restore();
}

/** A stool: pedestal, cushioned seat, and a chair back on `back` if any. */
function drawStool(
  ctx: CanvasRenderingContext2D,
  V: View,
  it: Extract<FloorItem, { kind: "stool" }>,
  pal: Palette,
): void {
  const { x, y, r } = it;
  const backAt =
    it.back === undefined ? null : { x: x + Math.cos(it.back) * r * 0.9, y: y + Math.sin(it.back) * r * 0.9 };
  const drawBack = () => {
    if (!backAt) return;
    const base = pt(V, backAt.x, backAt.y, SEAT_H - 2);
    const w = r * 1.5 * V.scale;
    const h = 30 * V.scale;
    roundRect(ctx, base.x - w / 2, base.y - h, w, h, 4 * V.scale);
    const g = ctx.createLinearGradient(base.x - w / 2, 0, base.x + w / 2, 0);
    g.addColorStop(0, pal.walnutSide);
    g.addColorStop(0.5, pal.walnut);
    g.addColorStop(1, pal.walnutSide);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = Math.max(1, V.scale * 0.8);
    ctx.strokeStyle = "rgba(60,38,18,0.35)";
    ctx.stroke();
  };
  // A back behind the seat is drawn first, one in front of it last.
  const backBehind = backAt !== null && backAt.x + backAt.y < x + y;
  if (backBehind) drawBack();
  isoCyl(ctx, V, x, y, r * 0.28, 0, SEAT_H - 6, null, pal.walnutSide, pal.walnutDark);
  isoCyl(ctx, V, x, y, r, SEAT_H - 6, SEAT_H, pal.cushion, pal.walnut, pal.walnutSide, "rgba(60,38,18,0.3)");
  // Cushion shading.
  const c = pt(V, x, y, SEAT_H);
  const rx = r * V.scale;
  const cg = ctx.createRadialGradient(c.x - rx * 0.25, c.y - rx * V.cam.pitch * 0.3, rx * 0.1, c.x, c.y, rx);
  cg.addColorStop(0, "rgba(255,255,255,0.25)");
  cg.addColorStop(1, "rgba(80,50,20,0.12)");
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.ellipse(c.x, c.y, rx * 0.85, rx * V.cam.pitch * 0.85, 0, 0, Math.PI * 2);
  ctx.fill();
  if (!backBehind) drawBack();
}

/** Upholstered seating: base, cushions, a backrest along `back`, two arms. */
function drawCouch(
  ctx: CanvasRenderingContext2D,
  V: View,
  it: Extract<FloorItem, { kind: "couch" }>,
  pal: Palette,
): void {
  const { x, y, w, h, back } = it;
  const band = Math.min(w, h) * 0.24;
  const baseH = 20;
  const backH = 54;
  const armH = 38;
  const u = pal.upholstery;
  const uh = pal.upholsteryHi;
  const ul = pal.upholsteryLo;
  const ud = pal.upholsteryDark;
  const edge = "rgba(40,50,60,0.25)";

  // Base.
  isoBox(ctx, V, x, y, w, h, 0, baseH, u, ul, ud, edge);
  // Backrest and arms, as raised boxes.
  const parts: Array<[number, number, number, number, number]> =
    back === "left" || back === "right"
      ? [
          [back === "left" ? x : x + w - band, y, band, h, backH],
          [x, y, w, band * 0.8, armH],
          [x, y + h - band * 0.8, w, band * 0.8, armH],
        ]
      : [
          [x, back === "top" ? y : y + h - band, w, band, backH],
          [x, y, band * 0.8, h, armH],
          [x + w - band * 0.8, y, band * 0.8, h, armH],
        ];
  // Seat cushions sit on the base between the parts.
  const inset = band * 0.8;
  const sx = x + (back === "left" ? band : inset);
  const sy = y + (back === "top" ? band : inset);
  const sw = w - (back === "left" || back === "right" ? band + inset : inset * 2);
  const shh = h - (back === "top" || back === "bottom" ? band + inset : inset * 2);
  const horizontal = sw >= shh;
  const n = horizontal ? Math.max(1, Math.round(sw / 60)) : Math.max(1, Math.round(shh / 45));
  const cushions: Array<[number, number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    cushions.push(
      horizontal
        ? [sx + (sw / n) * i + 1.5, sy + 1.5, sw / n - 3, shh - 3]
        : [sx + 1.5, sy + (shh / n) * i + 1.5, sw - 3, shh / n - 3],
    );
  }
  // Far parts, cushions, near parts — by depth.
  const all: Array<{ d: number; draw: () => void }> = [];
  for (const [px, py, pw, ph, pz] of parts) {
    all.push({ d: px + pw / 2 + py + ph / 2, draw: () => isoBox(ctx, V, px, py, pw, ph, 0, pz, uh, u, ul, edge) });
  }
  for (const [cx, cy, cw, ch] of cushions) {
    all.push({ d: cx + cw / 2 + cy + ch / 2, draw: () => isoBox(ctx, V, cx, cy, cw, ch, baseH, baseH + 9, uh, u, ul, edge) });
  }
  all.sort((a, b) => a.d - b.d);
  for (const a of all) a.draw();
}

/** A potted plant: a bush of layered leaves, or a palm of radiating fronds. */
function drawPlant(
  ctx: CanvasRenderingContext2D,
  V: View,
  it: Extract<FloorItem, { kind: "plant" }>,
  pal: Palette,
): void {
  const { x, y, r } = it;
  const potH = r * 0.9;
  isoCyl(ctx, V, x, y, r * 0.5, 0, potH, pal.soil, pal.pot, pal.potSide, "rgba(60,38,18,0.3)");
  const top = pt(V, x, y, potH);
  const s = r * V.scale;

  if (it.variant === "palm") {
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.4;
      const len = s * (1.6 + 0.4 * hash01(i * 11 + Math.round(x)));
      ctx.save();
      ctx.translate(top.x, top.y - s * 0.9);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.ellipse(len * 0.55, 0, len * 0.55, s * 0.26, 0, 0, Math.PI * 2);
      ctx.fillStyle = i % 2 ? pal.leaf : pal.leafLo;
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(len * 0.5, -s * 0.05, len * 0.42, s * 0.12, 0, 0, Math.PI * 2);
      ctx.fillStyle = i % 2 ? pal.leafHi : pal.leaf;
      ctx.fill();
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(top.x, top.y - s * 0.9, s * 0.25, 0, Math.PI * 2);
    ctx.fillStyle = pal.leafLo;
    ctx.fill();
  } else {
    const leaves: Array<[number, number, number]> = [
      [0.1, 0.1, 0.72],
      [-0.65, -0.25, 0.62],
      [0.65, -0.3, 0.62],
      [-0.25, -0.85, 0.66],
      [0.3, -0.8, 0.6],
      [0, -0.45, 0.56],
    ];
    const cy0 = top.y - s * 0.7;
    for (const [dx, dy, rr] of leaves) {
      ctx.beginPath();
      ctx.arc(top.x + dx * s, cy0 + dy * s + 3 * V.scale, rr * s, 0, Math.PI * 2);
      ctx.fillStyle = pal.leafLo;
      ctx.fill();
    }
    for (const [i, [dx, dy, rr]] of leaves.entries()) {
      const cx = top.x + dx * s;
      const cy = cy0 + dy * s;
      const g = ctx.createRadialGradient(cx - rr * s * 0.3, cy - rr * s * 0.35, rr * s * 0.1, cx, cy, rr * s);
      g.addColorStop(0, pal.leafHi);
      g.addColorStop(1, i % 2 ? pal.leaf : shade(pal.leaf, 0.92));
      ctx.beginPath();
      ctx.arc(cx, cy, rr * s, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
    }
  }
}

/** A monitor standing on a desk: a foot, and a panel facing the viewer. */
function drawMonitor(
  ctx: CanvasRenderingContext2D,
  V: View,
  it: Extract<FloorItem, { kind: "monitor" }>,
  pal: Palette,
  light: Light,
): void {
  const foot = pt(V, it.x, it.y, it.z);
  const w = it.w * V.scale;
  const h = w * 0.58;
  ctx.fillStyle = pal.metal;
  ctx.beginPath();
  ctx.ellipse(foot.x, foot.y, w * 0.18, w * 0.18 * V.cam.pitch, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(foot.x - 1.5 * V.scale, foot.y - 8 * V.scale, 3 * V.scale, 8 * V.scale);
  const top = foot.y - 8 * V.scale - h;
  roundRect(ctx, foot.x - w / 2, top, w, h, 2 * V.scale);
  ctx.fillStyle = pal.panel;
  ctx.fill();
  const on = light.lamp;
  const screen = ctx.createLinearGradient(0, top, 0, top + h);
  screen.addColorStop(0, on > 0 ? mixHex("#8fa4bd", "#cfe2ff", on) : pal.screen);
  screen.addColorStop(1, on > 0 ? mixHex("#5c6f88", "#8fb1e6", on) : shade(pal.screen, 0.8));
  ctx.fillStyle = screen;
  roundRect(ctx, foot.x - w / 2 + 2 * V.scale, top + 2 * V.scale, w - 4 * V.scale, h - 4 * V.scale, 1.5 * V.scale);
  ctx.fill();
}

/** A mug on a surface: a tiny cylinder with a latte in it. */
function drawMug(
  ctx: CanvasRenderingContext2D,
  V: View,
  it: Extract<FloorItem, { kind: "mug" }>,
  pal: Palette,
): void {
  const mh = 9;
  isoCyl(ctx, V, it.x, it.y, it.r, it.z, it.z + mh, pal.cup, pal.cup, shade(pal.cup, 0.8));
  const top = pt(V, it.x, it.y, it.z + mh);
  const rx = it.r * V.scale;
  ctx.fillStyle = pal.latte;
  ctx.beginPath();
  ctx.ellipse(top.x, top.y, rx * 0.7, rx * 0.7 * V.cam.pitch, 0, 0, Math.PI * 2);
  ctx.fill();
  // Handle.
  ctx.strokeStyle = pal.cup;
  ctx.lineWidth = Math.max(1, rx * 0.3);
  ctx.beginPath();
  ctx.arc(top.x + rx * 1.1, top.y + mh * V.scale * 0.5, rx * 0.4, -1.2, 1.2);
  ctx.stroke();
}

/** A desk lamp: a base, a leaning arm, a shade that glows when it is on. */
function drawDeskLamp(
  ctx: CanvasRenderingContext2D,
  V: View,
  it: Extract<FloorItem, { kind: "deskLamp" }>,
  pal: Palette,
  light: Light,
): void {
  const base = pt(V, it.x, it.y, it.z);
  const s = V.scale;
  ctx.fillStyle = pal.metal;
  ctx.beginPath();
  ctx.ellipse(base.x, base.y, 4 * s, 4 * s * V.cam.pitch, 0, 0, Math.PI * 2);
  ctx.fill();
  const headX = base.x - 9 * s;
  const headY = base.y - 26 * s;
  ctx.strokeStyle = pal.metal;
  ctx.lineWidth = Math.max(1, 1.6 * s);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(base.x, base.y);
  ctx.lineTo(base.x + 2 * s, base.y - 16 * s);
  ctx.lineTo(headX, headY);
  ctx.stroke();
  const on = light.lamp;
  if (on > 0) {
    const g = ctx.createRadialGradient(headX, headY + 4 * s, 0, headX, headY + 4 * s, 22 * s);
    g.addColorStop(0, `rgba(${GLOW},${0.55 * on})`);
    g.addColorStop(1, `rgba(${GLOW},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(headX, headY + 4 * s, 22 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  // Shade: a little cone, mouth down.
  ctx.fillStyle = on > 0 ? mixHex(pal.shade, "#ffd58a", on) : pal.shade;
  ctx.beginPath();
  ctx.moveTo(headX - 7 * s, headY + 4 * s);
  ctx.lineTo(headX + 7 * s, headY + 4 * s);
  ctx.lineTo(headX + 3 * s, headY - 4 * s);
  ctx.lineTo(headX - 3 * s, headY - 4 * s);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = Math.max(1, 0.8 * s);
  ctx.strokeStyle = "rgba(60,38,18,0.3)";
  ctx.stroke();
}

/** A pendant light: a cord from above and a shade over the table. */
function drawPendant(
  ctx: CanvasRenderingContext2D,
  V: View,
  it: Extract<FloorItem, { kind: "pendant" }>,
  pal: Palette,
  light: Light,
): void {
  const zShade = 118;
  const p = pt(V, it.x, it.y, zShade);
  const topP = pt(V, it.x, it.y, zShade + 70);
  const s = V.scale;
  ctx.strokeStyle = "rgba(40,30,20,0.6)";
  ctx.lineWidth = Math.max(1, 1.2 * s);
  ctx.beginPath();
  ctx.moveTo(topP.x, topP.y);
  ctx.lineTo(p.x, p.y - 10 * s);
  ctx.stroke();
  const on = light.lamp;
  if (on > 0) {
    const g = ctx.createRadialGradient(p.x, p.y + 6 * s, 0, p.x, p.y + 6 * s, 34 * s);
    g.addColorStop(0, `rgba(${GLOW},${0.6 * on})`);
    g.addColorStop(1, `rgba(${GLOW},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y + 6 * s, 34 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  // Shade: a shallow cone with its mouth toward the table.
  const shadeFill = on > 0 ? mixHex(pal.shade, "#ffd58a", on * 0.6) : pal.shade;
  const g2 = ctx.createLinearGradient(p.x - 14 * s, 0, p.x + 14 * s, 0);
  g2.addColorStop(0, shade(shadeFill, 0.8));
  g2.addColorStop(0.5, shadeFill);
  g2.addColorStop(1, shade(shadeFill, 0.85));
  ctx.fillStyle = g2;
  ctx.beginPath();
  ctx.moveTo(p.x - 14 * s, p.y + 4 * s);
  ctx.lineTo(p.x + 14 * s, p.y + 4 * s);
  ctx.lineTo(p.x + 4 * s, p.y - 10 * s);
  ctx.lineTo(p.x - 4 * s, p.y - 10 * s);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = on > 0 ? `rgba(255,240,200,${0.6 + 0.4 * on})` : "rgba(255,248,230,0.7)";
  ctx.beginPath();
  ctx.ellipse(p.x, p.y + 4 * s, 14 * s, 4.5 * s, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** A floor lamp: a tall stem and a drum shade. */
function drawFloorLamp(
  ctx: CanvasRenderingContext2D,
  V: View,
  it: Extract<FloorItem, { kind: "floorLamp" }>,
  pal: Palette,
  light: Light,
): void {
  const s = V.scale;
  const base = pt(V, it.x, it.y, 0);
  ctx.fillStyle = pal.metal;
  ctx.beginPath();
  ctx.ellipse(base.x, base.y, 9 * s, 9 * s * V.cam.pitch, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(base.x - 1.2 * s, base.y - 112 * s, 2.4 * s, 112 * s);
  const on = light.lamp;
  if (on > 0) {
    const c = pt(V, it.x, it.y, 100);
    const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 50 * s);
    g.addColorStop(0, `rgba(${GLOW},${0.5 * on})`);
    g.addColorStop(1, `rgba(${GLOW},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 50 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  const sh = on > 0 ? mixHex(pal.shade, "#ffd58a", on * 0.7) : pal.shade;
  isoCyl(ctx, V, it.x, it.y, 11, 96, 122, sh, sh, shade(sh, 0.82), "rgba(60,38,18,0.25)");
}

/** The café's espresso machine: a steel box with a warm indicator. */
function drawMachine(
  ctx: CanvasRenderingContext2D,
  V: View,
  it: Extract<FloorItem, { kind: "machine" }>,
  pal: Palette,
): void {
  const mh = 30;
  isoBox(ctx, V, it.x, it.y, it.w, it.h, it.z, it.z + mh, pal.metalHi, pal.metal, shade(pal.metal, 0.72), "rgba(0,0,0,0.25)");
  // Drip tray and indicator on the +x face.
  ctx.fillStyle = "#3b3d41";
  poly(ctx, [
    pt(V, it.x + it.w, it.y + it.h * 0.2, it.z + mh * 0.25),
    pt(V, it.x + it.w, it.y + it.h * 0.8, it.z + mh * 0.25),
    pt(V, it.x + it.w, it.y + it.h * 0.8, it.z + mh * 0.45),
    pt(V, it.x + it.w, it.y + it.h * 0.2, it.z + mh * 0.45),
  ]);
  ctx.fill();
  const dot = pt(V, it.x + it.w, it.y + it.h * 0.5, it.z + mh * 0.75);
  ctx.fillStyle = "#e8743a";
  ctx.beginPath();
  ctx.arc(dot.x, dot.y, 1.6 * V.scale, 0, Math.PI * 2);
  ctx.fill();
}

/** A bookshelf against the left wall, spines showing on its front. */
function drawShelf(
  ctx: CanvasRenderingContext2D,
  V: View,
  it: Extract<FloorItem, { kind: "shelf" }>,
  pal: Palette,
): void {
  const sh = 92;
  isoBox(ctx, V, it.x, it.y, it.w, it.h, 0, sh, pal.walnut, pal.walnutSide, pal.walnutDark, "rgba(60,38,18,0.35)");
  // Two shelves of books on the +x face.
  const colors = ["#8a5a4a", "#5d6f8a", "#b89a4a", "#6f8a5a", "#8a6a8a", "#c47a55", "#4f6b7a", "#a3553f"];
  for (const [row, z0] of [[0, 8], [1, 50]] as const) {
    let along = it.y + 3;
    let i = 0;
    while (along < it.y + it.h - 4) {
      const bw = 5 + 4 * hash01(i * 7 + row * 13);
      const bh = 26 + 10 * hash01(i * 3 + row);
      ctx.fillStyle = mulHex(colors[(i + row * 3) % colors.length], pal.tint);
      poly(ctx, [
        pt(V, it.x + it.w, along, z0),
        pt(V, it.x + it.w, along + bw, z0),
        pt(V, it.x + it.w, along + bw, z0 + bh),
        pt(V, it.x + it.w, along, z0 + bh),
      ]);
      ctx.fill();
      along += bw + 1;
      i++;
    }
  }
}

/** A book lying on a table. */
function drawBook(
  ctx: CanvasRenderingContext2D,
  V: View,
  it: Extract<FloorItem, { kind: "book" }>,
  pal: Palette,
): void {
  const c = mulHex(it.color, pal.tint);
  isoBox(ctx, V, it.x, it.y, it.w, it.h, it.z, it.z + 4, c, shade(c, 0.8), shade(c, 0.65));
  const a = pt(V, it.x + 2, it.y, it.z + 4);
  const b = pt(V, it.x + 2, it.y + it.h, it.z + 4);
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = Math.max(1, V.scale);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

/** One length of glass partition: a low wooden base, the pane, a top rail. */
function drawGlass(ctx: CanvasRenderingContext2D, V: View, seg: WallSeg, pal: Palette): void {
  const alongX = seg.y0 === seg.y1;
  const x = Math.min(seg.x0, seg.x1) - (alongX ? 0 : GLASS_T / 2);
  const y = Math.min(seg.y0, seg.y1) - (alongX ? GLASS_T / 2 : 0);
  const w = alongX ? Math.abs(seg.x1 - seg.x0) : GLASS_T;
  const h = alongX ? GLASS_T : Math.abs(seg.y1 - seg.y0);
  const rail = pal.glassRail;
  isoBox(ctx, V, x, y, w, h, 0, GLASS_BASE_H, rail, shade(rail, 0.85), shade(rail, 0.7));
  // The pane, as a translucent sheet along the segment's centre line.
  poly(ctx, [
    pt(V, seg.x0, seg.y0, GLASS_BASE_H),
    pt(V, seg.x1, seg.y1, GLASS_BASE_H),
    pt(V, seg.x1, seg.y1, GLASS_H),
    pt(V, seg.x0, seg.y0, GLASS_H),
  ]);
  ctx.fillStyle = GLASS_FILL;
  ctx.fill();
  ctx.strokeStyle = GLASS_EDGE;
  ctx.lineWidth = Math.max(1, V.scale * 0.7);
  ctx.stroke();
  isoBox(ctx, V, x, y, w, h, GLASS_H, GLASS_H + 2, rail, shade(rail, 0.85), shade(rail, 0.7));
}

/** Engraved signage: a small title-case label with a light letter-spacing. */
function zoneLabel(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, scale: number): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const fontPx = Math.max(10, Math.round(FONT_ZONE_PX * scale));
  ctx.font = `600 ${fontPx}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Manual letter-spacing for a calm, signage feel (portable across WebViews).
  const letters = text.split("");
  const sp = 1.4 * scale;
  let total = 0;
  for (const ch of letters) total += ctx.measureText(ch).width + sp;
  total -= sp;
  let x = cx - total / 2;
  for (const ch of letters) {
    const cw = ctx.measureText(ch).width;
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillText(ch, x + cw / 2, y + scale);
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

/** A closed polygon path through screen points. */
function poly(ctx: CanvasRenderingContext2D, pts: Array<{ x: number; y: number }>): void {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

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

/** The entrance swing's easing. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
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

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Lighten a color toward white by `amount` (0..1) — for the token highlight. */
function lighten(hex: string, amount: number): string {
  const [r, g, b] = parseHex(hex);
  const k = clamp01(amount);
  return toHex(r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k);
}

/** Scale a color's channels by `k` (<1 darkens) — for sides and shoulders. */
function shade(hex: string, k: number): string {
  const [r, g, b] = parseHex(hex);
  return toHex(r * k, g * k, b * k);
}

/** Blend two hex colours in RGB. */
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const k = clamp01(t);
  return toHex(lerp(ar, br, k), lerp(ag, bg, k), lerp(ab, bb, k));
}

/** Multiply two colours channel-wise (a tint over a material). */
function mulHex(a: string, tint: string): string {
  const [ar, ag, ab] = parseHex(a);
  const [tr, tg, tb] = parseHex(tint);
  return toHex((ar * tr) / 255, (ag * tg) / 255, (ab * tb) / 255);
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
