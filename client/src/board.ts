/**
 * The bulletin board: where it hangs in a space. Pure geometry — the renderer
 * draws it and hit-tests it; clicking it opens the space's chat.
 */
import type { SpaceDescriptor } from "./protocol.js";

/** Mirrors the server's MAX_NOTE_CHARS. */
export const NOTE_MAX_CHARS = 500;

export interface BoardGeometry {
  /** The board on the top wall, world units. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The lobby hangs it in the gap between the Focus and Meeting rugs, a team
 * room towards the left of its top wall.
 */
export function boardGeometry(space: SpaceDescriptor): BoardGeometry {
  const { width: W, height: H } = space;
  const cx = (space.kind === "team" ? 0.2 : 0.5) * W;
  const w = 0.12 * W;
  return { x: cx - w / 2, y: 0.02 * H, w, h: 0.06 * H };
}
