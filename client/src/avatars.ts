/**
 * avatars.ts — the built-in avatar presets and the avatar encoding pipeline.
 *
 * A preset is a small flat-illustration face drawn as SVG from a few parts
 * (hair style, skin, accessories) and tinted by the member's colour: the
 * shirt and backdrop take the colour, so the swatch choice stays meaningful.
 * Presets are rasterized through the same centre-crop + downscale + encode
 * path as an uploaded photo, so what leaves the client is always the same
 * small `data:image/(webp|jpeg);base64,` URL the server validates.
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

const SKIN = {
  light: "#f6d7bd",
  tan: "#e2b48c",
  olive: "#c9956a",
  brown: "#9c6b45",
  deep: "#6b4530",
} as const;

const HAIR = {
  black: "#2b2220",
  brown: "#5a3a26",
  chestnut: "#8a5230",
  blonde: "#d9b36b",
  red: "#b7552b",
  grey: "#9a948c",
} as const;

// Head: ellipse cx50 cy46 rx20 ry22 in a 100×100 box; hairline ≈ y30.
const HAIR_SHAPES = {
  short: (c: string) =>
    `<path fill="${c}" d="M29 46 C27 26 40 20 50 21 C62 21 73 27 71 46 C70 38 64 33 56 33 C52 33 49 35 45 35 C38 35 31 38 29 46Z"/>`,
  bob: (c: string) =>
    `<path fill="${c}" d="M27 60 C24 36 36 20 50 20 C64 20 76 36 73 60 L69 60 C70 46 66 36 58 34 C52 33 48 36 44 36 C36 37 31 46 31 60Z"/>`,
  long: (c: string) =>
    `<path fill="${c}" d="M25 80 C22 50 30 22 50 21 C70 22 78 50 75 80 L66 80 C67 56 65 40 57 35 C52 33 49 35 44 36 C35 40 33 56 34 80Z"/>`,
  bun: (c: string) =>
    `<circle cx="50" cy="20" r="9" fill="${c}"/><path fill="${c}" d="M29 46 C28 30 38 23 50 23 C62 23 72 30 71 46 C69 38 62 34 54 34 C50 34 48 36 44 36 C37 36 31 39 29 46Z"/>`,
  curly: (c: string) =>
    `<path fill="${c}" d="M24 44 C20 30 30 16 44 15 C50 11 60 12 64 17 C76 18 82 32 76 44 C80 50 74 56 70 52 C72 44 66 34 56 33 C50 33 47 35 43 35 C35 36 29 44 30 52 C25 56 20 50 24 44Z"/>`,
  side: (c: string) =>
    `<path fill="${c}" d="M29 48 C26 28 38 19 52 20 C66 21 73 30 71 46 C67 36 60 32 50 34 C44 35 38 32 36 30 C33 34 31 42 29 48Z"/>`,
  beanie: (c: string) =>
    `<path fill="${c}" d="M27 44 C27 26 38 17 50 17 C62 17 73 26 73 44 L27 44Z"/><rect x="27" y="38" width="46" height="8" rx="3" fill="${shade(c, 0.82)}"/><circle cx="50" cy="16" r="4" fill="${shade(c, 0.82)}"/>`,
  bald: () => "",
} as const;

const beard = (c: string) =>
  `<path fill="${c}" d="M31 50 C32 66 40 72 50 72 C60 72 68 66 69 50 C66 60 60 63 50 63 C40 63 34 60 31 50Z"/>`;
const GLASSES = `<g fill="none" stroke="${INK}" stroke-width="1.8" opacity=".85"><circle cx="41" cy="47" r="6.5"/><circle cx="59" cy="47" r="6.5"/><path d="M47.5 47h5M34.5 46l-4-2M65.5 46l4-2"/></g>`;
const EARRINGS = `<circle cx="30" cy="52" r="1.4" fill="#e6a94e"/><circle cx="70" cy="52" r="1.4" fill="#e6a94e"/>`;

interface Preset {
  /** Stable id persisted in localStorage; never renumber. */
  id: string;
  style: keyof typeof HAIR_SHAPES;
  skin: keyof typeof SKIN;
  hair: keyof typeof HAIR;
  eyes?: "happy";
  mouth?: "open";
  glasses?: boolean;
  earrings?: boolean;
  beard?: boolean;
}

/** Picker order. */
export const AVATAR_PRESETS: readonly Preset[] = [
  { id: "short", style: "short", skin: "light", hair: "brown" },
  { id: "bob", style: "bob", skin: "tan", hair: "black", earrings: true },
  { id: "curly", style: "curly", skin: "brown", hair: "black", mouth: "open" },
  { id: "long", style: "long", skin: "olive", hair: "chestnut", eyes: "happy" },
  { id: "bun", style: "bun", skin: "light", hair: "blonde", glasses: true },
  { id: "side", style: "side", skin: "deep", hair: "black" },
  { id: "beanie", style: "beanie", skin: "tan", hair: "red", eyes: "happy" },
  { id: "beard", style: "bald", skin: "olive", hair: "grey", beard: true, glasses: true },
];

export function isPresetId(id: string): boolean {
  return AVATAR_PRESETS.some((p) => p.id === id);
}

/** The preset's SVG markup, tinted by `color`. Sized by its container unless
 *  `size` is given (needed when decoding it as an <img>). */
export function presetSvg(id: string, color: string, size?: number): string {
  const p = AVATAR_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown avatar preset: ${id}`);
  const skin = SKIN[p.skin];
  const hair = HAIR[p.hair];
  const eyes =
    p.eyes === "happy"
      ? `<path d="M39 48 q3 -3 6 0 M55 48 q3 -3 6 0" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`
      : `<circle cx="42" cy="47" r="2.1" fill="${INK}"/><circle cx="58" cy="47" r="2.1" fill="${INK}"/>`;
  const mouth =
    p.mouth === "open"
      ? `<path d="M45 56 q5 5 10 0z" fill="#9a4a3c"/>`
      : `<path d="M45.5 56 q4.5 3.5 9 0" fill="none" stroke="${shade(skin, 0.6)}" stroke-width="1.7" stroke-linecap="round"/>`;
  const dims = size ? ` width="${size}" height="${size}"` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"${dims}>` +
    `<rect width="100" height="100" fill="${mixHex(color, PAPER, 0.72)}"/>` +
    `<path fill="${color}" d="M18 100 C18 82 30 73 50 73 C70 73 82 82 82 100Z"/>` +
    `<path fill="${shade(color, 0.8)}" d="M43 73 L50 82 L57 73Z" opacity=".55"/>` +
    `<rect x="44" y="58" width="12" height="18" rx="4" fill="${shade(skin, 0.88)}"/>` +
    `<circle cx="30" cy="48" r="4" fill="${skin}"/><circle cx="70" cy="48" r="4" fill="${skin}"/>` +
    `<ellipse cx="50" cy="46" rx="20" ry="22" fill="${skin}"/>` +
    (p.beard ? beard(hair) : "") +
    HAIR_SHAPES[p.style](hair) +
    `<ellipse cx="39" cy="54" rx="3.2" ry="1.8" fill="#e0707a" opacity=".3"/><ellipse cx="61" cy="54" rx="3.2" ry="1.8" fill="#e0707a" opacity=".3"/>` +
    eyes +
    mouth +
    (p.glasses ? GLASSES : "") +
    (p.earrings ? EARRINGS : "") +
    `</svg>`
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

/** A preset rendered in `color`, as the same data URL an upload produces. */
export async function encodePreset(id: string, color: string): Promise<string> {
  const svg = presetSvg(id, color, AVATAR_SIZE);
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  return encodeAvatar(img);
}
