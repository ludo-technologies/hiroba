/**
 * videolayout.ts — Where each live video goes in the video panel.
 *
 * Pure so the rules are unit-testable without a browser (tests/videolayout.test.mjs):
 *  - The stage (the large view) holds the video the user picked; otherwise a
 *    screen share, a peer's before our own; otherwise the only peer's camera,
 *    or our own when no peer's is up.
 *  - With no stage — two or more peers on camera and nobody sharing — every
 *    video goes into a grid.
 *  - Beside a stage, a single other video sits in the corner picture-in-picture
 *    (the 1:1 call layout), several sit in a strip under it.
 */

export interface LaidOutVideo {
  /** Peer id, or LOCAL_VIDEO for our own. */
  key: string;
  local: boolean;
  /** Null for the brief window before a peer's "video-mode" label arrives. */
  mode: "screen" | "camera" | null;
}

export const LOCAL_VIDEO = "local";

export interface VideoLayout<T> {
  stage: T | null;
  pip: T | null;
  /** The grid when there is no stage, else the strip under it. */
  tiles: T[];
}

export function layoutVideos<T extends LaidOutVideo>(videos: readonly T[], picked: string | null): VideoLayout<T> {
  const remote = videos.filter((v) => !v.local);
  const local = videos.find((v) => v.local) ?? null;
  const stage =
    videos.find((v) => v.key === picked) ??
    remote.find((v) => v.mode === "screen") ??
    (local?.mode === "screen" ? local : undefined) ??
    (remote.length <= 1 ? (remote[0] ?? local) : null);
  if (!stage) return { stage: null, pip: null, tiles: [...videos] };
  const rest = videos.filter((v) => v !== stage);
  if (rest.length === 1) return { stage, pip: rest[0], tiles: [] };
  return { stage, pip: null, tiles: rest };
}
