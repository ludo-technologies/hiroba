/**
 * deeplink.ts — hiroba:// deep links (Tauri deep-link plugin).
 *
 * Once an invitee has signed in on the invite page, its "open in Hiroba"
 * button points at `hiroba://auth/<code>`, a single-use handoff for the
 * session minted there. Two delivery paths funnel into one callback:
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
import { extractInviteCode, isTauri, parseAuthDeepLink } from "./auth.js";

const LS_WEB_INVITE = "hiroba_web_invite";

/** The invite a browser tab was opened with (`?invite=<token or link>`), or
 *  `""`. Always `""` under Tauri, where invites arrive as deep links.
 *  The installed app opens at the manifest's start_url, which carries none, so
 *  the last invite this browser was opened with is kept for it. */
export function inviteFromLocation(): string {
  if (isTauri()) return "";
  const raw = new URLSearchParams(window.location.search).get("invite");
  if (raw === null) {
    const installed = window.matchMedia("(display-mode: standalone)").matches;
    return installed ? (localStorage.getItem(LS_WEB_INVITE) ?? "") : "";
  }
  const code = extractInviteCode(raw);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(code)) return "";
  localStorage.setItem(LS_WEB_INVITE, code);
  return code;
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

/** Start listening; `onHandoff` fires with the bare code for each auth link. */
export function startDeepLinkListener(onHandoff: (code: string) => void): void {
  if (!isTauri()) return;
  const handle = (urls: string[] | null) => {
    for (const url of urls ?? []) {
      const code = parseAuthDeepLink(url);
      if (code) onHandoff(code);
    }
  };
  // onOpenUrl never replays the launch URL, so both calls together see each
  // link exactly once.
  getCurrent().then(handle).catch((e) => console.warn("[deeplink] getCurrent failed:", e));
  onOpenUrl(handle).catch((e) => console.warn("[deeplink] listen failed:", e));
}
