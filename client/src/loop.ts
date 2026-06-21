/**
 * loop.ts — Pure decisions for the demand-driven render loop.
 *
 * These two predicates are the heart of the "rich when alive, ~0% CPU when
 * idle" behaviour (NFR-01). They are pulled out of main.ts as pure functions so
 * the exact wake/draw rules are unit-testable without a browser — they are the
 * site of a real regression (the self speaking ring not animating while live)
 * and deserve a guard. See tests/loop.test.mjs.
 */

/**
 * Should the loop repaint this frame? The expensive canvas work runs ONLY when
 * something visually changed: local movement, live voice, an animation still in
 * flight, or a one-shot `dirty` event (join/leave/mute/resize).
 */
export function shouldDraw(
  moving: boolean,
  audioActive: boolean,
  wasAnimating: boolean,
  dirty: boolean,
): boolean {
  return moving || audioActive || wasAnimating || dirty;
}

/**
 * Should the loop schedule another frame, or sleep?
 *
 * Stay awake while: moving, voices are live, an animation is settling, any peer
 * is connected (so a peer who starts talking is noticed), OR our own mic is live
 * (so the self speaking ring animates — including when alone, which was the
 * regression). Muted + still + no peers — the all-day resting state — sleeps.
 */
export function shouldKeepAwake(
  moving: boolean,
  audioActive: boolean,
  wasAnimating: boolean,
  hasConnections: boolean,
  muted: boolean,
): boolean {
  return moving || audioActive || wasAnimating || hasConnections || !muted;
}
