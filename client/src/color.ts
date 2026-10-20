/**
 * color.ts — small #RRGGBB helpers shared by the renderer, the join form and
 * the preset avatars.
 */

/** Parse #RRGGBB into [r,g,b]; falls back to a warm clay on malformed input. */
export function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [181, 79, 44];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Lighten a color toward white by `amount` (0..1) — for the token highlight. */
export function lighten(hex: string, amount: number): string {
  const [r, g, b] = parseHex(hex);
  const k = clamp01(amount);
  return toHex(r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k);
}

/** Scale a color's channels by `k` (<1 darkens) — for sides and shoulders. */
export function shade(hex: string, k: number): string {
  const [r, g, b] = parseHex(hex);
  return toHex(r * k, g * k, b * k);
}

/** Blend two hex colours in RGB. */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const k = clamp01(t);
  return toHex(ar + (br - ar) * k, ag + (bg - ag) * k, ab + (bb - ab) * k);
}

/** Multiply two colours channel-wise (a tint over a material). */
export function mulHex(a: string, tint: string): string {
  const [ar, ag, ab] = parseHex(a);
  const [tr, tg, tb] = parseHex(tint);
  return toHex((ar * tr) / 255, (ag * tg) / 255, (ab * tb) / 255);
}

/** Perceived brightness 0..1 (sRGB approximation). */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Choose black or white ink for legibility on a given background colour. */
export function pickInk(hex: string): string {
  return luminance(hex) > 0.6 ? "rgba(40,30,18,0.95)" : "rgba(255,255,255,0.96)";
}
