/**
 * render.ts — Canvas 2D renderer for Hiroba.
 *
 * Hiroba is a virtual office: a warm, furnished, top-down floor where presence
 * has *context*. Rather than dots floating in an empty void, people gather in
 * recognisable places — a Lounge, Focus desks, a Meeting rug, a Café counter,
 * and a central Commons. You can tell at a glance not just *who* is here but
 * *where* they are and what they're near. That spatial legibility is the whole
 * point of "ambient awareness".
 *
 * Design philosophy: presence-first and *calm*. To honour the product's core
 * value (NFR-01: idle CPU ≈ 0%) the renderer does NOT own a rAF loop. `main.ts`
 * drives a single demand-driven loop and calls `draw(now, levels)` each active
 * frame; `draw` returns whether anything is still animating so the loop knows
 * when it may sleep. The furniture is static — it never animates — so a quiet,
 * still office repaints nothing at all.
 *
 * What the renderer adds over a static scene:
 *  - A furnished floor plan (rugs, tables, couches, plants) laid out in world
 *    units, scaled to the server's space so it always fits.
 *  - Smooth interpolation of remote peers toward their last server position
 *    (the wire only ticks at ~12 Hz; we glide between snapshots).
 *  - A gently eased camera that follows self.
 *  - Spawn / leave fades so presence appears and dissolves rather than popping.
 *  - Person tokens with a soft grounding shadow, a name chip, and a mute badge.
 *  - Speaking ripples: concentric rings that radiate from a talking peer.
 *
 * All scene coordinates are computed in *physical* pixels (clientSize × dpr),
 * so we never double-apply devicePixelRatio.
 */

import type { Peer, SpaceDescriptor, Status } from "./protocol.js";

// ---------------------------------------------------------------------------
// Per-frame voice levels handed in by main.ts (decoupled from the audio engine)
// ---------------------------------------------------------------------------

export interface FrameLevels {
  /** Smoothed 0..1 speaking level for self (0 while muted). */
  selfLevel: number;
  /** Smoothed 0..1 speaking level for a remote peer (0 if silent/unknown). */
  levelOf(id: string): number;
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
// Floor plan — a furnished office, described in fractions of the world so it
// scales to whatever space the server hands us. Built once per `init`.
// ---------------------------------------------------------------------------

type FloorItem =
  | { kind: "rug"; x: number; y: number; w: number; h: number; color: string; label?: string }
  | { kind: "rugRound"; x: number; y: number; r: number; color: string; label?: string }
  | { kind: "table"; x: number; y: number; w: number; h: number; round: boolean }
  | { kind: "couch"; x: number; y: number; w: number; h: number }
  | { kind: "plant"; x: number; y: number; r: number }
  | { kind: "stool"; x: number; y: number; r: number };

// Visual constants — tuned for a calm, legible, warm office.
// Person tokens are sized in *world units* (not screen px) so they keep a
// fixed proportion to the floor at any window size. Lobby and team spaces
// share the same 800×600 footprint, so avatars render at the same scale.
//
// Text sizes below are *base* canvas px at scale=1 (1 world unit = 1 CSS px
// on a 1× display). The canvas backing store is physical pixels
// (clientSize × dpr) with no ctx.scale(), so every draw call must multiply
// by the current room `scale` — otherwise Retina/HiDPI halves the text while
// avatars (which already use PEER_RADIUS * scale) stay correct.
const PEER_RADIUS = 40; // world units
const SELF_RADIUS = 46; // world units
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';
/** Name-chip text size at scale=1; multiply by scale when setting ctx.font. */
const FONT_LABEL_PX = 12.5;
/** Zone signage text size at scale=1; multiply by scale when setting ctx.font. */
const FONT_ZONE_PX = 12;

// Warm daylight palette — a furnished room, not an empty cell.
const FRAME_BG = "#241f1a"; // outside the room (letterbox) — a dark wooden frame
const FLOOR_TOP = "#efe3cb"; // warm light wood, near
const FLOOR_BOT = "#e4d3b4"; // warm light wood, far
const PLANK = "rgba(120,92,58,0.05)";
const ROOM_EDGE = "rgba(90,70,45,0.35)";

const WOOD = "#caa478"; // tables, desks
const WOOD_HI = "#d9b98e";
const WOOD_EDGE = "rgba(90,64,36,0.30)";
const COUCH = "#aeb7bd"; // soft grey-blue upholstery
const COUCH_HI = "#c2cace";
const POT = "#b27a4f";
const LEAF = "#7fa863";
const LEAF_HI = "#93bd75";

// Zone rugs — muted, friendly, distinct.
const RUG_FOCUS = "#e7c9b2"; // clay
const RUG_MEET = "#c2d2da"; // sky
const RUG_LOUNGE = "#cdd8bf"; // sage
const RUG_CAFE = "#ecd6ad"; // straw
const RUG_COMMONS = "#e3d2c0"; // warm neutral

const ZONE_INK = "rgba(74,58,40,0.42)";

// The one accent: warm clay/coral, for the proximity ring & self.
// Matches --accent (#b54f2c) so canvas chrome tracks the AA-safe UI tokens.
const NEAR_FILL = "rgba(181,79,44,0.07)";
const NEAR_STROKE = "rgba(181,79,44,0.28)";
const SELF_HALO = "rgba(255,255,255,0.55)";

// Speaking ripples.
const RIPPLE_COUNT = 3;
const RIPPLE_PERIOD = 1.7; // seconds for one ring to travel its full reach

// Status ring colours — matched to the sidebar chrome.
const STATUS_AWAY_RING = "rgba(122, 107, 85, 0.9)"; // --ink-mute
const STATUS_DND_RING = "rgba(184, 72, 48, 0.95)"; // --danger
const STATUS_CALL_RING = "#4f7a3a"; // --sage
const STATUS_CALL_PULSE_PERIOD = 1.7;

// Easing time-constants (seconds). Smaller = snappier. Frame-rate independent
// via 1 - exp(-dt/tau), so behaviour is identical at 30 or 144 Hz.
const PEER_LERP_TAU = 0.09;
const CAMERA_TAU = 0.12;
const ANIM_TAU = 0.18; // spawn / leave fades

// A position/camera within this many world units of its target is "settled".
const SETTLE_EPS = 0.3;

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  private space: SpaceDescriptor | null = null;
  private self: RenderPeer | null = null;
  private peers = new Map<string, RenderPeer>();

  /** Furniture for the current space, in world units (built in `init`). */
  private floor: FloorItem[] = [];

  /** Eased camera centre, in world units. */
  private camX = 0;
  private camY = 0;

  /** Click-to-walk destination marker, in world units (null = none). */
  private walkTarget: { x: number; y: number } | null = null;

  /** Peer id under the pointer when it can be paged (drives a hover ring). */
  private pageHoverId: string | null = null;

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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context not available");
    this.ctx = ctx;

    window.addEventListener("resize", () => this._resize());
    // The canvas's layout can settle *after* construction with no window
    // resize (first launch: stylesheet application / WebView attach races),
    // so observe the element itself rather than trusting the one-shot below.
    new ResizeObserver(() => this._resize()).observe(canvas);
    this._watchDpr();
    this._resize();
    this.paintIdle(); // dark screen until a session initializes
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
    // Start at the camera's resting point (room centre at fit-to-room zoom)
    // so joining doesn't open with a pan.
    this.camX = space.width / 2;
    this.camY = space.height / 2;
    this.lastDraw = 0;
    this.peers.clear();
    this.floor = buildFloor(space);
  }

  /** Return to the un-initialized state and paint the idle screen. */
  reset(): void {
    this.space = null;
    this.self = null;
    this.peers.clear();
    this.floor = [];
    this.walkTarget = null;
    this.avatarImages.clear();
    this.paintIdle();
  }

  /**
   * Map a pointer event's client coordinates to world units using the current
   * camera, for click-to-walk. Returns null before a session initializes.
   */
  screenToWorld(clientX: number, clientY: number): { x: number; y: number } | null {
    const { canvas, space } = this;
    if (!space) return null;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const px = (clientX - rect.left) * dpr;
    const py = (clientY - rect.top) * dpr;
    const scale = Math.min(canvas.width / space.width, canvas.height / space.height);
    const ox = canvas.width / 2 - this.camX * scale;
    const oy = canvas.height / 2 - this.camY * scale;
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

  /** Highlight a pageable peer under the pointer, or clear the hover ring. */
  setPageHover(peerId: string | null): void {
    if (this.pageHoverId === peerId) return;
    this.pageHoverId = peerId;
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
  setSelfStatus(status: Status): void {
    if (this.self) this.self.status = status;
  }

  /** Update org-wide status for a remote peer in the current space. */
  updatePeerStatus(id: string, status: Status): void {
    const p = this.peers.get(id);
    if (p) p.status = status;
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

  // -------------------------------------------------------------------------
  // Draw — called by main.ts each active frame
  // -------------------------------------------------------------------------

  /**
   * Render one frame. Returns `true` if anything is still animating (peers
   * interpolating, camera easing, spawn/leave fades, or live speech), telling
   * the loop it must keep going. Returns `false` once the scene is fully at
   * rest so the loop may sleep.
   */
  draw(now: number, levels: FrameLevels): boolean {
    const { ctx, canvas, space, self } = this;
    if (!space || !self) {
      this.paintIdle();
      return false;
    }

    // Frame-rate-independent dt. Clamp so a wake from sleep doesn't teleport.
    const dt = this.lastDraw === 0 ? 0 : Math.min(0.1, (now - this.lastDraw) / 1000);
    this.lastDraw = now;

    let animating = false;

    const vw = canvas.width;
    const vh = canvas.height;
    const scale = Math.min(vw / space.width, vh / space.height);

    // --- Camera: ease toward self, clamped so the room never leaves the
    // viewport. At the current fit-to-room zoom the clamp pins the room
    // centred (walking to an edge must not push half the floor off-screen);
    // the easing only matters if a closer zoom is ever introduced. ---
    const halfW = vw / (2 * scale);
    const halfH = vh / (2 * scale);
    const tx =
      space.width <= halfW * 2 ? space.width / 2 : clamp(self.x, halfW, space.width - halfW);
    const ty =
      space.height <= halfH * 2 ? space.height / 2 : clamp(self.y, halfH, space.height - halfH);
    const camK = ease(dt, CAMERA_TAU);
    this.camX += (tx - this.camX) * camK;
    this.camY += (ty - this.camY) * camK;
    if (Math.hypot(tx - this.camX, ty - this.camY) > SETTLE_EPS) animating = true;

    // World origin in screen space so the camera centre sits at viewport centre.
    const ox = vw / 2 - this.camX * scale;
    const oy = vh / 2 - this.camY * scale;

    // --- Backdrop (wooden frame + the room) ---
    ctx.fillStyle = FRAME_BG;
    ctx.fillRect(0, 0, vw, vh);

    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, space.width * scale, space.height * scale);
    ctx.clip();

    this._drawFloorBoards(ox, oy, scale, space);
    this._drawFurniture(ox, oy, scale);
    this._drawNearRings(ox, oy, scale, self, space.nearRadius);

    // Click-to-walk destination: a calm pulsing ring until we arrive.
    if (this.walkTarget) {
      this._drawWalkMarker(now, ox + this.walkTarget.x * scale, oy + this.walkTarget.y * scale);
      animating = true;
    }

    // --- Peers: advance animations, interpolate, draw (and reap leavers) ---
    const lerpK = ease(dt, PEER_LERP_TAU);
    const animK = ease(dt, ANIM_TAU);
    const reap: string[] = [];

    for (const p of this.peers.values()) {
      // Interpolate toward the latest server position.
      p.x += (p.targetX - p.x) * lerpK;
      p.y += (p.targetY - p.y) * lerpK;
      if (Math.hypot(p.targetX - p.x, p.targetY - p.y) > SETTLE_EPS) animating = true;

      // Spawn / leave fades.
      if (p.leaving) {
        p.leave += (0 - p.leave) * animK;
        if (p.leave < 0.02) { reap.push(p.id); continue; }
        animating = true;
      } else if (p.spawn < 0.999) {
        p.spawn += (1 - p.spawn) * animK;
        animating = true;
      }

      const level = levels.levelOf(p.id);
      if (level > 0) animating = true;
      if (p.status === "in_call") animating = true;
      this._drawPeer(now, ox, oy, scale, p, false, level);
    }
    for (const id of reap) this.peers.delete(id);

    // Self on top so it's never occluded.
    if (levels.selfLevel > 0) animating = true;
    if (self.status === "in_call") animating = true;
    this._drawPeer(now, ox, oy, scale, self, true, levels.selfLevel);

    this._drawVignette(ox, oy, scale, space);

    // Room edge (drawn last so it frames everything).
    ctx.lineWidth = 1;
    ctx.strokeStyle = ROOM_EDGE;
    ctx.strokeRect(ox + 0.5, oy + 0.5, space.width * scale - 1, space.height * scale - 1);

    ctx.restore();

    return animating;
  }

  /** Paint the "not in a space" screen. Cheap; called when idle. */
  paintIdle(): void {
    const { ctx, canvas } = this;
    ctx.fillStyle = FRAME_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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
  // Floor & furniture
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

  /** Warm wood floor with faint plank seams. */
  private _drawFloorBoards(ox: number, oy: number, scale: number, space: SpaceDescriptor): void {
    const ctx = this.ctx;
    const w = space.width * scale;
    const h = space.height * scale;

    const g = ctx.createLinearGradient(0, oy, 0, oy + h);
    g.addColorStop(0, FLOOR_TOP);
    g.addColorStop(1, FLOOR_BOT);
    ctx.fillStyle = g;
    ctx.fillRect(ox, oy, w, h);

    // Horizontal plank seams every ~110 world units.
    const seam = 110 * scale;
    ctx.strokeStyle = PLANK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = oy + seam; y < oy + h; y += seam) {
      const yy = Math.round(y) + 0.5;
      ctx.moveTo(ox, yy);
      ctx.lineTo(ox + w, yy);
    }
    ctx.stroke();
  }

  private _drawFurniture(ox: number, oy: number, scale: number): void {
    const ctx = this.ctx;
    const X = (wx: number) => ox + wx * scale;
    const Y = (wy: number) => oy + wy * scale;

    for (const it of this.floor) {
      switch (it.kind) {
        case "rug": {
          const x = X(it.x), y = Y(it.y), w = it.w * scale, h = it.h * scale;
          roundRect(ctx, x, y, w, h, 14 * scale + 4);
          ctx.fillStyle = it.color;
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = "rgba(90,70,45,0.12)";
          ctx.stroke();
          if (it.label) this._zoneLabel(it.label, x + w / 2, y + 13 * scale, scale);
          break;
        }
        case "rugRound": {
          const x = X(it.x), y = Y(it.y), r = it.r * scale;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = it.color;
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = "rgba(90,70,45,0.12)";
          ctx.stroke();
          if (it.label) this._zoneLabel(it.label, x, y - r + 13 * scale, scale);
          break;
        }
        case "table": {
          this._softShadow(X(it.x), Y(it.y), it.w * scale, it.h * scale, it.round);
          const x = X(it.x), y = Y(it.y), w = it.w * scale, h = it.h * scale;
          const rad = it.round ? Math.min(w, h) / 2 : 7;
          roundRect(ctx, x, y, w, h, rad);
          const tg = ctx.createLinearGradient(0, y, 0, y + h);
          tg.addColorStop(0, WOOD_HI);
          tg.addColorStop(1, WOOD);
          ctx.fillStyle = tg;
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = WOOD_EDGE;
          ctx.stroke();
          break;
        }
        case "couch": {
          this._softShadow(X(it.x), Y(it.y), it.w * scale, it.h * scale, false);
          const x = X(it.x), y = Y(it.y), w = it.w * scale, h = it.h * scale;
          roundRect(ctx, x, y, w, h, 9);
          ctx.fillStyle = COUCH;
          ctx.fill();
          // seat cushion highlight
          roundRect(ctx, x + w * 0.16, y + h * 0.16, w * 0.68, h * 0.68, 7);
          ctx.fillStyle = COUCH_HI;
          ctx.fill();
          break;
        }
        case "stool": {
          const x = X(it.x), y = Y(it.y), r = it.r * scale;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = WOOD;
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = WOOD_EDGE;
          ctx.stroke();
          break;
        }
        case "plant": {
          const x = X(it.x), y = Y(it.y), r = it.r * scale;
          // pot
          ctx.beginPath();
          ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
          ctx.fillStyle = POT;
          ctx.fill();
          // foliage — a little cluster of leaves
          for (const [dx, dy, rr] of [
            [0, -0.5, 0.85], [-0.55, -0.1, 0.6], [0.55, -0.1, 0.6], [0, 0.15, 0.7],
          ] as const) {
            ctx.beginPath();
            ctx.arc(x + dx * r, y + dy * r, rr * r, 0, Math.PI * 2);
            ctx.fillStyle = rr > 0.7 ? LEAF_HI : LEAF;
            ctx.fill();
          }
          break;
        }
      }
    }
  }

  /** A soft drop shadow under a rectangular furniture piece. */
  private _softShadow(x: number, y: number, w: number, h: number, round: boolean): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = "rgba(70,50,28,0.16)";
    const off = 3;
    const rad = round ? Math.min(w, h) / 2 : 7;
    roundRect(ctx, x + off, y + off + 2, w, h, rad);
    ctx.fill();
    ctx.restore();
  }

  private _zoneLabel(text: string, cx: number, y: number, scale: number): void {
    const ctx = this.ctx;
    ctx.save();
    // Scale-proportional like avatar initials — canvas is physical px, no ctx.scale().
    const fontPx = Math.max(10, Math.round(FONT_ZONE_PX * scale));
    ctx.font = `700 ${fontPx}px ${FONT_FAMILY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = ZONE_INK;
    // Manual letter-spacing for a calm, signage feel (portable across WebViews).
    const letters = text.toUpperCase().split("");
    const sp = 2.5 * scale;
    let total = 0;
    for (const ch of letters) total += ctx.measureText(ch).width + sp;
    total -= sp;
    let x = cx - total / 2;
    for (const ch of letters) {
      const cw = ctx.measureText(ch).width;
      ctx.fillText(ch, x + cw / 2, y);
      x += cw + sp;
    }
    ctx.restore();
  }

  /** A soft radial darkening toward the edges, for a sense of depth/calm. */
  private _drawVignette(ox: number, oy: number, scale: number, space: SpaceDescriptor): void {
    const ctx = this.ctx;
    const cx = ox + (space.width * scale) / 2;
    const cy = oy + (space.height * scale) / 2;
    const r = Math.hypot(space.width * scale, space.height * scale) / 2;
    const g = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
    g.addColorStop(0, "rgba(60,40,20,0)");
    g.addColorStop(1, "rgba(60,40,20,0.16)");
    ctx.fillStyle = g;
    ctx.fillRect(ox, oy, space.width * scale, space.height * scale);
  }

  /** The click-to-walk destination: a soft accent dot with a breathing ring. */
  private _drawWalkMarker(now: number, sx: number, sy: number): void {
    const ctx = this.ctx;
    const phase = (now / 1000) % 1; // one breath per second
    const ringR = 7 + 5 * phase;
    ctx.save();
    // centre dot
    ctx.beginPath();
    ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(181,79,44,0.85)";
    ctx.fill();
    // expanding, fading ring
    ctx.beginPath();
    ctx.arc(sx, sy, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(181,79,44,${0.55 * (1 - phase)})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  /** Concentric "talking range" rings around self — calm ripples at rest. */
  private _drawNearRings(
    ox: number,
    oy: number,
    scale: number,
    self: RenderPeer,
    nearRadius: number,
  ): void {
    const ctx = this.ctx;
    const sx = ox + self.x * scale;
    const sy = oy + self.y * scale;
    const sr = nearRadius * scale;

    ctx.save();
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.fillStyle = NEAR_FILL;
    ctx.fill();
    ctx.strokeStyle = NEAR_STROKE;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([3, 8]);
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
  ): void {
    const ctx = this.ctx;
    const sx = ox + peer.x * scale;
    const sy = oy + peer.y * scale;

    // Spawn/leave drive a combined appearance factor (alpha + scale).
    const appear = isSelf ? 1 : peer.leaving ? peer.leave : easeOutBack(peer.spawn);
    let alpha = isSelf ? 1 : clamp01(peer.leaving ? peer.leave : peer.spawn);
    if (peer.status === "away") alpha *= 0.62;
    // World-unit radius projected through the room scale, so the token keeps
    // its proportion to the floor at any window size.
    const r = (isSelf ? SELF_RADIUS : PEER_RADIUS) * scale * (0.6 + 0.4 * appear);

    ctx.save();
    ctx.globalAlpha = alpha;

    // --- Speaking ripples: concentric rings radiating outward over time ---
    if (level > 0) {
      this._drawRipples(now, sx, sy, r, peer.color, alpha, level);
    }

    // --- Grounding shadow so the token sits on the floor ---
    const sh = ctx.createRadialGradient(sx, sy + r * 0.55, r * 0.2, sx, sy + r * 0.62, r * 1.5);
    sh.addColorStop(0, "rgba(70,50,28,0.32)");
    sh.addColorStop(1, "rgba(70,50,28,0)");
    ctx.fillStyle = sh;
    ctx.beginPath();
    ctx.ellipse(sx, sy + r * 0.66, r * 1.35, r * 0.82, 0, 0, Math.PI * 2);
    ctx.fill();

    // --- Self halo ring (only while fully present) ---
    if (isSelf && peer.status === "active") {
      ctx.beginPath();
      ctx.arc(sx, sy, r + Math.max(4, r * 0.2), 0, Math.PI * 2);
      ctx.fillStyle = SELF_HALO;
      ctx.fill();
    }

    // --- Disc, with a soft top highlight so it reads as a rounded token ---
    const body = ctx.createRadialGradient(sx, sy - r * 0.4, r * 0.1, sx, sy, r);
    body.addColorStop(0, lighten(peer.color, 0.24));
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
      ctx.drawImage(photo, sx - r, sy - r, r * 2, r * 2);
      ctx.restore();
    } else {
      ctx.fillStyle = pickInk(peer.color);
      ctx.font = `600 ${Math.max(13, Math.round(r * 0.72))}px ${FONT_FAMILY}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText((peer.name[0] ?? "?").toUpperCase(), sx, sy + 1);
    }

    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(isSelf ? 2.5 : 1.5, r * (isSelf ? 0.1 : 0.07));
    ctx.strokeStyle = isSelf ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.7)";
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

    // --- Name chip below the disc ---
    this._drawNameChip(peer.name, sx, sy + r + 7 * scale, isSelf, scale);

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

  /** Concentric rings radiating outward in time, scaled by voice level. */
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
    // Reach is proportional to the token so ripples keep their feel at any
    // room scale (~1.6r at a whisper, ~3.8r at full level).
    const reach = r * (1.6 + 2.2 * clamp01(level));
    const t = (now / 1000) / RIPPLE_PERIOD;

    ctx.save();
    ctx.lineWidth = 2;
    for (let i = 0; i < RIPPLE_COUNT; i++) {
      const phase = (t + i / RIPPLE_COUNT) % 1;
      const rr = r + phase * (reach - r);
      const fade = (1 - phase) * (0.22 + 0.5 * level);
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
    // Slash.
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
    ctx.font = `${fontPx}px ${FONT_FAMILY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const w = ctx.measureText(name).width;
    const padX = 8 * scale;
    const padY = 3.5 * scale;
    const chipW = w + padX * 2;
    const chipH = 19 * scale;
    const x = cx - chipW / 2;

    roundRect(ctx, x, top, chipW, chipH, 7 * scale);
    ctx.fillStyle = isSelf ? "rgba(255,252,246,0.96)" : "rgba(255,252,246,0.86)";
    ctx.fill();
    ctx.lineWidth = Math.max(1, scale);
    ctx.strokeStyle = isSelf ? "rgba(181,79,44,0.6)" : "rgba(90,70,45,0.14)";
    ctx.stroke();

    ctx.fillStyle = "#4a3a28";
    ctx.fillText(name, cx, top + padY);
  }
}

// ---------------------------------------------------------------------------
// Floor-plan builder
// ---------------------------------------------------------------------------

/**
 * Lay out a furnished office in world units, as fractions of the space so it
 * fits any server geometry. Five zones — Focus, Meeting, Lounge, Café, and a
 * central Commons — give presence a sense of place.
 */
function buildFloor(space: SpaceDescriptor): FloorItem[] {
  const W = space.width;
  const H = space.height;
  const items: FloorItem[] = [];

  // --- Focus desks (top-left): a row of desks with stools ---
  items.push({ kind: "rug", x: 0.05 * W, y: 0.06 * H, w: 0.36 * W, h: 0.32 * H, color: RUG_FOCUS, label: "Focus" });
  for (let i = 0; i < 3; i++) {
    const dx = (0.10 + i * 0.10) * W;
    items.push({ kind: "table", x: dx, y: 0.15 * H, w: 0.075 * W, h: 0.06 * H, round: false });
    items.push({ kind: "stool", x: dx + 0.037 * W, y: 0.24 * H, r: 0.016 * W });
  }
  items.push({ kind: "plant", x: 0.07 * W, y: 0.33 * H, r: 0.03 * W });

  // --- Meeting (top-right): a round table ringed by stools ---
  items.push({ kind: "rug", x: 0.58 * W, y: 0.06 * H, w: 0.37 * W, h: 0.32 * H, color: RUG_MEET, label: "Meeting" });
  const mcx = 0.765 * W, mcy = 0.22 * H, mtr = 0.075 * W;
  items.push({ kind: "table", x: mcx - mtr, y: mcy - mtr, w: mtr * 2, h: mtr * 2, round: true });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    items.push({ kind: "stool", x: mcx + Math.cos(a) * mtr * 1.7, y: mcy + Math.sin(a) * mtr * 1.7, r: 0.016 * W });
  }

  // --- Lounge (bottom-left): couch + coffee table + plant ---
  items.push({ kind: "rug", x: 0.05 * W, y: 0.6 * H, w: 0.37 * W, h: 0.33 * H, color: RUG_LOUNGE, label: "Lounge" });
  items.push({ kind: "couch", x: 0.08 * W, y: 0.68 * H, w: 0.085 * W, h: 0.18 * H });
  items.push({ kind: "table", x: 0.20 * W, y: 0.72 * H, w: 0.10 * W, h: 0.09 * H, round: true });
  items.push({ kind: "plant", x: 0.37 * W, y: 0.66 * H, r: 0.03 * W });

  // --- Café (bottom-right): counter + stools + plant ---
  items.push({ kind: "rug", x: 0.58 * W, y: 0.6 * H, w: 0.37 * W, h: 0.33 * H, color: RUG_CAFE, label: "Café" });
  items.push({ kind: "table", x: 0.62 * W, y: 0.66 * H, w: 0.29 * W, h: 0.055 * H, round: false });
  for (let i = 0; i < 4; i++) {
    items.push({ kind: "stool", x: (0.66 + i * 0.07) * W, y: 0.745 * H, r: 0.016 * W });
  }
  items.push({ kind: "plant", x: 0.9 * W, y: 0.86 * H, r: 0.03 * W });

  // --- Commons (centre): the open gathering circle, with a low table ---
  items.push({ kind: "rugRound", x: 0.5 * W, y: 0.5 * H, r: 0.12 * Math.min(W, H), color: RUG_COMMONS, label: "Commons" });
  items.push({ kind: "table", x: 0.47 * W, y: 0.47 * H, w: 0.06 * W, h: 0.06 * H, round: true });

  return items;
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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Gentle overshoot for a lively-but-calm spawn. */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = clamp01(t) - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
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
