/**
 * background-tick.ts — Worker that paces the camera background effect.
 *
 * A worker's timer keeps firing while the window is hidden or covered, when
 * the page's own timers are throttled and animation frames stop; the effect
 * renders on each tick so the call never freezes on the other end.
 */

/** A camera's usual frame rate. */
const FPS = 30;

setInterval(() => (self as unknown as Worker).postMessage(null), 1000 / FPS);
