/**
 * avatars.ts — the built-in avatar and the avatar encoding pipeline.
 *
 * A built-in avatar is a small flat-illustration face drawn as SVG from a
 * look: one choice per part (hair, skin, eyes, …). It is tinted by the
 * member's colour: the outfit and backdrop take the colour, so the swatch
 * choice stays meaningful. A look is rasterized through the same centre-crop
 * + downscale + encode path as an uploaded photo, so what leaves the client
 * is always the same small `data:image/(webp|jpeg);base64,` URL the server
 * validates.
 */

import { mixHex, shade } from "./color.js";

/** Side length an avatar is centre-cropped + downscaled to. Well above the
 *  canvas token (~40px) so it stays crisp on HiDPI and when zoomed. */
export const AVATAR_SIZE = 256;

/** Hard cap on the encoded data URL — matches the server gate
 *  (state.rs MAX_AVATAR_LEN) so an avatar we accept is never silently dropped. */
export const AVATAR_MAX_CHARS = 64 * 1024;

const INK = "#3a2e20";
const PAPER = "#fbf5ea";

export const SKIN = {
  light: "#f6d7bd",
  tan: "#e2b48c",
  olive: "#c9956a",
  brown: "#9c6b45",
  deep: "#6b4530",
} as const;

export const HAIR = {
  black: "#2b2220",
  brown: "#5a3a26",
  chestnut: "#8a5230",
  blonde: "#d9b36b",
  red: "#b7552b",
  grey: "#9a948c",
  pink: "#e08aa8",
  blue: "#4f86c6",
  purple: "#8a6bbf",
  teal: "#3f9c94",
} as const;

/** A part's path data. Everything is drawn in a 100×100 box around a head
 *  that is the ellipse cx50 cy46 rx20 ry22 (hairline ≈ y30). */
interface HairShape {
  /** Behind the head: a ponytail, bunches. */
  back?: string;
  front?: string;
  /** Over `front`, a shade darker: the beanie's band and bobble. */
  accent?: string;
  opacity?: number;
}

const STYLE: Record<string, HairShape> = {
  short: { front: "M29 46 C27 26 40 20 50 21 C62 21 73 27 71 46 C70 38 64 33 56 33 C52 33 49 35 45 35 C38 35 31 38 29 46Z" },
  side: { front: "M29 48 C26 28 38 19 52 20 C66 21 73 30 71 46 C67 36 60 32 50 34 C44 35 38 32 36 30 C33 34 31 42 29 48Z" },
  buzz: { front: "M30 42 C30 29 39 23 50 23 C61 23 70 29 70 42 C68 34 61 29.5 50 29.5 C39 29.5 32 34 30 42Z", opacity: 0.8 },
  spiky: { front: "M29 46 C28 38 29 32 32 28 L32 20 L39 24 L42 15 L49 22 L55 14 L59 22 L67 18 L67 27 C71 32 72 38 71 46 C69 39 64 34 57 33 C52 33 48 35 44 35 C37 35 31 39 29 46Z" },
  curly: { front: "M24 44 C20 30 30 16 44 15 C50 11 60 12 64 17 C76 18 82 32 76 44 C80 50 74 56 70 52 C72 44 66 34 56 33 C50 33 47 35 43 35 C35 36 29 44 30 52 C25 56 20 50 24 44Z" },
  afro: { front: "M22 50 C14 34 26 10 50 10 C74 10 86 34 78 50 C77 56 72 58 70 54 C72 42 65 33 56 33 C52 33 48 35 44 35 C35 36 28 44 30 54 C28 58 23 56 22 50Z" },
  bob: { front: "M27 60 C24 36 36 20 50 20 C64 20 76 36 73 60 L69 60 C70 46 66 36 58 34 C52 33 48 36 44 36 C36 37 31 46 31 60Z" },
  fringe: { front: "M26 72 C22 44 30 20 50 20 C70 20 78 44 74 72 L67 72 C68.5 60 68.5 50 67 38 Q50 35 33 38 C31.5 50 31.5 60 33 72Z" },
  parted: { front: "M27 64 C23 40 32 20 50 20 C68 20 77 40 73 64 L68 64 C70 50 66 38 50 27 C34 38 30 50 32 64Z" },
  long: { front: "M25 80 C22 50 30 22 50 21 C70 22 78 50 75 80 L66 80 C67 56 65 40 57 35 C52 33 49 35 44 36 C35 40 33 56 34 80Z" },
  wavy: { front: "M24 82 C20 70 27 64 23 54 C19 38 30 20 50 20 C70 20 81 38 77 54 C73 64 80 70 76 82 L66 82 C70 72 64 66 67 56 C69 44 64 36 56 34 C52 33 48 35 44 36 C36 38 31 46 33 56 C36 66 30 72 34 82Z" },
  ponytail: {
    back: "M66 28 C80 22 90 36 85 52 C83 60 78 64 74 61 C79 53 78 43 69 40Z",
    front: "M29 46 C27 28 39 20 50 20 C62 20 73 28 71 46 C69 37 62 31 50 31 C38 31 31 37 29 46Z",
  },
  twin: {
    back: "M31 50 C20 52 17 66 21 77 C25 82 33 77 33 69 C31 61 33 55 31 50Z M69 50 C80 52 83 66 79 77 C75 82 67 77 67 69 C69 61 67 55 69 50Z",
    front: "M29 47 C27 28 39 20 50 20 C61 20 73 28 71 47 C69 38 62 31 50 27 C38 31 31 38 29 47Z",
  },
  bun: { front: "M41 20a9 9 0 1 0 18 0a9 9 0 1 0-18 0Z M29 46 C28 30 38 23 50 23 C62 23 72 30 71 46 C69 38 62 34 54 34 C50 34 48 36 44 36 C37 36 31 39 29 46Z" },
  beanie: {
    front: "M27 44 C27 26 38 17 50 17 C62 17 73 26 73 44 L27 44Z",
    accent: "M30 38h40a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3h-40a3 3 0 0 1-3-3v-2a3 3 0 0 1 3-3Z M46 16a4 4 0 1 0 8 0a4 4 0 1 0-8 0Z",
  },
  bald: {},
};

/** `dots` are zero-length strokes with round caps; `lines` are thin strokes. */
const EYES: Record<string, { dots?: string; lines?: string }> = {
  dot: { dots: "M42 47h.01M58 47h.01" },
  happy: { lines: "M39 48q3-3 6 0M55 48q3-3 6 0" },
  wink: { dots: "M42 47h.01", lines: "M55 48q3-3 6 0" },
  calm: { lines: "M39 46.5q3 3 6 0M55 46.5q3 3 6 0" },
};

const MOUTH: Record<string, { line?: string; fill?: string; teeth?: string }> = {
  smile: { line: "M45.5 56q4.5 3.5 9 0" },
  open: { fill: "M45 56q5 5 10 0z" },
  grin: { fill: "M43.5 55.5q6.5 7 13 0z", teeth: "M45 55.8h10l-1 1.7h-8z" },
  flat: { line: "M46 57.5h8" },
};

const FACIAL: Record<string, string> = {
  none: "",
  beard: "M31 50 C32 66 40 72 50 72 C60 72 68 66 69 50 C66 60 60 63 50 63 C40 63 34 60 31 50Z",
  moustache: "M42 53.6 C44 51 48 51.4 50 53 C52 51.4 56 51 58 53.6 C55 55 52 54.6 50 54.1 C48 54.6 45 55 42 53.6Z",
};

const LENSES = "M34.5 47a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0Z M52.5 47a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0Z";
const GLASSES: Record<string, { line?: string; fill?: string }> = {
  none: {},
  round: { line: `${LENSES} M47.5 47h5M34.5 46l-4-2M65.5 46l4-2` },
  square: { line: "M36 41.5h10a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-6.5a2 2 0 0 1 2-2Z M54 41.5h10a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-6.5a2 2 0 0 1 2-2Z M48 45.5h4M34 45l-4-1.5M66 45l4-1.5" },
  shades: { fill: LENSES, line: "M47.5 46h5M34.5 46l-4-2M65.5 46l4-2" },
};

/** `hood` sits behind the head and is drawn with it; `trim` lies on the body. */
const OUTFIT: Record<string, { hood?: string; trim: string }> = {
  tee: { trim: "M43 73 L50 82 L57 73Z" },
  collar: { trim: "M40 72.5 L50 81 L44.5 88Z M60 72.5 L50 81 L55.5 88Z" },
  hoodie: { hood: "M29 80 C28 62 38 57 50 57 C62 57 72 62 71 80Z", trim: "M45.4 77h1.6v9h-1.6Z M53 77h1.6v9h-1.6Z" },
};

/** One choice per part. Persisted in localStorage as JSON, so a key never
 *  changes meaning. */
export interface Look {
  skin: string;
  style: string;
  hair: string;
  eyes: string;
  mouth: string;
  facial: string;
  glasses: string;
  outfit: string;
  earrings: boolean;
  freckles: boolean;
}

/** The parts with named options, and what each offers, in picker order. */
export const AVATAR_OPTIONS = {
  skin: Object.keys(SKIN),
  style: Object.keys(STYLE),
  hair: Object.keys(HAIR),
  eyes: Object.keys(EYES),
  mouth: Object.keys(MOUTH),
  facial: Object.keys(FACIAL),
  glasses: Object.keys(GLASSES),
  outfit: Object.keys(OUTFIT),
} as const;

export type AvatarPart = keyof typeof AVATAR_OPTIONS;

const PLAIN: Look = {
  skin: "light",
  style: "short",
  hair: "brown",
  eyes: "dot",
  mouth: "smile",
  facial: "none",
  glasses: "none",
  outfit: "tee",
  earrings: false,
  freckles: false,
};

/** Ready-made looks, keyed by the preset id older versions persisted. */
const PRESETS: Record<string, Look> = {
  short: PLAIN,
  bob: { ...PLAIN, style: "bob", skin: "tan", hair: "black", earrings: true },
  curly: { ...PLAIN, style: "curly", skin: "brown", hair: "black", mouth: "open" },
  long: { ...PLAIN, style: "long", skin: "olive", hair: "chestnut", eyes: "happy" },
  bun: { ...PLAIN, style: "bun", hair: "blonde", glasses: "round" },
  side: { ...PLAIN, style: "side", skin: "deep", hair: "black" },
  beanie: { ...PLAIN, style: "beanie", skin: "tan", hair: "red", eyes: "happy" },
  beard: { ...PLAIN, style: "bald", skin: "olive", hair: "grey", facial: "beard", glasses: "round" },
};

/** Picker order. */
export const AVATAR_PRESETS: readonly Look[] = Object.values(PRESETS);

/** The look a preset id from an older version stood for, if it is one. */
export function presetLook(id: string): Look | null {
  return Object.prototype.hasOwnProperty.call(PRESETS, id) ? PRESETS[id] : null;
}

export function sameLook(a: Look, b: Look): boolean {
  return (Object.keys(PLAIN) as (keyof Look)[]).every((k) => a[k] === b[k]);
}

/** A look read back from storage: null unless every part names an option
 *  this version draws. */
export function parseLook(json: string): Look | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const look = { ...PLAIN };
  for (const part of Object.keys(AVATAR_OPTIONS) as AvatarPart[]) {
    const choice = o[part];
    if (typeof choice !== "string" || !AVATAR_OPTIONS[part].includes(choice)) return null;
    look[part] = choice;
  }
  if (typeof o.earrings !== "boolean" || typeof o.freckles !== "boolean") return null;
  look.earrings = o.earrings;
  look.freckles = o.freckles;
  return look;
}

export function randomLook(): Look {
  const pick = (xs: readonly string[]) => xs[Math.floor(Math.random() * xs.length)];
  const o = AVATAR_OPTIONS;
  return {
    skin: pick(o.skin),
    style: pick(o.style),
    hair: pick(o.hair),
    eyes: pick(o.eyes),
    mouth: pick(o.mouth),
    // Most faces wear neither, so a draw doesn't look like a costume box.
    facial: Math.random() < 0.8 ? "none" : pick(o.facial),
    glasses: Math.random() < 0.65 ? "none" : pick(o.glasses),
    outfit: pick(o.outfit),
    earrings: Math.random() < 0.25,
    freckles: Math.random() < 0.2,
  };
}

// The head is drawn larger than the box it was designed in, so that faces
// tell apart at token size; the body slides down to stay under the chin.
const HEAD = `transform="translate(-17.5 -16.8) scale(1.35)"`;
const BODY = `transform="translate(0 7)"`;

/** The look's SVG markup, tinted by `color`. Sized by its container unless
 *  `size` is given (needed when decoding it as an <img>). */
export function lookSvg(look: Look, color: string, size?: number): string {
  const skin = SKIN[look.skin as keyof typeof SKIN];
  const hair = HAIR[look.hair as keyof typeof HAIR];
  const style = STYLE[look.style];
  const eyes = EYES[look.eyes];
  const mouth = MOUTH[look.mouth];
  const glasses = GLASSES[look.glasses];
  const outfit = OUTFIT[look.outfit];
  const dark = shade(color, 0.8);
  const path = (d: string | undefined, attrs: string) => (d ? `<path d="${d}" ${attrs}/>` : "");
  const dims = size ? ` width="${size}" height="${size}"` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"${dims}>` +
    `<rect width="100" height="100" fill="${mixHex(color, PAPER, 0.72)}"/>` +
    `<g ${HEAD}>` +
    path(style.back, `fill="${hair}"`) +
    path(outfit.hood, `fill="${dark}"`) +
    `</g><g ${BODY}>` +
    `<path fill="${color}" d="M18 100 C18 82 30 73 50 73 C70 73 82 82 82 100Z"/>` +
    path(outfit.trim, `fill="${dark}" opacity=".55"`) +
    `</g><g ${HEAD}>` +
    `<rect x="44" y="58" width="12" height="18" rx="4" fill="${shade(skin, 0.88)}"/>` +
    `<circle cx="30" cy="48" r="4" fill="${skin}"/><circle cx="70" cy="48" r="4" fill="${skin}"/>` +
    `<ellipse cx="50" cy="46" rx="20" ry="22" fill="${skin}"/>` +
    path(FACIAL[look.facial], `fill="${hair}"`) +
    path(style.front, `fill="${hair}" opacity="${style.opacity ?? 1}"`) +
    path(style.accent, `fill="${shade(hair, 0.82)}"`) +
    `<ellipse cx="39" cy="54" rx="3.2" ry="1.8" fill="#e0707a" opacity=".3"/><ellipse cx="61" cy="54" rx="3.2" ry="1.8" fill="#e0707a" opacity=".3"/>` +
    (look.freckles
      ? `<path d="M37 51.5h.01M40 53h.01M35.6 53.6h.01M63 51.5h.01M60 53h.01M64.4 53.6h.01" stroke="${shade(skin, 0.72)}" stroke-width="1.2" stroke-linecap="round"/>`
      : "") +
    path(eyes.dots, `stroke="${INK}" stroke-width="4.2" stroke-linecap="round"`) +
    path(eyes.lines, `fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"`) +
    path(mouth.fill, `fill="#9a4a3c"`) +
    path(mouth.teeth, `fill="#fff"`) +
    path(mouth.line, `fill="none" stroke="${shade(skin, 0.6)}" stroke-width="1.7" stroke-linecap="round"`) +
    path(glasses.fill, `fill="${INK}" opacity=".85"`) +
    path(glasses.line, `fill="none" stroke="${INK}" stroke-width="1.8" opacity=".85"`) +
    (look.earrings
      ? `<path d="M30 53h.01M70 53h.01" stroke="#e6a94e" stroke-width="2.8" stroke-linecap="round"/>`
      : "") +
    `</g></svg>`
  );
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = src;
  });
}

/**
 * Centre-crop + downscale a decoded image to a small square data URL.
 * WebP where the WebView can encode it, else JPEG (Safari/WKWebView's
 * toDataURL silently ignores unsupported types and returns PNG — the prefix
 * check catches that). Throws when the result can't fit the server gate.
 */
export function encodeAvatar(img: HTMLImageElement): string {
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (side === 0) throw new Error("empty image");
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  // Flatten transparency onto white (JPEG has no alpha channel).
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  // A phone photo down to 256² is a steep downscale; the default resampler
  // aliases badly, and this runs once per pick so quality is free here.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    img,
    (img.naturalWidth - side) / 2,
    (img.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_SIZE,
    AVATAR_SIZE,
  );
  // Step quality down until the data URL fits the 64 KB gate — a noisy
  // photo at 256² can overshoot at the first quality.
  let data = "";
  for (const q of [0.85, 0.72, 0.6]) {
    data = canvas.toDataURL("image/webp", q);
    if (!data.startsWith("data:image/webp")) data = canvas.toDataURL("image/jpeg", q);
    if (data.length <= AVATAR_MAX_CHARS) break;
  }
  if (data.length > AVATAR_MAX_CHARS) throw new Error("avatar too large");
  return data;
}

/** A look rendered in `color`, as the same data URL an upload produces. */
export async function encodeLook(look: Look, color: string): Promise<string> {
  const svg = lookSvg(look, color, AVATAR_SIZE);
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  return encodeAvatar(img);
}
