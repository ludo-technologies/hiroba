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
 * (`inviteFromLocation`, the landing page's "join in browser" link), and a
 * web sign-in's outcome from the fragment (`webSignInFromLocation`).
 */

import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { extractInviteCode, isTauri, parseAuthDeepLink } from "./auth.js";

const LS_WEB_INVITE = "hiroba_web_invite";
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/** The invite a browser tab was opened with (`?invite=<token or link>`), or
 *  `""`. Always `""` under Tauri, where invites arrive as deep links. Kept for
 *  {@link installedAppInvite}, unless the link names a page to go back to
 *  (`?return=`, the landing page's demo button): an app installed during a
 *  demo opens at sign-in, not in the demo office. */
export function inviteFromLocation(): string {
  if (isTauri()) return "";
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("invite");
  if (raw === null) return "";
  const code = extractInviteCode(raw);
  if (!TOKEN_SHAPE.test(code)) return "";
  if (!params.has("return")) localStorage.setItem(LS_WEB_INVITE, code);
  return code;
}

/** The installed app (home screen) opens at the manifest's start_url, which
 *  carries no invite: it gets the last one this browser was opened with, or
 *  `""` outside the installed app. */
export function installedAppInvite(): string {
  if (isTauri() || !window.matchMedia("(display-mode: standalone)").matches) return "";
  return localStorage.getItem(LS_WEB_INVITE) ?? "";
}

/** What a web sign-in brought back to the browser build (auth `/callback`,
 *  or the joined page's "continue in the browser"). */
export type WebSignInReturn =
  | { kind: "handoff"; code: string }
  | { kind: "setup"; token: string };

/** Read `#handoff=<code>` or `#setup=<provisional token>` once, and wipe it
 *  from the address bar so a reload, a bookmark or a shared URL never carries
 *  it again. `null` when the page came back with neither. */
export function webSignInFromLocation(): WebSignInReturn | null {
  if (isTauri()) return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const code = params.get("handoff");
  const token = params.get("setup");
  if (code === null && token === null) return null;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  if (code !== null) return TOKEN_SHAPE.test(code) ? { kind: "handoff", code } : null;
  return token ? { kind: "setup", token } : null;
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
