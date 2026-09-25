/**
 * deeplink.ts — hiroba:// deep links (Tauri deep-link plugin).
 *
 * The invite landing page's "open in app" button points at
 * `hiroba://invite/<token>`. Two delivery paths funnel into one callback:
 *
 *   - cold start: the OS launches the app with the URL; `getCurrent()`
 *     returns it once the webview is up.
 *   - already running: the deep-link plugin emits `deep-link://new-url`
 *     (`onOpenUrl`); on Windows/Linux the single-instance plugin forwards
 *     the second process's URL there first.
 *
 * Runs only under Tauri — a plain browser tab never receives scheme URLs; the
 * browser build takes its invite from the page URL instead
 * (`inviteFromLocation`, the landing page's "join in browser" link).
 */

import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { extractInviteCode, isTauri, parseInviteDeepLink } from "./auth.js";

/** The invite a browser tab was opened with (`?invite=<token or link>`), or
 *  `""`. Always `""` under Tauri, where invites arrive as deep links. */
export function inviteFromLocation(): string {
  if (isTauri()) return "";
  const raw = new URLSearchParams(window.location.search).get("invite") ?? "";
  const code = extractInviteCode(raw);
  return /^[A-Za-z0-9_-]{1,128}$/.test(code) ? code : "";
}

/** Where a browser guest goes after leaving (`?return=<path>`), or `""`.
 *  Same-origin only, so an invite link can't be turned into an open redirect. */
export function returnFromLocation(): string {
  if (isTauri()) return "";
  const raw = new URLSearchParams(window.location.search).get("return");
  if (!raw) return "";
  const url = new URL(raw, window.location.origin);
  return url.origin === window.location.origin ? url.href : "";
}

/** Start listening; `onInvite` fires with the bare token for each invite link. */
export function startDeepLinkListener(onInvite: (code: string) => void): void {
  if (!isTauri()) return;
  const handle = (urls: string[] | null) => {
    for (const url of urls ?? []) {
      const code = parseInviteDeepLink(url);
      if (code) onInvite(code);
    }
  };
  // onOpenUrl never replays the launch URL, so both calls together see each
  // link exactly once.
  getCurrent().then(handle).catch((e) => console.warn("[deeplink] getCurrent failed:", e));
  onOpenUrl(handle).catch((e) => console.warn("[deeplink] listen failed:", e));
}
