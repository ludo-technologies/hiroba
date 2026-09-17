/**
 * The bulletin board: where it hangs in a space, and when walking up to it
 * opens it. Pure geometry — the renderer draws it, main.ts reacts to it.
 */
import type { SpaceDescriptor } from "./protocol.js";

/** Mirrors the server's MAX_NOTE_CHARS / MAX_NOTES_PER_BOARD. */
export const NOTE_MAX_CHARS = 140;
export const BOARD_MAX_NOTES = 8;

/** The board opens within OPEN of the stand point and closes past CLOSE
 *  (world units) — hysteresis, so standing on the edge doesn't flicker it. */
export const BOARD_OPEN_R = 60;
export const BOARD_CLOSE_R = 80;

export interface BoardGeometry {
  /** The board on the top wall, world units. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where a reader stands: just below the board, clear of it. */
  standX: number;
  standY: number;
}

/**
 * The lobby hangs it in the gap between the Focus and Meeting rugs. A team
 * room hangs it towards the left: its spawn spiral reaches the middle of the
 * top wall, and arriving in a room should not open its board.
 */
export function boardGeometry(space: SpaceDescriptor): BoardGeometry {
  const { width: W, height: H } = space;
  const cx = (space.kind === "team" ? 0.2 : 0.5) * W;
  const w = 0.12 * W;
  return { x: cx - w / 2, y: 0.02 * H, w, h: 0.06 * H, standX: cx, standY: 0.16 * H };
}

export function boardOpen(wasOpen: boolean, dist: number): boolean {
  return dist <= (wasOpen ? BOARD_CLOSE_R : BOARD_OPEN_R);
}
