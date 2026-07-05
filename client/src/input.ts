/**
 * input.ts — Keyboard and click-to-walk movement for the Hiroba client.
 *
 * Movement model:
 *  - WASD and Arrow keys set velocity in x/y.
 *  - A click (or tap) on the floor sets a walk target; we walk toward it at
 *    the same speed and stop on arrival. Keyboard input always wins: the
 *    first movement key cancels the target.
 *  - Each rAF tick we integrate velocity × dt and clamp to world bounds.
 *  - We throttle `move` sends to ~tickHz (from the welcome message) and only
 *    send when the position has actually changed since the last send.
 *
 * This separation of concerns means:
 *  - render.ts calls setSelfPosition on the renderer every frame for smooth
 *    local movement (no network delay).
 *  - main.ts passes a `onMove` callback here that we invoke when we should
 *    actually send a move message to the server.
 */

import type { SpaceDescriptor } from "./protocol.js";

// Movement speed in world-units per second.
// At 150 nearRadius the world is 800 wide, so ~200 u/s crosses the world in 4s.
const MOVE_SPEED = 200;

// How many pixels of slop to ignore in position comparison when deciding
// whether to send a move message (avoids floating-point chatter).
const SEND_EPSILON = 0.5;

export class InputHandler {
  private space: SpaceDescriptor | null = null;

  // Current position in world units.
  private x = 0;
  private y = 0;

  // Position sent to the server in the last `move` message.
  private sentX = -1;
  private sentY = -1;

  // Active keys (held down).
  private keys = new Set<string>();

  // Click-to-walk destination in world units (null when not walking).
  private target: { x: number; y: number } | null = null;

  // Time of the last frame, used to compute dt.
  private lastTime = 0;

  // Time of the last sent `move` message.
  private lastSendTime = 0;

  // Minimum interval between sends in ms, derived from tickHz.
  private sendIntervalMs = 1000 / 12; // default 12 Hz

  // Callbacks provided by main.ts.
  private onPosition: ((x: number, y: number) => void) | null = null;
  private onMove: ((x: number, y: number) => void) | null = null;
  /** Fired on the first keydown of a press so the loop can wake from idle. */
  private onActivity: (() => void) | null = null;

  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundKeyUp: (e: KeyboardEvent) => void;

  constructor() {
    this.boundKeyDown = (e) => this._onKeyDown(e);
    this.boundKeyUp = (e) => this._onKeyUp(e);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Initialize the handler after receiving `welcome`.
   *
   * @param space   SpaceDescriptor config (used for world bounds and tickHz).
   * @param startX  Spawn X (from welcome.you.x).
   * @param startY  Spawn Y (from welcome.you.y).
   * @param onPosition  Called every frame with the current position so the
   *                    renderer can move the self avatar smoothly.
   * @param onMove  Called when a `move` message should be sent to the server.
   */
  init(
    space: SpaceDescriptor,
    startX: number,
    startY: number,
    onPosition: (x: number, y: number) => void,
    onMove: (x: number, y: number) => void,
    onActivity: () => void,
  ): void {
    this.space = space;
    this.x = startX;
    this.y = startY;
    this.sentX = startX;
    this.sentY = startY;
    this.onPosition = onPosition;
    this.onMove = onMove;
    this.onActivity = onActivity;
    this.sendIntervalMs = 1000 / space.tickHz;

    window.addEventListener("keydown", this.boundKeyDown);
    window.addEventListener("keyup", this.boundKeyUp);
  }

  /**
   * Re-target to a new space after `enter_space`: swap world bounds + tick
   * rate and snap to the spawn position. Keeps the existing key listeners, so
   * (unlike re-running `init`) it does not double-bind.
   */
  setSpace(space: SpaceDescriptor, startX: number, startY: number): void {
    this.space = space;
    this.x = startX;
    this.y = startY;
    this.sentX = startX;
    this.sentY = startY;
    this.target = null; // a destination in the old space is meaningless here
    this.sendIntervalMs = 1000 / space.tickHz;
    this.onPosition?.(this.x, this.y);
  }

  /**
   * Set (or drag-update) the click-to-walk destination, clamped to world
   * bounds. The avatar walks there at MOVE_SPEED until arrival, a movement
   * key press, or a space switch. Fires `onActivity` so the loop wakes.
   */
  setMoveTarget(wx: number, wy: number): void {
    if (!this.space) return;
    // Waking from an idle loop: reset the dt baseline so the first step
    // doesn't integrate the whole time we were asleep.
    if (this.keys.size === 0 && !this.target) this.lastTime = 0;
    this.target = {
      x: clamp(wx, 0, this.space.width),
      y: clamp(wy, 0, this.space.height),
    };
    this.onActivity?.();
  }

  /** The active click-to-walk destination, or null (drives the floor marker). */
  get moveTarget(): { x: number; y: number } | null {
    return this.target;
  }

  /**
   * Call every active frame with the current timestamp. Returns `true` while
   * a movement key is held, so the demand-driven loop knows to keep running
   * (even when pressing into a wall, where the position stops changing).
   */
  tick(now: number): boolean {
    if (!this.space) return false;

    const dt = this.lastTime === 0 ? 0 : (now - this.lastTime) / 1000;
    this.lastTime = now;

    // Compute velocity from held keys.
    let vx = 0;
    let vy = 0;
    if (this.keys.has("ArrowLeft") || this.keys.has("KeyA")) vx -= 1;
    if (this.keys.has("ArrowRight") || this.keys.has("KeyD")) vx += 1;
    if (this.keys.has("ArrowUp") || this.keys.has("KeyW")) vy -= 1;
    if (this.keys.has("ArrowDown") || this.keys.has("KeyS")) vy += 1;

    // Normalize diagonal movement so speed is consistent.
    if (vx !== 0 && vy !== 0) {
      const len = Math.SQRT2;
      vx /= len;
      vy /= len;
    }

    if (vx !== 0 || vy !== 0) {
      // Keyboard wins: steering by key cancels any click-to-walk destination.
      this.target = null;
      this.x = clamp(this.x + vx * MOVE_SPEED * dt, 0, this.space.width);
      this.y = clamp(this.y + vy * MOVE_SPEED * dt, 0, this.space.height);
    } else if (this.target) {
      // Walk toward the click destination; snap and stop on arrival.
      const dx = this.target.x - this.x;
      const dy = this.target.y - this.y;
      const dist = Math.hypot(dx, dy);
      const step = MOVE_SPEED * dt;
      if (dist <= step) {
        this.x = this.target.x;
        this.y = this.target.y;
        this.target = null;
      } else {
        this.x = clamp(this.x + (dx / dist) * step, 0, this.space.width);
        this.y = clamp(this.y + (dy / dist) * step, 0, this.space.height);
      }
    }

    // Always push position to the renderer so the avatar is smooth.
    this.onPosition?.(this.x, this.y);

    const moving = vx !== 0 || vy !== 0 || this.target !== null;

    // Throttle server sends to tickHz and only when position changed. On the
    // frame movement stops we flush the final position immediately (ignoring
    // the throttle) so remote peers settle on our exact resting spot.
    const dx = Math.abs(this.x - this.sentX);
    const dy = Math.abs(this.y - this.sentY);
    if (
      (dx > SEND_EPSILON || dy > SEND_EPSILON) &&
      (!moving || now - this.lastSendTime >= this.sendIntervalMs)
    ) {
      this.sentX = this.x;
      this.sentY = this.y;
      this.lastSendTime = now;
      this.onMove?.(this.x, this.y);
    }

    // Stay awake while any movement key is held (intent to move), even when the
    // position is pinned at a wall and stops changing.
    return moving;
  }

  /** Current world-space position (used by audio.ts for gain calculation). */
  get position(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  /** Remove event listeners (call on leave). */
  destroy(): void {
    window.removeEventListener("keydown", this.boundKeyDown);
    window.removeEventListener("keyup", this.boundKeyUp);
    this.keys.clear();
    this.target = null;
    this.space = null;
    this.lastTime = 0;
  }

  // -------------------------------------------------------------------------
  // Key handlers
  // -------------------------------------------------------------------------

  private _onKeyDown(e: KeyboardEvent): void {
    // Ignore typing contexts (visible inputs, chat, etc.).
    if (isTypingTarget(e.target)) return;
    if (isMovementKey(e.code)) {
      e.preventDefault(); // prevent page scrolling with arrow keys
      const wasIdle = this.keys.size === 0;
      this.keys.add(e.code);
      // Reset the dt baseline and wake the loop on the first key of a press so
      // movement starts cleanly from an idle (slept) state.
      if (wasIdle) {
        this.lastTime = 0;
        this.onActivity?.();
      }
    }
  }

  private _onKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function isMovementKey(code: string): boolean {
  return (
    code === "ArrowLeft" ||
    code === "ArrowRight" ||
    code === "ArrowUp" ||
    code === "ArrowDown" ||
    code === "KeyW" ||
    code === "KeyA" ||
    code === "KeyS" ||
    code === "KeyD"
  );
}

/** Input types where the keyboard belongs to the field (free text, or values
 *  stepped with arrow keys). A whitelist so an unlisted or future type fails
 *  safe: shortcuts keep working. */
const TYPING_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
  "range",
]);

/** True when the event target is a visible, editable field — shortcuts should
 *  yield so typing isn't hijacked. Inputs inside a `[hidden]` subtree (e.g. the
 *  join form after `showSpace`) are ignored so M / WASD still work. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest("[hidden]")) return false;
  if (target instanceof HTMLInputElement) {
    return TYPING_INPUT_TYPES.has(target.type) && !target.readOnly && !target.disabled;
  }
  if (target instanceof HTMLTextAreaElement) {
    return !target.readOnly && !target.disabled;
  }
  if (target instanceof HTMLSelectElement) return !target.disabled;
  return target.isContentEditable;
}
